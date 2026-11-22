import { stableDeviceId } from '../domain/ids.js';
import { HOME_ASSISTANT_NUMERIC_FIELDS, } from './homeassistant-config.js';
const EMPTY_METRICS = {
    batteryCharge: null,
    runtimeSeconds: null,
    loadPercent: null,
    realPower: null,
    inputVoltage: null,
    outputVoltage: null,
    inputFrequency: null,
    outputFrequency: null,
    batteryVoltage: null,
    temperature: null,
};
export class HomeAssistantCollector {
    ingestion;
    config;
    hostId;
    hostName;
    timer = null;
    abortController = null;
    stopped = false;
    isRunning = false;
    connected = false;
    mappedDataAvailable = false;
    failures = 0;
    lastPollAt = null;
    lastError = null;
    lastErrorCode = null;
    lastLoggedDiagnostic = null;
    phase = 'starting';
    endpoint;
    accessToken;
    deviceId;
    constructor(ingestion, config, hostId, hostName, endpointConfig, credentials) {
        this.ingestion = ingestion;
        this.config = config;
        this.hostId = hostId;
        this.hostName = hostName;
        this.endpoint = parseEndpointConfig(endpointConfig);
        this.accessToken = credentials?.['accessToken'] ?? '';
        if (!this.accessToken)
            throw new Error('Home Assistant access token is required');
        this.deviceId = stableDeviceId(hostId, 'homeassistant-mapped-battery');
    }
    start() {
        if (this.timer || this.isRunning)
            return;
        this.stopped = false;
        void this.pollAndSchedule();
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.abortController?.abort();
        this.abortController = null;
    }
    health() {
        return {
            mode: 'homeassistant',
            status: this.connected && this.mappedDataAvailable ? 'ready' : 'degraded',
            connected: this.connected,
            lastPollAt: this.lastPollAt,
            lastError: this.lastError,
            phase: this.phase,
            discoveredUps: this.connected ? 1 : 0,
            upsNames: this.connected ? [this.hostName] : [],
            lastDiscoveryAt: this.lastPollAt,
            lastErrorCode: this.lastErrorCode,
            consecutiveFailures: this.failures,
        };
    }
    async pollOnce(now = Date.now()) {
        if (this.isRunning || this.stopped)
            return;
        this.isRunning = true;
        this.phase = 'connecting';
        const controller = new AbortController();
        this.abortController = controller;
        const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
        timeout.unref();
        try {
            const response = await fetch(`${this.endpoint.url.replace(/\/+$/, '')}/api/states`, {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${this.accessToken}`,
                },
                cache: 'no-store',
                redirect: 'error',
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new HomeAssistantRequestError(`Home Assistant returned HTTP ${response.status}`, `HTTP_${response.status}`);
            }
            this.phase = 'reading';
            const states = parseStates(await response.json());
            const observedAt = new Date(now).toISOString();
            const snapshot = normalizeHomeAssistantStates(this.deviceId, this.hostName, states, this.endpoint.entities, observedAt);
            this.mappedDataAvailable = hasMappedData(snapshot, states, this.endpoint.entities);
            this.connected = true;
            this.failures = 0;
            this.lastPollAt = observedAt;
            this.phase = 'ready';
            if (this.mappedDataAvailable) {
                this.clearDiagnostic();
            }
            else {
                this.reportDiagnostic('Home Assistant is connected, but none of the mapped entities has a usable value', 'NO_MAPPED_ENTITY_DATA');
            }
            this.ingestion.ingest(snapshot, this.hostName);
        }
        catch (error) {
            if (this.stopped)
                return;
            this.connected = false;
            this.failures += 1;
            const diagnostic = describeHomeAssistantError(error);
            this.phase = 'error';
            this.reportDiagnostic(diagnostic.message, diagnostic.code);
            if (this.failures >= 3) {
                this.ingestion.markUnavailable(this.deviceId, 'No successful Home Assistant state poll in three intervals');
            }
        }
        finally {
            clearTimeout(timeout);
            if (this.abortController === controller)
                this.abortController = null;
            this.isRunning = false;
        }
    }
    async pollAndSchedule() {
        await this.pollOnce();
        if (this.stopped)
            return;
        const backoffMs = this.failures === 0 ? 0 : Math.min(1000 * 2 ** (this.failures - 1), 60_000);
        const pollIntervalMs = Math.max(this.config.pollIntervalMs, 10_000);
        this.timer = setTimeout(() => void this.pollAndSchedule(), Math.max(pollIntervalMs, backoffMs));
        this.timer.unref();
    }
    reportDiagnostic(message, code) {
        this.lastError = message;
        this.lastErrorCode = code;
        const fingerprint = `${code}:${message}`;
        if (this.lastLoggedDiagnostic === fingerprint)
            return;
        this.lastLoggedDiagnostic = fingerprint;
        console.warn(JSON.stringify({
            level: 'warn',
            message: 'Home Assistant collector diagnostic',
            hostId: this.hostId,
            hostName: this.hostName,
            phase: this.phase,
            code,
            detail: message,
        }));
    }
    clearDiagnostic() {
        if (this.lastLoggedDiagnostic) {
            console.info(JSON.stringify({
                level: 'info',
                message: 'Home Assistant collector recovered',
                hostId: this.hostId,
                hostName: this.hostName,
            }));
        }
        this.lastLoggedDiagnostic = null;
        this.lastError = null;
        this.lastErrorCode = null;
    }
}
function normalizeHomeAssistantStates(deviceId, deviceName, states, entities, observedAt) {
    const metrics = { ...EMPTY_METRICS };
    const rawVariables = {};
    for (const field of HOME_ASSISTANT_NUMERIC_FIELDS) {
        const mapping = entities.metrics[field];
        if (!mapping)
            continue;
        const state = usableState(states.get(mapping.entityId));
        if (!state)
            continue;
        rawVariables[mapping.entityId] = state.state;
        metrics[field] = normalizeNumber(state.state, mapping.scale);
    }
    const statusState = usableState(entities.statusEntityId ? states.get(entities.statusEntityId) : undefined);
    const batteryState = usableState(entities.onBatteryEntityId ? states.get(entities.onBatteryEntityId) : undefined);
    const chargingState = usableState(entities.chargingEntityId ? states.get(entities.chargingEntityId) : undefined);
    const lowBatteryState = usableState(entities.lowBatteryEntityId ? states.get(entities.lowBatteryEntityId) : undefined);
    if (statusState && entities.statusEntityId)
        rawVariables[entities.statusEntityId] = statusState.state;
    if (batteryState && entities.onBatteryEntityId) {
        rawVariables[entities.onBatteryEntityId] = batteryState.state;
    }
    if (chargingState && entities.chargingEntityId) {
        rawVariables[entities.chargingEntityId] = chargingState.state;
    }
    if (lowBatteryState && entities.lowBatteryEntityId) {
        rawVariables[entities.lowBatteryEntityId] = lowBatteryState.state;
    }
    const batteryFlag = parseBooleanState(batteryState?.state, 'battery');
    const chargingFlag = parseBooleanState(chargingState?.state, 'charging');
    const status = statusState?.state ?? '';
    const statusTokens = status.split(/[\s,]+/).filter(Boolean);
    const flow = batteryFlag === true ? 'battery' : batteryFlag === false ? 'online' : parseFlow(status);
    const lowBatteryFlag = parseBooleanState(lowBatteryState?.state, 'low-battery');
    const lowBattery = lowBatteryFlag ?? /(^|[\s,])(LB|LOW[\s_-]+BATTERY)(?=$|[\s,])/i.test(status);
    return {
        deviceId,
        deviceName,
        model: 'Home Assistant battery system',
        manufacturer: 'Home Assistant',
        flow,
        freshness: 'fresh',
        status: status ||
            (batteryFlag === true ? 'ON BATTERY' : batteryFlag === false ? 'ONLINE' : 'Unknown'),
        statusTokens,
        lowBattery,
        charging: chargingFlag ?? statusTokens.some((token) => /^(charging|chrg)$/i.test(token)),
        batteryCharge: metrics.batteryCharge,
        runtimeSeconds: metrics.runtimeSeconds,
        loadPercent: metrics.loadPercent,
        realPower: metrics.realPower,
        powerEstimated: false,
        apparentPower: null,
        ratedRealPower: null,
        inputVoltage: metrics.inputVoltage,
        outputVoltage: metrics.outputVoltage,
        inputFrequency: metrics.inputFrequency,
        outputFrequency: metrics.outputFrequency,
        batteryVoltage: metrics.batteryVoltage,
        temperature: metrics.temperature,
        alarm: null,
        observedAt,
        rawVariables,
    };
}
function parseEndpointConfig(value) {
    const url = value['url'];
    const entities = value['entities'];
    if (typeof url !== 'string' || !isRecord(entities) || !isRecord(entities['metrics'])) {
        throw new Error('Home Assistant connection settings are invalid');
    }
    const baseUrl = parseHomeAssistantUrl(url);
    const metricConfig = entities['metrics'];
    const metrics = Object.fromEntries(HOME_ASSISTANT_NUMERIC_FIELDS.map((field) => [field, parseMetricMapping(metricConfig[field])]));
    return {
        url: baseUrl,
        entities: {
            statusEntityId: parseOptionalEntityId(entities['statusEntityId']),
            onBatteryEntityId: parseOptionalEntityId(entities['onBatteryEntityId']),
            chargingEntityId: parseOptionalEntityId(entities['chargingEntityId']),
            lowBatteryEntityId: parseOptionalEntityId(entities['lowBatteryEntityId']),
            metrics,
        },
    };
}
function parseHomeAssistantUrl(value) {
    try {
        const url = new URL(value);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
            !url.hostname ||
            url.username ||
            url.password ||
            url.search ||
            url.hash) {
            throw new Error('Invalid URL');
        }
        return url.toString().replace(/\/+$/, '');
    }
    catch {
        throw new Error('Home Assistant URL must be an absolute HTTP or HTTPS URL');
    }
}
function parseMetricMapping(value) {
    if (value === null)
        return null;
    if (!isRecord(value))
        throw new Error('Home Assistant entity mapping is invalid');
    const entityId = parseOptionalEntityId(value['entityId']);
    const scale = value['scale'];
    if (!entityId || typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
        throw new Error('Home Assistant entity mapping is invalid');
    }
    return { entityId, scale };
}
function parseOptionalEntityId(value) {
    if (value === null || value === undefined || value === '')
        return null;
    if (typeof value === 'string' && /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(value))
        return value;
    throw new Error('Home Assistant entity ID is invalid');
}
function parseStates(value) {
    if (!Array.isArray(value)) {
        throw new HomeAssistantRequestError('Home Assistant returned an invalid state list', 'INVALID_RESPONSE');
    }
    const states = new Map();
    for (const item of value) {
        if (!isRecord(item) ||
            typeof item['entity_id'] !== 'string' ||
            typeof item['state'] !== 'string') {
            continue;
        }
        states.set(item['entity_id'], {
            entity_id: item['entity_id'],
            state: item['state'],
            attributes: isRecord(item['attributes']) ? item['attributes'] : {},
        });
    }
    return states;
}
function usableState(value) {
    if (!value || /^(unknown|unavailable|none|null)$/i.test(value.state.trim()))
        return null;
    return value;
}
function normalizeNumber(state, scale) {
    const normalizedState = state.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalizedState))
        return null;
    const value = Number(normalizedState);
    if (!Number.isFinite(value))
        return null;
    const normalized = value * scale;
    return Number.isFinite(normalized) ? normalized : null;
}
function parseBooleanState(value, kind) {
    if (value === undefined)
        return null;
    const state = value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (kind === 'battery') {
        if (['on', 'true', '1', 'yes', 'active', 'ob', 'on_battery', 'discharging'].includes(state)) {
            return true;
        }
        if (['off', 'false', '0', 'no', 'inactive', 'ol', 'online', 'charging'].includes(state)) {
            return false;
        }
    }
    else if (kind === 'charging') {
        if (['on', 'true', '1', 'yes', 'active', 'charging', 'chrg'].includes(state))
            return true;
        if (['off', 'false', '0', 'no', 'inactive', 'not_charging', 'idle'].includes(state)) {
            return false;
        }
    }
    else {
        if (['on', 'true', '1', 'yes', 'active', 'low', 'critical', 'low_battery'].includes(state)) {
            return true;
        }
        if (['off', 'false', '0', 'no', 'inactive', 'normal', 'ok'].includes(state))
            return false;
    }
    return null;
}
function parseFlow(value) {
    const tokens = value
        .trim()
        .toLowerCase()
        .split(/[\s,]+/)
        .map((token) => token.replace(/-/g, '_'));
    if (tokens.some((token) => ['ob', 'on_battery', 'battery', 'discharging', 'backup', 'islanded'].includes(token))) {
        return 'battery';
    }
    if (tokens.some((token) => [
        'ol',
        'online',
        'on_line',
        'utility',
        'grid',
        'mains',
        'charging',
        'chrg',
        'normal',
    ].includes(token))) {
        return 'online';
    }
    return 'unknown';
}
function hasMappedData(snapshot, states, entities) {
    return (snapshot.flow !== 'unknown' ||
        snapshot.status !== 'Unknown' ||
        snapshot.lowBattery ||
        snapshot.charging ||
        Boolean(entities.onBatteryEntityId && usableState(states.get(entities.onBatteryEntityId))) ||
        Boolean(entities.chargingEntityId && usableState(states.get(entities.chargingEntityId))) ||
        Boolean(entities.lowBatteryEntityId && usableState(states.get(entities.lowBatteryEntityId))) ||
        snapshot.batteryCharge !== null ||
        snapshot.runtimeSeconds !== null ||
        snapshot.loadPercent !== null ||
        snapshot.realPower !== null ||
        snapshot.inputVoltage !== null ||
        snapshot.outputVoltage !== null ||
        snapshot.inputFrequency !== null ||
        snapshot.outputFrequency !== null ||
        snapshot.batteryVoltage !== null ||
        snapshot.temperature !== null);
}
function describeHomeAssistantError(error) {
    if (error instanceof HomeAssistantRequestError)
        return { code: error.code, message: error.message };
    if (error instanceof Error && error.name === 'AbortError') {
        return { code: 'TIMEOUT', message: 'Home Assistant request timed out' };
    }
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'CONNECTION_ERROR';
    return { code, message: 'Could not connect to Home Assistant' };
}
class HomeAssistantRequestError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
