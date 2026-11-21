import { createTransport } from 'nodemailer';
import type { HostManager } from '../collector/host-manager.js';
import type { UpsSnapshot } from '../domain/models.js';
import { decryptCredentials, encryptCredentials } from '../security/credentials.js';
import type {
  AlertHistoryChannelResult,
  AlertHistoryRecord,
  AlertHistoryStatus,
  Store,
} from '../storage/store.js';

export type AlertChannel = 'pushover' | 'email';

interface AlertRules {
  onBattery: boolean;
  powerRestored: boolean;
  lowBattery: boolean;
  lowBatteryRestored: boolean;
  lowRuntime: boolean;
  runtimeThresholdMinutes: number;
  connectionLost: boolean;
  connectionRestored: boolean;
}

interface AlertPreferences {
  rules: AlertRules;
  pushover: { enabled: boolean };
  email: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    from: string;
    to: string;
  };
}

interface AlertSecrets {
  pushoverApiToken: string;
  pushoverUserKey: string;
  emailUsername: string;
  emailPassword: string;
}

interface PersistedAlertSettings {
  version: 1;
  preferences: AlertPreferences;
  encryptedSecrets: string | null;
}

export interface AlertSettingsInput {
  rules: AlertRules;
  pushover: {
    enabled: boolean;
    apiToken: string;
    userKey: string;
    clearCredentials: boolean;
  };
  email: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    from: string;
    to: string;
    clearCredentials: boolean;
  };
}

export interface AlertSettingsView {
  rules: AlertRules;
  pushover: { enabled: boolean; configured: boolean };
  email: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    from: string;
    to: string;
    configured: boolean;
    usernameConfigured: boolean;
    credentialsConfigured: boolean;
  };
}

interface AlertEvent {
  type: string;
  detail: string;
}

interface AlertContext {
  eventType: string;
  deviceId?: string;
  deviceName?: string;
}

