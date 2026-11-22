import { DemoSource, DEMO_DEVICES } from '../demo/demo-source.js';
import { stableDeviceId } from '../domain/ids.js';
import { NutConnection, NutProtocolError } from '../nut/protocol.js';
import { normalizeUps } from '../nut/normalize.js';
export class DemoCollector {
    ingestion;
    pollIntervalMs;
    source;
    timer = null;
    isRunning = false;
    lastPollAt = null;
    devices;
    constructor(ingestion, pollIntervalMs, devices = DEMO_DEVICES) {
        this.ingestion = ingestion;
        this.pollIntervalMs = pollIntervalMs;
        this.devices = devices;
        this.source = new DemoSource(devices);
    }
    start() {
        if (this.timer)
            return;
        this.poll();
        this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
        this.timer.unref();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        this.isRunning = false;
    }
    health() {
        return {
            mode: 'demo',
            status: 'ready',
            connected: true,
            lastPollAt: this.lastPollAt,
            lastError: null,
            phase: 'ready',
            discoveredUps: this.devices.length,
            upsNames: this.devices.map((device) => device.name),
            lastDiscoveryAt: this.lastPollAt,
        };
    }
    selectScenario(value) {
        if (!this.source.selectScenario(value))
            return false;
        this.poll();
        return true;
    }
    poll() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        try {
            const now = Date.now();
            for (const snapshot of this.source.snapshots(now)) {
                const device = this.devices.find((candidate) => candidate.id === snapshot.deviceId);
                this.ingestion.ingest(snapshot, device?.name ?? snapshot.deviceName);
            }
            this.lastPollAt = new Date(now).toISOString();
        }
        finally {
            this.isRunning = false;
        }
    }
}
export class NutCollector {
    ingestion;
    config;
    hostId;
    credentials;
    timer = null;
    currentConnection = null;
    isRunning = false;
    connected = false;
    lastPollAt = null;
    lastError = null;
    nextDiscoveryAt = 0;
    failures = 0;
    stopped = false;
    phase = 'starting';
    lastDiscoveryAt = null;
    lastErrorCode = null;
    lastLoggedDiagnostic = null;
    knownUps = [];
    deviceFailures = new Map();
    constructor(ingestion, config, hostId = `${config.nutHost}:${config.nutPort}`, credentials = null) {
        this.ingestion = ingestion;
        this.config = config;
        this.hostId = hostId;
        this.credentials = credentials;
        if (!config.nutHost)
            throw new Error('NUT_HOST is required for the NUT collector');
    }
    start() {
        if (this.timer)
            return;
        this.stopped = false;
        void this.pollAndSchedule();
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.currentConnection?.close();
        this.currentConnection = null;
    }
    health() {
        return {
            mode: 'nut',
            status: this.connected && this.deviceFailures.size === 0 && this.knownUps.length > 0
                ? 'ready'
                : 'degraded',
            connected: this.connected,
            lastPollAt: this.lastPollAt,
            lastError: this.lastError,
            phase: this.phase,
            discoveredUps: this.knownUps.length,
            upsNames: this.knownUps.map((ups) => ups.name),
            lastDiscoveryAt: this.lastDiscoveryAt,
            lastErrorCode: this.lastErrorCode,
            consecutiveFailures: Math.max(this.failures, ...this.deviceFailures.values(), 0),
        };
    }
    async pollOnce(now = Date.now()) {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.phase = 'connecting';
        let connection = null;
        try {
            connection = await NutConnection.connect(this.config.nutHost, this.config.nutPort, this.config.requestTimeoutMs, { tls: this.config.nutTls, credentials: this.credentials });
            this.currentConnection = connection;
            this.connected = true;
            this.failures = 0;
            if (now >= this.nextDiscoveryAt || this.knownUps.length === 0) {
                this.phase = 'discovering';
                const discovered = await connection.listUps();
                this.updateDiscovery(discovered, new Date(now).toISOString());
                this.knownUps = discovered;
                this.lastDiscoveryAt = new Date(now).toISOString();
                this.nextDiscoveryAt = now + this.config.discoveryIntervalMs;
            }
            this.phase = 'reading';
            for (const ups of this.knownUps) {
                const id = stableDeviceId(this.hostId, ups.name);
                try {
                    const variables = await connection.listVariables(ups.name);
                    const snapshot = normalizeUps(this.hostId, ups, variables, new Date(now).toISOString());
                    this.deviceFailures.delete(id);
                    this.ingestion.ingest(snapshot, ups.description);
                }
                catch (error) {
                    const failures = (this.deviceFailures.get(id) ?? 0) + 1;
                    this.deviceFailures.set(id, failures);
                    const diagnostic = describeNutError(error);
                    this.reportDiagnostic(`Failed to read UPS "${ups.name}": ${diagnostic.message}`, diagnostic.code, 'reading');
                    if (failures >= 3) {
                        this.ingestion.markUnavailable(id, 'No successful variable list in three polls');
                    }
                }
            }
            this.lastPollAt = new Date(now).toISOString();
            if (this.deviceFailures.size === 0)
                this.connected = true;
            if (this.knownUps.length === 0) {
                this.reportDiagnostic('NUT responded to discovery, but LIST UPS returned no UPS devices', 'NO_UPS_DISCOVERED', 'discovering');
                this.phase = 'idle';
            }
            else if (this.deviceFailures.size === 0) {
                this.clearDiagnostic();
                this.phase = 'ready';
            }
            else {
                this.phase = 'error';
            }
        }
        catch (error) {
            this.connected = false;
            this.failures += 1;
            const diagnostic = describeNutError(error);
            this.reportDiagnostic(diagnostic.message, diagnostic.code, this.phase);
            this.phase = 'error';
            if (this.failures >= 3) {
                for (const ups of this.knownUps) {
                    const id = stableDeviceId(this.hostId, ups.name);
                    this.ingestion.markUnavailable(id, 'No successful NUT poll in three intervals');
                }
            }
        }
        finally {
            connection?.close();
            if (this.currentConnection === connection)
                this.currentConnection = null;
            this.isRunning = false;
        }
    }
    async pollAndSchedule() {
        await this.pollOnce();
        if (this.stopped)
            return;
        const backoffMs = this.failures === 0 ? 0 : Math.min(1000 * 2 ** (this.failures - 1), 60_000);
        const delay = Math.max(this.config.pollIntervalMs, backoffMs);
        this.timer = setTimeout(() => void this.pollAndSchedule(), delay);
        this.timer.unref();
    }
    updateDiscovery(discovered, observedAt) {
        const currentNames = new Set(discovered.map((ups) => ups.name));
        for (const previous of this.knownUps) {
            if (currentNames.has(previous.name))
                continue;
            const id = stableDeviceId(this.hostId, previous.name);
            this.ingestion.markUnavailable(id, 'UPS is no longer returned by NUT discovery', 'unavailable');
            this.deviceFailures.delete(id);
        }
        const discoveredIds = new Set(discovered.map((ups) => stableDeviceId(this.hostId, ups.name)));
        for (const id of this.deviceFailures.keys()) {
            if (!discoveredIds.has(id))
                this.deviceFailures.delete(id);
        }
        this.lastPollAt = observedAt;
    }
    reportDiagnostic(message, code, phase) {
        this.lastError = message;
        this.lastErrorCode = code;
        const fingerprint = `${phase}:${code}:${message}`;
        if (this.lastLoggedDiagnostic === fingerprint)
            return;
        this.lastLoggedDiagnostic = fingerprint;
        console.warn(JSON.stringify({
            level: 'warn',
            message: 'NUT collector diagnostic',
            hostId: this.hostId,
            host: this.config.nutHost,
            port: this.config.nutPort,
            phase,
            code,
            detail: message,
        }));
    }
    clearDiagnostic() {
        if (this.lastLoggedDiagnostic) {
            console.info(JSON.stringify({
                level: 'info',
                message: 'NUT collector recovered',
                hostId: this.hostId,
                host: this.config.nutHost,
                port: this.config.nutPort,
                discoveredUps: this.knownUps.length,
            }));
        }
        this.lastLoggedDiagnostic = null;
        this.lastError = null;
        this.lastErrorCode = null;
    }
}
function describeNutError(error) {
    if (error instanceof NutProtocolError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof Error && /timeout/i.test(error.message)) {
        return { code: 'TIMEOUT', message: 'NUT request timed out' };
    }
    const errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null;
    if (errorCode && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/.test(errorCode)) {
        return { code: errorCode, message: `NUT server connection failed (${errorCode})` };
    }
    if (error instanceof Error && /TLS negotiation failed/.test(error.message)) {
        return { code: 'TLS_ERROR', message: error.message.slice(0, 240) };
    }
    return {
        code: errorCode ?? 'NUT_ERROR',
        message: error instanceof Error ? error.message.slice(0, 240) : 'Unknown NUT error',
    };
}
