import { decryptCredentials, encryptCredentials } from '../security/credentials.js';
const SETTINGS_KEY = 'influxdb';
const DEFAULT_PREFERENCES = {
    enabled: false,
    url: '',
    org: '',
    bucket: '',
    measurement: 'volt_ups',
};
export class InfluxConfigurationError extends Error {
}
export class InfluxDeliveryError extends Error {
}
export class InfluxDbService {
    store;
    credentialKey;
    collector;
    preferences;
    token;
    lastWriteAt = null;
    lastError = null;
    onSnapshot = (snapshot, _events, hostId) => {
        void this.writeSnapshot(snapshot, hostId);
    };
    constructor(store, credentialKey, collector) {
        this.store = store;
        this.credentialKey = credentialKey;
        this.collector = collector;
        try {
            const persisted = this.readPersistedSettings();
            this.preferences = persisted.preferences;
            this.token = persisted.encryptedToken
                ? (decryptCredentials(persisted.encryptedToken, credentialKey)['token'] ?? '')
                : '';
        }
        catch {
            this.preferences = structuredClone(DEFAULT_PREFERENCES);
            this.token = '';
            this.lastError = 'Saved InfluxDB settings or token could not be read';
            console.error(JSON.stringify({
                level: 'error',
                message: 'Saved InfluxDB settings could not be loaded; integration is disabled',
            }));
        }
        collector.on('snapshot', this.onSnapshot);
    }
    close() {
        this.collector.off('snapshot', this.onSnapshot);
    }
    getSettings() {
        const tokenConfigured = Boolean(this.token);
        const configured = Boolean(this.preferences.url &&
            this.preferences.org &&
            this.preferences.bucket &&
            this.preferences.measurement &&
            tokenConfigured);
        const status = this.lastError
            ? 'error'
            : !this.preferences.enabled
                ? 'disabled'
                : !configured
                    ? 'not-configured'
                    : this.lastWriteAt
                        ? 'connected'
                        : 'waiting';
        return {
            ...this.preferences,
            configured,
            tokenConfigured,
            status,
            lastWriteAt: this.lastWriteAt,
            lastError: this.lastError,
        };
    }
    saveSettings(input) {
        const parsed = parseSettingsInput(input);
        const nextToken = parsed.clearToken ? '' : parsed.token || this.token;
        const nextPreferences = {
            enabled: parsed.enabled,
            url: parsed.url ? normalizeBaseUrl(parsed.url) : '',
            org: parsed.org,
            bucket: parsed.bucket,
            measurement: parsed.measurement,
        };
        if (nextPreferences.enabled &&
            (!nextPreferences.url ||
                !nextPreferences.org ||
                !nextPreferences.bucket ||
                !nextPreferences.measurement ||
                !nextToken)) {
            throw new InfluxConfigurationError('Enter the InfluxDB URL, organization, bucket, measurement, and token before enabling writes');
        }
        const persisted = {
            version: 1,
            preferences: nextPreferences,
            encryptedToken: nextToken
                ? encryptCredentials({ token: nextToken }, this.credentialKey)
                : null,
        };
        this.store.setAppSetting(SETTINGS_KEY, JSON.stringify(persisted));
        this.preferences = nextPreferences;
        this.token = nextToken;
        this.lastWriteAt = null;
        this.lastError = null;
        return this.getSettings();
    }
    async sendTestWrite() {
        if (!this.preferences.enabled || !this.isConfigured()) {
            throw new InfluxConfigurationError('Enable and configure InfluxDB before sending a test write');
        }
        const timestamp = Date.now();
        const line = `${escapeMeasurement(this.preferences.measurement)},source=volt-test test_write=true ${timestamp}`;
        try {
            await this.writeLine(line);
            this.noteSuccess();
        }
        catch (error) {
            this.noteFailure(error);
            throw error;
        }
    }
    readPersistedSettings() {
        const raw = this.store.getAppSetting(SETTINGS_KEY);
        if (!raw) {
            return {
                version: 1,
                preferences: structuredClone(DEFAULT_PREFERENCES),
                encryptedToken: null,
            };
        }
        try {
            const value = JSON.parse(raw);
            if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['preferences'])) {
                throw new Error('Invalid settings');
            }
            return {
                version: 1,
                preferences: mergePreferences(value['preferences']),
                encryptedToken: typeof value['encryptedToken'] === 'string' ? value['encryptedToken'] : null,
            };
        }
        catch {
            throw new Error('Saved InfluxDB settings could not be read');
        }
    }
    async writeSnapshot(snapshot, hostId) {
        if (hostId === 'demo' ||
            snapshot.freshness !== 'fresh' ||
            !this.preferences.enabled ||
            !this.isConfigured()) {
            return;
        }
        const line = snapshotLine(snapshot, hostId, this.preferences.measurement);
        if (!line)
            return;
        try {
            await this.writeLine(line);
            this.noteSuccess();
        }
        catch (error) {
            this.noteFailure(error);
        }
    }
    async writeLine(line) {
        const target = new URL(`${this.preferences.url}/api/v2/write`);
        target.searchParams.set('org', this.preferences.org);
        target.searchParams.set('bucket', this.preferences.bucket);
        target.searchParams.set('precision', 'ms');
        let response;
        try {
            response = await fetch(target, {
                method: 'POST',
                headers: {
                    Authorization: `Token ${this.token}`,
                    'Content-Type': 'text/plain; charset=utf-8',
                    Accept: 'application/json',
                },
                body: line,
                signal: AbortSignal.timeout(10_000),
                redirect: 'error',
            });
        }
        catch {
            throw new InfluxDeliveryError('InfluxDB could not be reached or timed out');
        }
        if (!response.ok) {
            throw new InfluxDeliveryError(`InfluxDB rejected a write (HTTP ${response.status})`);
        }
    }
    isConfigured() {
        return Boolean(this.preferences.url &&
            this.preferences.org &&
            this.preferences.bucket &&
            this.preferences.measurement &&
            this.token);
    }
    noteSuccess() {
        const recovered = this.lastError !== null;
        this.lastWriteAt = new Date().toISOString();
        this.lastError = null;
        if (recovered) {
            console.info(JSON.stringify({ level: 'info', message: 'InfluxDB writes recovered' }));
        }
    }
    noteFailure(error) {
        const message = error instanceof InfluxDeliveryError ? error.message : 'InfluxDB write failed unexpectedly';
        if (this.lastError === message)
            return;
        this.lastError = message;
        console.error(JSON.stringify({ level: 'error', message: 'InfluxDB write failed', detail: message }));
    }
}
function parseSettingsInput(value) {
    if (!isRecord(value) ||
        typeof value['enabled'] !== 'boolean' ||
        typeof value['url'] !== 'string' ||
        typeof value['org'] !== 'string' ||
        typeof value['bucket'] !== 'string' ||
        typeof value['measurement'] !== 'string' ||
        typeof value['token'] !== 'string' ||
        typeof value['clearToken'] !== 'boolean') {
        throw new InfluxConfigurationError('InfluxDB settings are invalid');
    }
    const result = {
        enabled: value['enabled'],
        url: value['url'].trim(),
        org: value['org'].trim(),
        bucket: value['bucket'].trim(),
        measurement: value['measurement'].trim(),
        token: value['token'].trim(),
        clearToken: value['clearToken'],
    };
    if (result.url.length > 2048 ||
        result.org.length > 255 ||
        result.bucket.length > 255 ||
        result.measurement.length > 128 ||
        result.token.length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(result.measurement)) {
        throw new InfluxConfigurationError('InfluxDB settings exceed the allowed length');
    }
    return result;
}
function normalizeBaseUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new InfluxConfigurationError('Enter a valid InfluxDB server URL');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        url.search ||
        url.hash) {
        throw new InfluxConfigurationError('InfluxDB URL must use HTTP or HTTPS without embedded credentials, query parameters, or fragments');
    }
    return url.href.replace(/\/+$/, '');
}
function snapshotLine(snapshot, hostId, measurement) {
    const tags = [
        ['host_id', hostId],
        ['device_id', snapshot.deviceId],
        ['device_name', snapshot.deviceName],
        ['model', snapshot.model],
    ]
        .map(([key, value]) => `${key}=${escapeTag(value ?? '')}`)
        .join(',');
    const fields = [];
    const numericFields = [
        ['battery_charge', snapshot.batteryCharge],
        ['runtime_seconds', snapshot.runtimeSeconds],
        ['load_percent', snapshot.loadPercent],
        ['real_power', snapshot.realPower],
        ['apparent_power', snapshot.apparentPower],
        ['rated_real_power', snapshot.ratedRealPower],
        ['input_voltage', snapshot.inputVoltage],
        ['output_voltage', snapshot.outputVoltage],
        ['input_frequency', snapshot.inputFrequency],
        ['output_frequency', snapshot.outputFrequency],
        ['battery_voltage', snapshot.batteryVoltage],
        ['temperature', snapshot.temperature],
    ];
    for (const [key, value] of numericFields) {
        if (value !== null && Number.isFinite(value))
            fields.push(`${key}=${value}`);
    }
    fields.push(`low_battery=${snapshot.lowBattery}`, `charging=${snapshot.charging}`, `power_estimated=${snapshot.powerEstimated}`, `flow=${escapeStringField(snapshot.flow)}`, `freshness=${escapeStringField(snapshot.freshness)}`, `status=${escapeStringField(snapshot.status)}`, `status_tokens=${escapeStringField(snapshot.statusTokens.join(','))}`);
    if (snapshot.alarm)
        fields.push(`alarm=${escapeStringField(snapshot.alarm)}`);
    const observedAt = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observedAt))
        return null;
    return `${escapeMeasurement(measurement)},${tags} ${fields.join(',')} ${observedAt}`;
}
function escapeMeasurement(value) {
    return value.replaceAll('\\', '\\\\').replaceAll(',', '\\,').replaceAll(' ', '\\ ');
}
function escapeTag(value) {
    return escapeMeasurement(value.replace(/[\u0000-\u001f\u007f]/g, ' ')).replaceAll('=', '\\=');
}
function escapeStringField(value) {
    return JSON.stringify(value);
}
function mergePreferences(value) {
    return {
        enabled: value['enabled'] === true,
        url: typeof value['url'] === 'string' ? value['url'] : '',
        org: typeof value['org'] === 'string' ? value['org'] : '',
        bucket: typeof value['bucket'] === 'string' ? value['bucket'] : '',
        measurement: typeof value['measurement'] === 'string' && value['measurement'].trim()
            ? value['measurement']
            : DEFAULT_PREFERENCES.measurement,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
