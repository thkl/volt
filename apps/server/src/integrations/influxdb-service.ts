import type { HostManager } from '../collector/host-manager.js';
import type { UpsSnapshot } from '../domain/models.js';
import { decryptCredentials, encryptCredentials } from '../security/credentials.js';
import type { Store } from '../storage/store.js';

export interface InfluxDbSettingsInput {
  enabled: boolean;
  url: string;
  org: string;
  bucket: string;
  measurement: string;
  token: string;
  clearToken: boolean;
}

interface InfluxPreferences {
  enabled: boolean;
  url: string;
  org: string;
  bucket: string;
  measurement: string;
}

interface PersistedInfluxSettings {
  version: 1;
  preferences: InfluxPreferences;
  encryptedToken: string | null;
}

export type InfluxDeliveryStatus =
  'disabled' | 'not-configured' | 'waiting' | 'connected' | 'error';

export interface InfluxDbSettingsView extends InfluxPreferences {
  configured: boolean;
  tokenConfigured: boolean;
  status: InfluxDeliveryStatus;
  lastWriteAt: string | null;
  lastError: string | null;
}

interface InfluxEvent {
  type: string;
  detail: string;
}

const SETTINGS_KEY = 'influxdb';
const DEFAULT_PREFERENCES: InfluxPreferences = {
  enabled: false,
  url: '',
  org: '',
  bucket: '',
  measurement: 'volt_ups',
};

export class InfluxConfigurationError extends Error {}
export class InfluxDeliveryError extends Error {}

export class InfluxDbService {
  private preferences: InfluxPreferences;
  private token: string;
  private lastWriteAt: string | null = null;
  private lastError: string | null = null;
  private readonly onSnapshot = (snapshot: UpsSnapshot, _events: InfluxEvent[], hostId: string) => {
    void this.writeSnapshot(snapshot, hostId);
  };

  constructor(
    private readonly store: Store,
    private readonly credentialKey: string,
    private readonly collector: HostManager,
  ) {
    try {
      const persisted = this.readPersistedSettings();
      this.preferences = persisted.preferences;
      this.token = persisted.encryptedToken
        ? (decryptCredentials(persisted.encryptedToken, credentialKey)['token'] ?? '')
        : '';
    } catch {
      this.preferences = structuredClone(DEFAULT_PREFERENCES);
      this.token = '';
      this.lastError = 'Saved InfluxDB settings or token could not be read';
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Saved InfluxDB settings could not be loaded; integration is disabled',
        }),
      );
    }
    collector.on('snapshot', this.onSnapshot);
  }

  close(): void {
    this.collector.off('snapshot', this.onSnapshot);
  }

  getSettings(): InfluxDbSettingsView {
    const tokenConfigured = Boolean(this.token);
    const configured = Boolean(
      this.preferences.url &&
      this.preferences.org &&
      this.preferences.bucket &&
      this.preferences.measurement &&
      tokenConfigured,
    );
    const status: InfluxDeliveryStatus = this.lastError
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

  saveSettings(input: unknown): InfluxDbSettingsView {
    const parsed = parseSettingsInput(input);
    const nextToken = parsed.clearToken ? '' : parsed.token || this.token;
    const nextPreferences: InfluxPreferences = {
      enabled: parsed.enabled,
      url: parsed.url ? normalizeBaseUrl(parsed.url) : '',
      org: parsed.org,
      bucket: parsed.bucket,
      measurement: parsed.measurement,
    };
    if (
      nextPreferences.enabled &&
      (!nextPreferences.url ||
        !nextPreferences.org ||
        !nextPreferences.bucket ||
        !nextPreferences.measurement ||
        !nextToken)
    ) {
      throw new InfluxConfigurationError(
        'Enter the InfluxDB URL, organization, bucket, measurement, and token before enabling writes',
      );
    }

    const persisted: PersistedInfluxSettings = {
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

  async sendTestWrite(): Promise<void> {
    if (!this.preferences.enabled || !this.isConfigured()) {
      throw new InfluxConfigurationError(
        'Enable and configure InfluxDB before sending a test write',
      );
    }
    const timestamp = Date.now();
    const line = `${escapeMeasurement(this.preferences.measurement)},source=volt-test test_write=true ${timestamp}`;
    try {
      await this.writeLine(line);
      this.noteSuccess();
    } catch (error) {
      this.noteFailure(error);
      throw error;
    }
  }

  private readPersistedSettings(): PersistedInfluxSettings {
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw) {
      return {
        version: 1,
        preferences: structuredClone(DEFAULT_PREFERENCES),
        encryptedToken: null,
      };
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['preferences'])) {
        throw new Error('Invalid settings');
      }
      return {
        version: 1,
        preferences: mergePreferences(value['preferences']),
        encryptedToken:
          typeof value['encryptedToken'] === 'string' ? value['encryptedToken'] : null,
      };
    } catch {
      throw new Error('Saved InfluxDB settings could not be read');
    }
  }

  private async writeSnapshot(snapshot: UpsSnapshot, hostId: string): Promise<void> {
    if (
      hostId === 'demo' ||
      snapshot.freshness !== 'fresh' ||
      !this.preferences.enabled ||
      !this.isConfigured()
    ) {
      return;
    }
    const line = snapshotLine(snapshot, hostId, this.preferences.measurement);
    if (!line) return;
    try {
      await this.writeLine(line);
      this.noteSuccess();
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private async writeLine(line: string): Promise<void> {
    const target = new URL(`${this.preferences.url}/api/v2/write`);
    target.searchParams.set('org', this.preferences.org);
    target.searchParams.set('bucket', this.preferences.bucket);
    target.searchParams.set('precision', 'ms');

    let response: Response;
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
    } catch {
      throw new InfluxDeliveryError('InfluxDB could not be reached or timed out');
    }
    if (!response.ok) {
      throw new InfluxDeliveryError(`InfluxDB rejected a write (HTTP ${response.status})`);
    }
  }

  private isConfigured(): boolean {
    return Boolean(
      this.preferences.url &&
      this.preferences.org &&
      this.preferences.bucket &&
      this.preferences.measurement &&
      this.token,
    );
  }

  private noteSuccess(): void {
    const recovered = this.lastError !== null;
    this.lastWriteAt = new Date().toISOString();
    this.lastError = null;
    if (recovered) {
      console.info(JSON.stringify({ level: 'info', message: 'InfluxDB writes recovered' }));
    }
  }

  private noteFailure(error: unknown): void {
    const message =
      error instanceof InfluxDeliveryError ? error.message : 'InfluxDB write failed unexpectedly';
    if (this.lastError === message) return;
    this.lastError = message;
    console.error(
      JSON.stringify({ level: 'error', message: 'InfluxDB write failed', detail: message }),
    );
  }
}

