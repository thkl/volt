import { createTransport } from 'nodemailer';
import { decryptCredentials, encryptCredentials } from '../security/credentials.js';
const SETTINGS_KEY = 'alerts';
const DEFAULT_PREFERENCES = {
    rules: {
        onBattery: true,
        powerRestored: true,
        lowBattery: true,
        lowBatteryRestored: true,
        lowRuntime: false,
        runtimeThresholdMinutes: 10,
        connectionLost: true,
        connectionRestored: true,
    },
    pushover: { enabled: false },
    email: {
        enabled: false,
        host: '',
        port: 587,
        secure: false,
        from: '',
        to: '',
    },
};
const EMPTY_SECRETS = {
    pushoverApiToken: '',
    pushoverUserKey: '',
    emailUsername: '',
    emailPassword: '',
};
export class AlertConfigurationError extends Error {
}
export class AlertDeliveryError extends Error {
}
export class AlertService {
    store;
    credentialKey;
    collector;
    preferences;
    secrets;
    runtimeBelowThreshold = new Map();
    onSnapshot = (snapshot, events, hostId) => this.handleSnapshot(snapshot, events, hostId);
    constructor(store, credentialKey, collector) {
        this.store = store;
        this.credentialKey = credentialKey;
        this.collector = collector;
        const persisted = this.readPersistedSettings();
        this.preferences = persisted.preferences;
        this.secrets = persisted.encryptedSecrets
            ? { ...EMPTY_SECRETS, ...decryptCredentials(persisted.encryptedSecrets, credentialKey) }
            : { ...EMPTY_SECRETS };
        collector.on('snapshot', this.onSnapshot);
    }
    close() {
        this.collector.off('snapshot', this.onSnapshot);
    }
    getSettings() {
        return {
            rules: { ...this.preferences.rules },
            pushover: {
                enabled: this.preferences.pushover.enabled,
                configured: Boolean(this.secrets.pushoverApiToken && this.secrets.pushoverUserKey),
            },
            email: {
                ...this.preferences.email,
                configured: Boolean(this.preferences.email.host &&
                    this.preferences.email.from &&
                    this.preferences.email.to &&
                    (!this.secrets.emailUsername || this.secrets.emailPassword)),
                usernameConfigured: Boolean(this.secrets.emailUsername),
                credentialsConfigured: Boolean(this.secrets.emailUsername && this.secrets.emailPassword),
            },
        };
    }
    saveSettings(input) {
        const parsed = parseSettingsInput(input);
        const nextSecrets = { ...this.secrets };
        if (parsed.pushover.clearCredentials) {
            nextSecrets.pushoverApiToken = '';
            nextSecrets.pushoverUserKey = '';
        }
        if (parsed.email.clearCredentials) {
            nextSecrets.emailUsername = '';
            nextSecrets.emailPassword = '';
        }
        if (parsed.pushover.apiToken)
            nextSecrets.pushoverApiToken = parsed.pushover.apiToken;
        if (parsed.pushover.userKey)
            nextSecrets.pushoverUserKey = parsed.pushover.userKey;
        if (parsed.email.username)
            nextSecrets.emailUsername = parsed.email.username;
        if (parsed.email.password)
            nextSecrets.emailPassword = parsed.email.password;
        const nextPreferences = {
            rules: parsed.rules,
            pushover: { enabled: parsed.pushover.enabled },
            email: {
                enabled: parsed.email.enabled,
                host: parsed.email.host,
                port: parsed.email.port,
                secure: parsed.email.secure,
                from: parsed.email.from,
                to: parsed.email.to,
            },
        };
        validateConfiguredChannels(nextPreferences, nextSecrets);
        const hasSecrets = Object.values(nextSecrets).some(Boolean);
        const persisted = {
            version: 1,
            preferences: nextPreferences,
            encryptedSecrets: hasSecrets ? encryptCredentials(nextSecrets, this.credentialKey) : null,
        };
        this.store.setAppSetting(SETTINGS_KEY, JSON.stringify(persisted));
        if (this.preferences.rules.lowRuntime !== nextPreferences.rules.lowRuntime ||
            this.preferences.rules.runtimeThresholdMinutes !==
                nextPreferences.rules.runtimeThresholdMinutes) {
            this.runtimeBelowThreshold.clear();
        }
        this.preferences = nextPreferences;
        this.secrets = nextSecrets;
        return this.getSettings();
    }
    async sendTest(channel) {
        if (channel === 'pushover') {
            if (!this.preferences.pushover.enabled || !this.pushoverConfigured()) {
                throw new AlertConfigurationError('Enable and configure Pushover before sending a test');
            }
            await this.sendPushover('Volt test alert', 'Pushover alerts are configured and working.');
            return;
        }
        if (channel === 'email') {
            if (!this.preferences.email.enabled || !this.emailConfigured()) {
                throw new AlertConfigurationError('Enable and configure email before sending a test');
            }
            await this.sendEmail('Volt test alert', 'Email alerts are configured and working.');
            return;
        }
        throw new AlertConfigurationError('Choose a supported alert channel');
    }
    readPersistedSettings() {
        const raw = this.store.getAppSetting(SETTINGS_KEY);
        if (!raw)
            return {
                version: 1,
                preferences: structuredClone(DEFAULT_PREFERENCES),
                encryptedSecrets: null,
            };
        try {
            const value = JSON.parse(raw);
            if (value.version !== 1 || !isRecord(value.preferences))
                throw new Error('Invalid settings');
            return {
                version: 1,
                preferences: mergePreferences(value.preferences),
                encryptedSecrets: typeof value.encryptedSecrets === 'string' ? value.encryptedSecrets : null,
            };
        }
        catch {
            throw new Error('Saved alert settings could not be read');
        }
    }
    handleSnapshot(snapshot, events, hostId) {
        if (hostId === 'demo')
            return;
        const rules = this.preferences.rules;
        const notifications = new Map();
        for (const event of events) {
            const title = eventTitle(event.type, rules);
            if (title)
                notifications.set(title, `${snapshot.deviceName}: ${event.detail}`);
        }
        for (const [title, message] of notifications)
            void this.deliver(title, message);
        if (!rules.lowRuntime || snapshot.freshness !== 'fresh' || snapshot.runtimeSeconds === null) {
            return;
        }
        const thresholdSeconds = rules.runtimeThresholdMinutes * 60;
        const belowThreshold = snapshot.runtimeSeconds <= thresholdSeconds;
        const previouslyBelow = this.runtimeBelowThreshold.get(snapshot.deviceId);
        const crossedBelow = belowThreshold && previouslyBelow !== true;
        const recoveredWithMargin = previouslyBelow === true && snapshot.runtimeSeconds >= thresholdSeconds + 120;
        this.runtimeBelowThreshold.set(snapshot.deviceId, recoveredWithMargin ? false : previouslyBelow === true || belowThreshold);
        if (crossedBelow)
            this.sendLowRuntimeAlert(snapshot, rules.runtimeThresholdMinutes);
    }
    sendLowRuntimeAlert(snapshot, thresholdMinutes) {
        const runtime = Math.max(0, Math.floor((snapshot.runtimeSeconds ?? 0) / 60));
        void this.deliver('UPS runtime is low', `${snapshot.deviceName} reports about ${runtime} minutes remaining, below the configured ${thresholdMinutes}-minute threshold.`);
    }
    async deliver(title, message) {
        const attempts = [];
        if (this.preferences.pushover.enabled && this.pushoverConfigured()) {
            attempts.push({ channel: 'pushover', send: () => this.sendPushover(title, message) });
        }
        if (this.preferences.email.enabled && this.emailConfigured()) {
            attempts.push({ channel: 'email', send: () => this.sendEmail(title, message) });
        }
        await Promise.all(attempts.map(async ({ channel, send }) => {
            try {
                await send();
            }
            catch {
                console.error(JSON.stringify({ level: 'error', message: 'Alert delivery failed', channel }));
            }
        }));
    }
    async sendPushover(title, message) {
        const body = new URLSearchParams({
            token: this.secrets.pushoverApiToken,
            user: this.secrets.pushoverUserKey,
            title: title.slice(0, 250),
            message: message.slice(0, 1024),
        });
        let response;
        try {
            response = await fetch('https://api.pushover.net/1/messages.json', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.timeout(10_000),
            });
        }
        catch {
            throw new AlertDeliveryError('Pushover could not be reached');
        }
        const result = (await response.json().catch(() => null));
        if (!response.ok || result?.status !== 1) {
            throw new AlertDeliveryError('Pushover rejected the notification');
        }
    }
    async sendEmail(subject, text) {
        const email = this.preferences.email;
        const hasAuth = Boolean(this.secrets.emailUsername && this.secrets.emailPassword);
        const transport = createTransport({
            host: email.host,
            port: email.port,
            secure: email.secure,
            ...(hasAuth
                ? {
                    auth: { user: this.secrets.emailUsername, pass: this.secrets.emailPassword },
                    ...(!email.secure ? { requireTLS: true } : {}),
                }
                : {}),
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 20_000,
        });
        try {
            await transport.sendMail({
                from: email.from,
                to: email.to,
                subject: `Volt: ${subject}`,
                text,
            });
        }
        catch {
            throw new AlertDeliveryError('Email could not be delivered');
        }
        finally {
            transport.close();
        }
    }
    pushoverConfigured() {
        return Boolean(this.secrets.pushoverApiToken && this.secrets.pushoverUserKey);
    }
    emailConfigured() {
        const email = this.preferences.email;
        return Boolean(email.host &&
            email.from &&
            email.to &&
            (!this.secrets.emailUsername || this.secrets.emailPassword));
    }
}
function parseSettingsInput(value) {
    if (!isRecord(value) ||
        !isRecord(value['rules']) ||
        !isRecord(value['pushover']) ||
        !isRecord(value['email'])) {
        throw new AlertConfigurationError('Alert settings are incomplete');
    }
    const rules = value['rules'];
    const pushover = value['pushover'];
    const email = value['email'];
    const parsed = {
        rules: {
            onBattery: booleanValue(rules['onBattery'], 'onBattery'),
            powerRestored: booleanValue(rules['powerRestored'], 'powerRestored'),
            lowBattery: booleanValue(rules['lowBattery'], 'lowBattery'),
            lowBatteryRestored: booleanValue(rules['lowBatteryRestored'], 'lowBatteryRestored'),
            lowRuntime: booleanValue(rules['lowRuntime'], 'lowRuntime'),
            runtimeThresholdMinutes: integerValue(rules['runtimeThresholdMinutes'], 1, 1440, 'Runtime threshold'),
            connectionLost: booleanValue(rules['connectionLost'], 'connectionLost'),
            connectionRestored: booleanValue(rules['connectionRestored'], 'connectionRestored'),
        },
        pushover: {
            enabled: booleanValue(pushover['enabled'], 'Pushover enabled'),
            apiToken: stringValue(pushover['apiToken'], 255, 'Pushover API token'),
            userKey: stringValue(pushover['userKey'], 255, 'Pushover user key'),
            clearCredentials: booleanValue(pushover['clearCredentials'], 'Clear Pushover credentials'),
        },
        email: {
            enabled: booleanValue(email['enabled'], 'Email enabled'),
            host: stringValue(email['host'], 253, 'SMTP host').trim(),
            port: integerValue(email['port'], 1, 65535, 'SMTP port'),
            secure: booleanValue(email['secure'], 'SMTP TLS'),
            username: stringValue(email['username'], 254, 'SMTP username').trim(),
            password: stringValue(email['password'], 1024, 'SMTP password'),
            from: stringValue(email['from'], 254, 'Sender email').trim(),
            to: stringValue(email['to'], 254, 'Recipient email').trim(),
            clearCredentials: booleanValue(email['clearCredentials'], 'Clear email credentials'),
        },
    };
    if (parsed.pushover.apiToken.trim())
        parsed.pushover.apiToken = parsed.pushover.apiToken.trim();
    if (parsed.pushover.userKey.trim())
        parsed.pushover.userKey = parsed.pushover.userKey.trim();
    return parsed;
}
function validateConfiguredChannels(preferences, secrets) {
    const pushover = preferences.pushover;
    if (pushover.enabled && !(secrets.pushoverApiToken && secrets.pushoverUserKey)) {
        throw new AlertConfigurationError('Pushover needs both an API token and a user key');
    }
    const email = preferences.email;
    if (email.enabled && !(email.host && validEmail(email.from) && validEmail(email.to))) {
        throw new AlertConfigurationError('Email needs an SMTP host, sender address and recipient address');
    }
    if (Boolean(secrets.emailUsername) !== Boolean(secrets.emailPassword)) {
        throw new AlertConfigurationError('SMTP username and password must be provided together');
    }
    if (email.host && /[\s/@?#]/.test(email.host)) {
        throw new AlertConfigurationError('SMTP host must be a host name or IP address');
    }
}
function eventTitle(type, rules) {
    if (type === 'on-battery' && rules.onBattery)
        return 'UPS switched to battery power';
    if (type === 'mains-restored' && rules.powerRestored)
        return 'Utility power restored';
    if (type === 'low-battery' && rules.lowBattery)
        return 'UPS reports low battery';
    if (type === 'battery-normal' && rules.lowBatteryRestored)
        return 'Low-battery warning cleared';
    if (type === 'connection-lost' && rules.connectionLost)
        return 'UPS connection lost';
    if (type === 'connection-restored' && rules.connectionRestored)
        return 'UPS connection restored';
    return null;
}
function mergePreferences(value) {
    const defaults = structuredClone(DEFAULT_PREFERENCES);
    const rules = isRecord(value['rules']) ? value['rules'] : {};
    const pushover = isRecord(value['pushover']) ? value['pushover'] : {};
    const email = isRecord(value['email']) ? value['email'] : {};
    return {
        rules: {
            onBattery: typeof rules['onBattery'] === 'boolean' ? rules['onBattery'] : defaults.rules.onBattery,
            powerRestored: typeof rules['powerRestored'] === 'boolean'
                ? rules['powerRestored']
                : defaults.rules.powerRestored,
            lowBattery: typeof rules['lowBattery'] === 'boolean' ? rules['lowBattery'] : defaults.rules.lowBattery,
            lowBatteryRestored: typeof rules['lowBatteryRestored'] === 'boolean'
                ? rules['lowBatteryRestored']
                : defaults.rules.lowBatteryRestored,
            lowRuntime: typeof rules['lowRuntime'] === 'boolean' ? rules['lowRuntime'] : defaults.rules.lowRuntime,
            runtimeThresholdMinutes: typeof rules['runtimeThresholdMinutes'] === 'number'
                ? rules['runtimeThresholdMinutes']
                : defaults.rules.runtimeThresholdMinutes,
            connectionLost: typeof rules['connectionLost'] === 'boolean'
                ? rules['connectionLost']
                : defaults.rules.connectionLost,
            connectionRestored: typeof rules['connectionRestored'] === 'boolean'
                ? rules['connectionRestored']
                : defaults.rules.connectionRestored,
        },
        pushover: { enabled: typeof pushover['enabled'] === 'boolean' ? pushover['enabled'] : false },
        email: {
            enabled: typeof email['enabled'] === 'boolean' ? email['enabled'] : false,
            host: typeof email['host'] === 'string' ? email['host'] : '',
            port: typeof email['port'] === 'number' ? email['port'] : defaults.email.port,
            secure: typeof email['secure'] === 'boolean' ? email['secure'] : false,
            from: typeof email['from'] === 'string' ? email['from'] : '',
            to: typeof email['to'] === 'string' ? email['to'] : '',
        },
    };
}
function booleanValue(value, label) {
    if (typeof value !== 'boolean')
        throw new AlertConfigurationError(`${label} must be true or false`);
    return value;
}
function stringValue(value, maximum, label) {
    if (typeof value !== 'string' || value.length > maximum) {
        throw new AlertConfigurationError(`${label} is invalid`);
    }
    return value;
}
function integerValue(value, minimum, maximum, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
        throw new AlertConfigurationError(`${label} must be between ${minimum} and ${maximum}`);
    }
    return value;
}
function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