const SETTINGS_KEY = 'alerts';
const DEFAULT_PREFERENCES: AlertPreferences = {
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
const EMPTY_SECRETS: AlertSecrets = {
  pushoverApiToken: '',
  pushoverUserKey: '',
  emailUsername: '',
  emailPassword: '',
};

export class AlertConfigurationError extends Error {}
export class AlertDeliveryError extends Error {}

export class AlertService {
  private preferences: AlertPreferences;
  private secrets: AlertSecrets;
  private readonly runtimeBelowThreshold = new Map<string, boolean>();
  private readonly startupDeviceIds: Set<string>;
  private readonly deletedDeviceIds = new Set<string>();
  private readonly onSnapshot = (snapshot: UpsSnapshot, events: AlertEvent[], hostId: string) =>
    this.handleSnapshot(snapshot, events, hostId);
  private readonly onDevicesDeleted = (deviceIds: string[]) => {
    for (const deviceId of deviceIds) {
      this.startupDeviceIds.delete(deviceId);
      this.runtimeBelowThreshold.delete(deviceId);
      this.deletedDeviceIds.add(deviceId);
    }
  };

  constructor(
    private readonly store: Store,
    private readonly credentialKey: string,
    private readonly collector: HostManager,
  ) {
    const persisted = this.readPersistedSettings();
    this.preferences = persisted.preferences;
    this.secrets = persisted.encryptedSecrets
      ? { ...EMPTY_SECRETS, ...decryptCredentials(persisted.encryptedSecrets, credentialKey) }
      : { ...EMPTY_SECRETS };
    this.startupDeviceIds = new Set(store.listDevices().map((device) => device.id));
    collector.on('snapshot', this.onSnapshot);
    collector.on('devices-deleted', this.onDevicesDeleted);
  }

  close(): void {
    this.collector.off('snapshot', this.onSnapshot);
    this.collector.off('devices-deleted', this.onDevicesDeleted);
  }

  getSettings(): AlertSettingsView {
    return {
      rules: { ...this.preferences.rules },
      pushover: {
        enabled: this.preferences.pushover.enabled,
        configured: Boolean(this.secrets.pushoverApiToken && this.secrets.pushoverUserKey),
      },
      email: {
        ...this.preferences.email,
        configured: Boolean(
          this.preferences.email.host &&
          this.preferences.email.from &&
          this.preferences.email.to &&
          (!this.secrets.emailUsername || this.secrets.emailPassword),
        ),
        usernameConfigured: Boolean(this.secrets.emailUsername),
        credentialsConfigured: Boolean(this.secrets.emailUsername && this.secrets.emailPassword),
      },
    };
  }

  getHistory(limit = 100): AlertHistoryRecord[] {
    return this.store.listAlertHistory(limit);
  }

  saveSettings(input: unknown): AlertSettingsView {
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
    if (parsed.pushover.apiToken) nextSecrets.pushoverApiToken = parsed.pushover.apiToken;
    if (parsed.pushover.userKey) nextSecrets.pushoverUserKey = parsed.pushover.userKey;
    if (parsed.email.username) nextSecrets.emailUsername = parsed.email.username;
    if (parsed.email.password) nextSecrets.emailPassword = parsed.email.password;

    const nextPreferences: AlertPreferences = {
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
    const persisted: PersistedAlertSettings = {
      version: 1,
      preferences: nextPreferences,
      encryptedSecrets: hasSecrets ? encryptCredentials(nextSecrets, this.credentialKey) : null,
    };
    this.store.setAppSetting(SETTINGS_KEY, JSON.stringify(persisted));
    if (
      this.preferences.rules.lowRuntime !== nextPreferences.rules.lowRuntime ||
      this.preferences.rules.runtimeThresholdMinutes !==
        nextPreferences.rules.runtimeThresholdMinutes
    ) {
      this.runtimeBelowThreshold.clear();
    }
    this.preferences = nextPreferences;
    this.secrets = nextSecrets;
    return this.getSettings();
  }

  async sendTest(channel: AlertChannel): Promise<void> {
    if (channel === 'pushover') {
      if (!this.preferences.pushover.enabled || !this.pushoverConfigured()) {
        throw new AlertConfigurationError('Enable and configure Pushover before sending a test');
      }
      const status = await this.deliver(
        'Volt test alert',
        'Pushover alerts are configured and working.',
        { eventType: 'test' },
        ['pushover'],
      );
      if (status !== 'delivered') throw new AlertDeliveryError('Pushover test delivery failed');
      return;
    }

    if (channel === 'email') {
      if (!this.preferences.email.enabled || !this.emailConfigured()) {
        throw new AlertConfigurationError('Enable and configure email before sending a test');
      }
      const status = await this.deliver(
        'Volt test alert',
        'Email alerts are configured and working.',
        { eventType: 'test' },
        ['email'],
      );
      if (status !== 'delivered') throw new AlertDeliveryError('Email test delivery failed');
      return;
    }
    throw new AlertConfigurationError('Choose a supported alert channel');
  }

  private readPersistedSettings(): PersistedAlertSettings {
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw)
      return {
        version: 1,
        preferences: structuredClone(DEFAULT_PREFERENCES),
        encryptedSecrets: null,
      };
    try {
      const value = JSON.parse(raw) as Partial<PersistedAlertSettings>;
      if (value.version !== 1 || !isRecord(value.preferences)) throw new Error('Invalid settings');
      return {
        version: 1,
        preferences: mergePreferences(value.preferences),
        encryptedSecrets:
          typeof value.encryptedSecrets === 'string' ? value.encryptedSecrets : null,
      };
    } catch {
      throw new Error('Saved alert settings could not be read');
    }
  }

  private handleSnapshot(snapshot: UpsSnapshot, events: AlertEvent[], hostId: string): void {
    if (
      hostId === 'demo' ||
      this.collector.sourceHealthById(hostId)?.sourceType === 'demo' ||
      this.deletedDeviceIds.has(snapshot.deviceId)
    ) {
      return;
    }
    const firstFreshSnapshot =
      snapshot.freshness === 'fresh' && this.startupDeviceIds.delete(snapshot.deviceId);
    const rules = this.preferences.rules;
    const notifications = new Map<string, { message: string; eventType: string }>();
    for (const event of events) {
      if (firstFreshSnapshot && event.type === 'connection-restored') {
        if (rules.connectionRestored) {
          this.recordHistory({
            occurredAt: new Date().toISOString(),
            deviceId: snapshot.deviceId,
            deviceName: snapshot.deviceName,
            eventType: event.type,
            title: 'UPS connection restored',
            message: `${snapshot.deviceName}: ${event.detail}`,
            status: 'suppressed',
            detail: 'Startup recovery notifications are suppressed.',
            channels: [],
          });
        }
        continue;
      }
      const title = eventTitle(event.type, rules);
      if (!title) continue;
      if (notifications.has(title)) {
        this.recordHistory({
          occurredAt: new Date().toISOString(),
          deviceId: snapshot.deviceId,
          deviceName: snapshot.deviceName,
          eventType: event.type,
          title,
          message: `${snapshot.deviceName}: ${event.detail}`,
          status: 'suppressed',
          detail: 'Duplicate alerts from the same UPS update were merged.',
          channels: [],
        });
        continue;
      }
      notifications.set(title, {
        message: `${snapshot.deviceName}: ${event.detail}`,
        eventType: event.type,
      });
    }
    for (const [title, notification] of notifications) {
      void this.deliver(title, notification.message, {
        eventType: notification.eventType,
        deviceId: snapshot.deviceId,
        deviceName: snapshot.deviceName,
      });
    }

    if (!rules.lowRuntime || snapshot.freshness !== 'fresh' || snapshot.runtimeSeconds === null) {
      return;
    }
    const thresholdSeconds = rules.runtimeThresholdMinutes * 60;
    const belowThreshold = snapshot.runtimeSeconds <= thresholdSeconds;
    const previouslyBelow = this.runtimeBelowThreshold.get(snapshot.deviceId);
    const crossedBelow = belowThreshold && previouslyBelow !== true;
    const recoveredWithMargin =
      previouslyBelow === true && snapshot.runtimeSeconds >= thresholdSeconds + 120;
    this.runtimeBelowThreshold.set(
      snapshot.deviceId,
      recoveredWithMargin ? false : previouslyBelow === true || belowThreshold,
    );
    if (crossedBelow) this.sendLowRuntimeAlert(snapshot, rules.runtimeThresholdMinutes);
  }

  private sendLowRuntimeAlert(snapshot: UpsSnapshot, thresholdMinutes: number): void {
    const runtime = Math.max(0, Math.floor((snapshot.runtimeSeconds ?? 0) / 60));
    void this.deliver(
      'UPS runtime is low',
      `${snapshot.deviceName} reports about ${runtime} minutes remaining, below the configured ${thresholdMinutes}-minute threshold.`,
      { eventType: 'low-runtime', deviceId: snapshot.deviceId, deviceName: snapshot.deviceName },
    );
  }

  private async deliver(
    title: string,
    message: string,
    context: AlertContext,
    onlyChannels?: AlertChannel[],
  ): Promise<AlertHistoryStatus> {
    const attempts: Array<{ channel: AlertChannel; send: () => Promise<void> }> = [];
    if (
      (!onlyChannels || onlyChannels.includes('pushover')) &&
      this.preferences.pushover.enabled &&
      this.pushoverConfigured()
    ) {
      attempts.push({ channel: 'pushover', send: () => this.sendPushover(title, message) });
    }
    if (
      (!onlyChannels || onlyChannels.includes('email')) &&
      this.preferences.email.enabled &&
      this.emailConfigured()
    ) {
      attempts.push({ channel: 'email', send: () => this.sendEmail(title, message) });
    }

    const results: AlertHistoryChannelResult[] = await Promise.all(
      attempts.map(async ({ channel, send }): Promise<AlertHistoryChannelResult> => {
        try {
          await send();
          return { channel, status: 'delivered', detail: null };
        } catch (error) {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'Alert delivery failed',
              channel,
              eventType: context.eventType,
            }),
          );
          return {
            channel,
            status: 'failed',
            detail: error instanceof AlertDeliveryError ? error.message : 'Delivery failed',
          };
        }
      }),
    );

    const failed = results.filter((result) => result.status === 'failed').length;
    const status: AlertHistoryStatus =
      attempts.length === 0
        ? 'no-channel'
        : failed === 0
          ? 'delivered'
          : failed === attempts.length
            ? 'failed'
            : 'partially-failed';
    this.recordHistory({
      occurredAt: new Date().toISOString(),
      deviceId: context.deviceId ?? null,
      deviceName: context.deviceName ?? null,
      eventType: context.eventType,
      title,
      message,
      status,
      detail:
        status === 'no-channel'
          ? 'No enabled and configured alert channel was available.'
          : status === 'partially-failed' || status === 'failed'
            ? 'One or more enabled channels could not deliver this alert.'
            : null,
      channels: results,
    });
    return status;
  }

  private recordHistory(input: Parameters<Store['recordAlertHistory']>[0]): void {
    if (input.deviceId && this.deletedDeviceIds.has(input.deviceId)) return;
    try {
      this.store.recordAlertHistory(input);
    } catch {
      console.error(JSON.stringify({ level: 'error', message: 'Alert history write failed' }));
    }
  }

  private async sendPushover(title: string, message: string): Promise<void> {
    const body = new URLSearchParams({
      token: this.secrets.pushoverApiToken,
      user: this.secrets.pushoverUserKey,
      title: title.slice(0, 250),
      message: message.slice(0, 1024),
    });
    let response: Response;
    try {
      response = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AlertDeliveryError('Pushover could not be reached');
    }
    const result = (await response.json().catch(() => null)) as { status?: number } | null;
    if (!response.ok || result?.status !== 1) {
      throw new AlertDeliveryError('Pushover rejected the notification');
    }
  }

  private async sendEmail(subject: string, text: string): Promise<void> {
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
    } catch {
      throw new AlertDeliveryError('Email could not be delivered');
    } finally {
      transport.close();
    }
  }

  private pushoverConfigured(): boolean {
    return Boolean(this.secrets.pushoverApiToken && this.secrets.pushoverUserKey);
  }

  private emailConfigured(): boolean {
    const email = this.preferences.email;
    return Boolean(
      email.host &&
      email.from &&
      email.to &&
      (!this.secrets.emailUsername || this.secrets.emailPassword),
    );
  }
}