function parseSettingsInput(value: unknown): InfluxDbSettingsInput {
  if (
    !isRecord(value) ||
    typeof value['enabled'] !== 'boolean' ||
    typeof value['url'] !== 'string' ||
    typeof value['org'] !== 'string' ||
    typeof value['bucket'] !== 'string' ||
    typeof value['measurement'] !== 'string' ||
    typeof value['token'] !== 'string' ||
    typeof value['clearToken'] !== 'boolean'
  ) {
    throw new InfluxConfigurationError('InfluxDB settings are invalid');
  }
  const result: InfluxDbSettingsInput = {
    enabled: value['enabled'],
    url: value['url'].trim(),
    org: value['org'].trim(),
    bucket: value['bucket'].trim(),
    measurement: value['measurement'].trim(),
    token: value['token'].trim(),
    clearToken: value['clearToken'],
  };
  if (
    result.url.length > 2048 ||
    result.org.length > 255 ||
    result.bucket.length > 255 ||
    result.measurement.length > 128 ||
    result.token.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(result.measurement)
  ) {
    throw new InfluxConfigurationError('InfluxDB settings exceed the allowed length');
  }
  return result;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InfluxConfigurationError('Enter a valid InfluxDB server URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new InfluxConfigurationError(
      'InfluxDB URL must use HTTP or HTTPS without embedded credentials, query parameters, or fragments',
    );
  }
  return url.href.replace(/\/+$/, '');
}

function snapshotLine(snapshot: UpsSnapshot, hostId: string, measurement: string): string | null {
  const tags = [
    ['host_id', hostId],
    ['device_id', snapshot.deviceId],
    ['device_name', snapshot.deviceName],
    ['model', snapshot.model],
  ]
    .map(([key, value]) => `${key}=${escapeTag(value ?? '')}`)
    .join(',');
  const fields: string[] = [];
  const numericFields: Array<[string, number | null]> = [
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
    if (value !== null && Number.isFinite(value)) fields.push(`${key}=${value}`);
  }
  fields.push(
    `low_battery=${snapshot.lowBattery}`,
    `charging=${snapshot.charging}`,
    `power_estimated=${snapshot.powerEstimated}`,
    `flow=${escapeStringField(snapshot.flow)}`,
    `freshness=${escapeStringField(snapshot.freshness)}`,
    `status=${escapeStringField(snapshot.status)}`,
    `status_tokens=${escapeStringField(snapshot.statusTokens.join(','))}`,
  );
  if (snapshot.alarm) fields.push(`alarm=${escapeStringField(snapshot.alarm)}`);
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAt)) return null;
  return `${escapeMeasurement(measurement)},${tags} ${fields.join(',')} ${observedAt}`;
}

function escapeMeasurement(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(',', '\\,').replaceAll(' ', '\\ ');
}

function escapeTag(value: string): string {
  return escapeMeasurement(value.replace(/[\u0000-\u001f\u007f]/g, ' ')).replaceAll('=', '\\=');
}

function escapeStringField(value: string): string {
  return JSON.stringify(value);
}

function mergePreferences(value: Record<string, unknown>): InfluxPreferences {
  return {
    enabled: value['enabled'] === true,
    url: typeof value['url'] === 'string' ? value['url'] : '',
    org: typeof value['org'] === 'string' ? value['org'] : '',
    bucket: typeof value['bucket'] === 'string' ? value['bucket'] : '',
    measurement:
      typeof value['measurement'] === 'string' && value['measurement'].trim()
        ? value['measurement']
        : DEFAULT_PREFERENCES.measurement,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
