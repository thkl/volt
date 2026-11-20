import { connect as connectTls, checkServerIdentity } from 'node:tls';
import { createConnection, isIP } from 'node:net';
import { createInterface } from 'node:readline';
export class NutProtocolError extends Error {
    code;
    constructor(message, code = 'PROTOCOL_ERROR') {
        super(message);
        this.code = code;
        this.name = 'NutProtocolError';
    }
}
export class NutConnection {
    timeoutMs;
    socket;
    lines;
    lineIterator;
    socketError = null;
    constructor(socket, timeoutMs) {
        this.timeoutMs = timeoutMs;
        this.socket = socket;
        this.attachReader(socket);
    }
    static async connect(host, port, timeoutMs, options = {}) {
        const socket = createConnection({ host, port });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error('NUT connection timed out'));
            }, timeoutMs);
            socket.once('connect', () => {
                clearTimeout(timeout);
                resolve();
            });
            socket.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
        const connection = new NutConnection(socket, timeoutMs);
        try {
            if (options.tls)
                await connection.startTls(host);
            if (options.credentials)
                await connection.authenticate(options.credentials);
            return connection;
        }
        catch (error) {
            connection.close();
            throw error;
        }
    }
    async listUps() {
        const lines = await this.list('UPS');
        return lines.map(parseUpsLine);
    }
    async listVariables(upsName) {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(upsName)) {
            throw new NutProtocolError('NUT returned an unsafe UPS name');
        }
        const lines = await this.list(`VAR ${upsName}`);
        const result = {};
        for (const line of lines) {
            const match = /^VAR (\S+) ([A-Za-z0-9_.-]+) ("(?:\\.|[^"\\])*")$/.exec(line);
            if (!match || match[1] !== upsName || !match[2] || !match[3]) {
                throw new NutProtocolError('NUT returned a malformed variable row');
            }
            result[match[2]] = parseQuotedValue(match[3]);
        }
        return result;
    }
    close() {
        this.lines.close();
        this.socket.destroy();
    }
    async startTls(host) {
        this.socket.write('STARTTLS\n');
        const response = await this.readLine();
        if (response !== 'OK STARTTLS') {
            throw new NutProtocolError('NUT server did not accept STARTTLS');
        }
        this.lines.close();
        this.socket.setEncoding();
        const tlsSocket = connectTls({
            socket: this.socket,
            rejectUnauthorized: true,
            ...(isIP(host) === 0 ? { servername: host } : {}),
            checkServerIdentity: (_serverName, certificate) => checkServerIdentity(host, certificate),
        });
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(new Error(`NUT TLS negotiation failed: ${error.message}`));
            tlsSocket.once('error', onError);
            tlsSocket.once('secureConnect', () => {
                tlsSocket.off('error', onError);
                resolve();
            });
        });
        this.socket = tlsSocket;
        this.attachReader(tlsSocket);
    }
    async authenticate(credentials) {
        this.socket.write(`USERNAME ${encodeArgument(credentials.username)}\n`);
        await this.expectOk('USERNAME');
        this.socket.write(`PASSWORD ${encodeArgument(credentials.password)}\n`);
        await this.expectOk('PASSWORD');
    }
    async expectOk(command) {
        const response = await this.readLine();
        if (response !== 'OK' && !response.startsWith('OK ')) {
            throw new NutProtocolError(`NUT rejected ${command}`, 'AUTH_FAILED');
        }
    }
    attachReader(socket) {
        socket.setEncoding('utf8');
        socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('NUT request timed out')));
        socket.on('error', (error) => {
            this.socketError = error;
        });
        this.lines = createInterface({ input: socket, crlfDelay: Infinity });
        this.lineIterator = this.lines[Symbol.asyncIterator]();
    }
    async list(query) {
        const expectedStart = `BEGIN LIST ${query}`;
        const expectedEnd = `END LIST ${query}`;
        this.socket.write(`LIST ${query}\n`);
        const firstLine = await this.readLine();
        if (firstLine.startsWith('ERR ')) {
            const code = firstLine.slice(4).trim().split(/\s+/, 1)[0] ?? 'SERVER_ERROR';
            throw new NutProtocolError(`NUT rejected LIST ${query}`, code);
        }
        if (firstLine !== expectedStart) {
            throw new NutProtocolError(`Expected "${expectedStart}" from NUT`);
        }
        const result = [];
        while (result.length <= 100_000) {
            const line = await this.readLine();
            if (line === expectedEnd)
                return result;
            if (line.length > 16_384)
                throw new NutProtocolError('NUT response line is too long');
            result.push(line);
        }
        throw new NutProtocolError('NUT list exceeded the row limit');
    }
    async readLine() {
        let timeout;
        try {
            const result = await Promise.race([
                this.lineIterator.next(),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('NUT response timed out')), this.timeoutMs);
                }),
            ]);
            if (result.done)
                throw this.socketError ?? new Error('NUT closed the connection');
            return result.value;
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
        }
    }
}
function encodeArgument(value) {
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new NutProtocolError('NUT credentials contain unsupported characters', 'AUTH_INVALID');
    }
    return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
function parseUpsLine(line) {
    const match = /^UPS (\S{1,128}) ("(?:\\.|[^"\\])*")$/.exec(line);
    if (!match || !match[1] || !match[2])
        throw new NutProtocolError('NUT returned a malformed UPS row');
    if (!/^[A-Za-z0-9_.:-]+$/.test(match[1])) {
        throw new NutProtocolError('NUT returned an unsafe UPS name');
    }
    return { name: match[1], description: parseQuotedValue(match[2]) };
}
function parseQuotedValue(value) {
    if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
        throw new NutProtocolError('NUT returned a malformed quoted value');
    }
    let result = '';
    for (let index = 1; index < value.length - 1; index += 1) {
        const character = value[index];
        if (character === '\\') {
            index += 1;
            const escaped = value[index];
            if (escaped === undefined)
                throw new NutProtocolError('NUT returned an invalid escape');
            result += escaped;
        }
        else if (character === '"') {
            throw new NutProtocolError('NUT returned an unescaped quote');
        }
        else {
            result += character;
        }
    }
    return result;
}