function parseSettingsInput(value: unknown): AlertSettingsInput {
  if (
    !isRecord(value) ||
    !isRecord(value['rules']) ||
    !isRecord(value['pushover']) ||
    !isRecord(value['email'])
  ) {
    throw new AlertConfigurationError('Alert settings are incomplete');
  }
  const rules = value['rules'];
  const pushover = value['pushover'];
  const email = value['email'];
  const parsed: AlertSettingsInput = {
    rules: {
      onBattery: booleanValue(rules['onBattery'], 'onBattery'),
      powerRestored: booleanValue(rules['powerRestored'], 'powerRestored'),
      lowBattery: booleanValue(rules['lowBattery'], 'lowBattery'),
      lowBatteryRestored: booleanValue(rules['lowBatteryRestored'], 'lowBatteryRestored'),
      lowRuntime: booleanValue(rules['lowRuntime'], 'lowRuntime'),
      runtimeThresholdMinutes: integerValue(
        rules['runtimeThresholdMinutes'],
        1,
        1440,
        'Runtime threshold',
      ),
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
  if (parsed.pushover.apiToken.trim()) parsed.pushover.apiToken = parsed.pushover.apiToken.trim();
  if (parsed.pushover.userKey.trim()) parsed.pushover.userKey = parsed.pushover.userKey.trim();
  return parsed;
}

function validateConfiguredChannels(preferences: AlertPreferences, secrets: AlertSecrets): void {
  const pushover = preferences.pushover;
  if (pushover.enabled && !(secrets.pushoverApiToken && secrets.pushoverUserKey)) {
    throw new AlertConfigurationError('Pushover needs both an API token and a user key');
  }
  const email = preferences.email;
  if (email.enabled && !(email.host && validEmail(email.from) && validEmail(email.to))) {
    throw new AlertConfigurationError(
      'Email needs an SMTP host, sender address and recipient address',
    );
  }
  if (Boolean(secrets.emailUsername) !== Boolean(secrets.emailPassword)) {
    throw new AlertConfigurationError('SMTP username and password must be provided together');
  }
  if (email.host && /[\s/@?#]/.test(email.host)) {
    throw new AlertConfigurationError('SMTP host must be a host name or IP address');
  }
}

function eventTitle(type: string, rules: AlertRules): string | null {
  if (type === 'on-battery' && rules.onBattery) return 'UPS switched to battery power';
  if (type === 'mains-restored' && rules.powerRestored) return 'Utility power restored';
  if (type === 'low-battery' && rules.lowBattery) return 'UPS reports low battery';
  if (type === 'battery-normal' && rules.lowBatteryRestored) return 'Low-battery warning cleared';
  if (type === 'connection-lost' && rules.connectionLost) return 'UPS connection lost';
  if (type === 'connection-restored' && rules.connectionRestored) return 'UPS connection restored';
  return null;
}

function mergePreferences(value: Record<string, unknown>): AlertPreferences {
  const defaults = structuredClone(DEFAULT_PREFERENCES);
  const rules = isRecord(value['rules']) ? value['rules'] : {};
  const pushover = isRecord(value['pushover']) ? value['pushover'] : {};
  const email = isRecord(value['email']) ? value['email'] : {};
  return {
    rules: {
      onBattery:
        typeof rules['onBattery'] === 'boolean' ? rules['onBattery'] : defaults.rules.onBattery,
      powerRestored:
        typeof rules['powerRestored'] === 'boolean'
          ? rules['powerRestored']
          : defaults.rules.powerRestored,
      lowBattery:
        typeof rules['lowBattery'] === 'boolean' ? rules['lowBattery'] : defaults.rules.lowBattery,
      lowBatteryRestored:
        typeof rules['lowBatteryRestored'] === 'boolean'
          ? rules['lowBatteryRestored']
          : defaults.rules.lowBatteryRestored,
      lowRuntime:
        typeof rules['lowRuntime'] === 'boolean' ? rules['lowRuntime'] : defaults.rules.lowRuntime,
      runtimeThresholdMinutes:
        typeof rules['runtimeThresholdMinutes'] === 'number'
          ? rules['runtimeThresholdMinutes']
          : defaults.rules.runtimeThresholdMinutes,
      connectionLost:
        typeof rules['connectionLost'] === 'boolean'
          ? rules['connectionLost']
          : defaults.rules.connectionLost,
      connectionRestored:
        typeof rules['connectionRestored'] === 'boolean'
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

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean')
    throw new AlertConfigurationError(`${label} must be true or false`);
  return value;
}

function stringValue(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new AlertConfigurationError(`${label} is invalid`);
  }
  return value;
}

function integerValue(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AlertConfigurationError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
