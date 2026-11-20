import { connect as connectTls, checkServerIdentity, type TLSSocket } from 'node:tls';
import { createConnection, isIP, type Socket } from 'node:net';
import { createInterface, type Interface } from 'node:readline';

export interface NutUps {
  name: string;
  description: string;
}

export class NutProtocolError extends Error {
  constructor(
    message: string,
    readonly code = 'PROTOCOL_ERROR',
  ) {
    super(message);
    this.name = 'NutProtocolError';
  }
}

export class NutConnection {
  private socket: Socket | TLSSocket;
  private lines!: Interface;
  private lineIterator!: AsyncIterator<string>;
  private socketError: Error | null = null;

  private constructor(
    socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.socket = socket;
    this.attachReader(socket);
  }

  static async connect(
    host: string,
    port: number,
    timeoutMs: number,
    options: { tls?: boolean; credentials?: { username: string; password: string } | null } = {},
  ): Promise<NutConnection> {
    const socket = createConnection({ host, port });
    await new Promise<void>((resolve, reject) => {
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
      if (options.tls) await connection.startTls(host);
      if (options.credentials) await connection.authenticate(options.credentials);
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async listUps(): Promise<NutUps[]> {
    const lines = await this.list('UPS');
    return lines.map(parseUpsLine);
  }

  async listVariables(upsName: string): Promise<Record<string, string>> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(upsName)) {
      throw new NutProtocolError('NUT returned an unsafe UPS name');
    }
    const lines = await this.list(`VAR ${upsName}`);
    const result: Record<string, string> = {};
    for (const line of lines) {
      const match = /^VAR (\S+) ([A-Za-z0-9_.-]+) ("(?:\\.|[^"\\])*")$/.exec(line);
      if (!match || match[1] !== upsName || !match[2] || !match[3]) {
        throw new NutProtocolError('NUT returned a malformed variable row');
      }
      result[match[2]] = parseQuotedValue(match[3]);
    }
    return result;
  }

  close(): void {
    this.lines.close();
    this.socket.destroy();
  }

  private async startTls(host: string): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) =>
        reject(new Error(`NUT TLS negotiation failed: ${error.message}`));
      tlsSocket.once('error', onError);
      tlsSocket.once('secureConnect', () => {
        tlsSocket.off('error', onError);
        resolve();
      });
    });
    this.socket = tlsSocket;
    this.attachReader(tlsSocket);
  }

  private async authenticate(credentials: { username: string; password: string }): Promise<void> {
    this.socket.write(`USERNAME ${encodeArgument(credentials.username)}\n`);
    await this.expectOk('USERNAME');
    this.socket.write(`PASSWORD ${encodeArgument(credentials.password)}\n`);
    await this.expectOk('PASSWORD');
  }

  private async expectOk(command: string): Promise<void> {
    const response = await this.readLine();
    if (response !== 'OK' && !response.startsWith('OK ')) {
      throw new NutProtocolError(`NUT rejected ${command}`, 'AUTH_FAILED');
    }
  }

  private attachReader(socket: Socket | TLSSocket): void {
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('NUT request timed out')));
    socket.on('error', (error: Error) => {
      this.socketError = error;
    });
    this.lines = createInterface({ input: socket, crlfDelay: Infinity });
    this.lineIterator = this.lines[Symbol.asyncIterator]();
  }

  private async list(query: string): Promise<string[]> {
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

    const result: string[] = [];
    while (result.length <= 100_000) {
      const line = await this.readLine();
      if (line === expectedEnd) return result;
      if (line.length > 16_384) throw new NutProtocolError('NUT response line is too long');
      result.push(line);
    }
    throw new NutProtocolError('NUT list exceeded the row limit');
  }

  private async readLine(): Promise<string> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.lineIterator.next(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('NUT response timed out')), this.timeoutMs);
        }),
      ]);
      if (result.done) throw this.socketError ?? new Error('NUT closed the connection');
      return result.value;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function encodeArgument(value: string): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new NutProtocolError('NUT credentials contain unsupported characters', 'AUTH_INVALID');
  }
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function parseUpsLine(line: string): NutUps {
  const match = /^UPS (\S{1,128}) ("(?:\\.|[^"\\])*")$/.exec(line);
  if (!match || !match[1] || !match[2])
    throw new NutProtocolError('NUT returned a malformed UPS row');
  if (!/^[A-Za-z0-9_.:-]+$/.test(match[1])) {
    throw new NutProtocolError('NUT returned an unsafe UPS name');
  }
  return { name: match[1], description: parseQuotedValue(match[2]) };
}

function parseQuotedValue(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
    throw new NutProtocolError('NUT returned a malformed quoted value');
  }
  let result = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === '\\') {
      index += 1;
      const escaped = value[index];
      if (escaped === undefined) throw new NutProtocolError('NUT returned an invalid escape');
      result += escaped;
    } else if (character === '"') {
      throw new NutProtocolError('NUT returned an unescaped quote');
    } else {
      result += character;
    }
  }
  return result;
}
