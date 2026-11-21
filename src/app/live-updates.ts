import { Injectable, inject, signal } from '@angular/core';
import { DemoScenario, UpsSnapshot } from './demo-data';
import { BackendHost, BackendMode, DemoState, SourceDiagnostic } from './demo-state';
import type { OutageRange, OutageSummary } from './outage-models';
import type {
  ShutdownReadinessPlan,
  ShutdownReadinessPlanInput,
} from './shutdown-readiness-models';

interface BackendDevice {
  id: string;
  name: string;
  model: string;
  hostId: string;
  hostName: string;
  description?: string;
  snapshot: BackendSnapshot | null;
}

interface BackendSnapshot {
  deviceId: string;
  deviceName: string;
  model: string;
  manufacturer: string;
  flow: UpsSnapshot['flow'];
  freshness: 'fresh' | 'stale' | 'unavailable';
  status: string;
  statusTokens: string[];
  lowBattery: boolean;
  charging: boolean;
  batteryCharge: number | null;
  runtimeSeconds: number | null;
  loadPercent: number | null;
  realPower: number | null;
  powerEstimated: boolean;
  apparentPower: number | null;
  ratedRealPower: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  inputFrequency: number | null;
  outputFrequency: number | null;
  batteryVoltage: number | null;
  temperature: number | null;
  alarm: string | null;
  observedAt: string;
  rawVariables: Record<string, string>;
}

export interface IncidentEvent {
  id: number;
  deviceId: string;
  deviceName: string;
  occurredAt: string;
  type: string;
  detail: string;
  tone: 'good' | 'warning' | 'critical' | 'neutral';
}

export interface IncidentPage {
  data: IncidentEvent[];
  nextCursor: string | null;
}

export interface BackendHistoryPoint {
  observedAt: string;
  value: number;
  minimum: number;
  maximum: number;
}

export interface BackendHistory {
  deviceId: string;
  range: '1h' | '24h' | '7d' | '30d';
  from: string;
  to: string;
  bucketMs: number;
  series: Partial<Record<'realPower' | 'loadPercent' | 'inputVoltage', BackendHistoryPoint[]>>;
}

export interface BackendHistoryReading {
  observedAt: string;
  realPower: number | null;
  loadPercent: number | null;
  inputVoltage: number | null;
}

export interface AlertSettings {
  rules: {
    onBattery: boolean;
    powerRestored: boolean;
    lowBattery: boolean;
    lowBatteryRestored: boolean;
    lowRuntime: boolean;
    runtimeThresholdMinutes: number;
    connectionLost: boolean;
    connectionRestored: boolean;
  };
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

export interface AlertSettingsForm {
  rules: AlertSettings['rules'];
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

export interface InfluxDbSettings {
  enabled: boolean;
  url: string;
  org: string;
  bucket: string;
  measurement: string;
  configured: boolean;
  tokenConfigured: boolean;
  status: 'disabled' | 'not-configured' | 'waiting' | 'connected' | 'error';
  lastWriteAt: string | null;
  lastError: string | null;
}

export interface InfluxDbSettingsForm {
  enabled: boolean;
  url: string;
  org: string;
  bucket: string;
  measurement: string;
  token: string;
  clearToken: boolean;
}

export interface EnergyImpactSettings {
  pricePerKwh: number | null;
  currency: string;
  carbonIntensityGramsPerKwh: number | null;
}

export interface EnergyPeriodImpact {
  energyKwh: number | null;
  estimatedEnergyKwh: number;
  cost: number | null;
  co2Kg: number | null;
  coveragePercent: number;
}

export interface EnergyImpact extends EnergyImpactSettings {
  deviceId: string;
  timeZone: string;
  maxGapSeconds: number;
  periods: {
    lastHour: EnergyPeriodImpact;
    last24Hours: EnergyPeriodImpact;
    last30Days: EnergyPeriodImpact;
  };
  dayparts: Array<
    EnergyPeriodImpact & {
      id: 'night' | 'morning' | 'afternoon' | 'evening';
      label: string;
      hours: string;
    }
  >;
  dailyTrend: Array<EnergyPeriodImpact & { date: string }>;
}

export interface VoltInternals {
  uptimeMs: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  database: {
    fileBacked: boolean;
    sizeBytes: number;
    records: {
      total: number;
      hosts: number;
      devices: number;
      samples: number;
      events: number;
      appSettings: number;
      schemaMigrations: number;
    };
  };
  collectedAt: string;
}

@Injectable({ providedIn: 'root' })
export class LiveUpdates {
  private readonly state = inject(DemoState);
  readonly outageRevision = signal(0);
  readonly eventRevision = signal(0);
  readonly energyImpactRevision = signal(0);
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private reconnectAttempts = 0;
  private stopped = false;
  private readonly latestHistoryReadings = signal<Record<string, BackendHistoryReading>>({});

  getLatestHistoryReading(deviceId: string): BackendHistoryReading | null {
    return this.latestHistoryReadings()[deviceId] ?? null;
  }

  connect(): void {
    if (this.stopped || typeof WebSocket === 'undefined') return;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.state.setApiConnected(true);
    });
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.state.setApiConnected(false);
        this.socket = null;
        this.scheduleReconnect();
      }
    });
  }

  pause(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = null;
    this.state.setApiConnected(false);
    socket?.close(1000, 'Authentication required');
  }

  resume(): void {
    this.stopped = false;
    this.connect();
  }

  async selectScenario(value: string): Promise<void> {
    if (this.state.backendMode() !== 'demo' || !this.state.apiConnected()) return;
    if (!this.state.scenarios.some((scenario) => scenario.id === value)) return;
    try {
      await fetch('/api/demo/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: value as DemoScenario }),
      });
    } catch {
      // The WebSocket reconnect loop reports a lost API connection.
    }
  }

  async createNutHost(host: NutHostForm): Promise<BackendHost> {
    return this.mutateHost('/api/hosts', 'POST', host);
  }

  async updateNutHost(id: string, host: NutHostForm): Promise<BackendHost> {
    return this.mutateHost(`/api/hosts/${encodeURIComponent(id)}`, 'PUT', host);
  }

  async createHomeAssistantHost(host: HomeAssistantHostForm): Promise<BackendHost> {
    return this.mutateHost('/api/hosts', 'POST', { ...host, sourceType: 'homeassistant' });
  }

  async updateHomeAssistantHost(id: string, host: HomeAssistantHostForm): Promise<BackendHost> {
    return this.mutateHost(`/api/hosts/${encodeURIComponent(id)}`, 'PUT', {
      ...host,
      sourceType: 'homeassistant',
    });
  }

  async removeHost(id: string): Promise<void> {
    await this.hostRequest(`/api/hosts/${encodeURIComponent(id)}`, 'DELETE');
  }

  async addDemoUps(): Promise<BackendHost> {
    return this.mutateHost('/api/demo/ups', 'POST', {});
  }

  async getHistory(
    deviceId: string,
    range: '1h' | '24h' | '7d' | '30d',
  ): Promise<BackendHistory | null> {
    try {
      const response = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/history?range=${range}&metrics=realPower,loadPercent,inputVoltage`,
      );
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: BackendHistory };
      return payload.data ?? null;
    } catch {
      return null;
    }
  }

  async getOutageSummary(deviceId: string, range: OutageRange): Promise<OutageSummary | null> {
    try {
      const response = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/outages?range=${range}`,
      );
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: OutageSummary };
      return payload.data ?? null;
    } catch {
      return null;
    }
  }

  async getIncidentPage(
    options: {
      deviceId?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<IncidentPage> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.deviceId) query.set('device', options.deviceId);
    if (options.cursor) query.set('cursor', options.cursor);

    const response = await fetch(`/api/events?${query}`);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(responseError(payload, 'Incident history could not be loaded'));
    if (!isRecord(payload) || !Array.isArray(payload['data'])) {
      throw new Error('The server returned invalid incident history');
    }
    const nextCursor = payload['nextCursor'];
    if (nextCursor !== null && typeof nextCursor !== 'string') {
      throw new Error('The server returned an invalid incident cursor');
    }
    return {
      data: payload['data'].map(parseIncidentEvent),
      nextCursor,
    };
  }

  async getShutdownReadinessPlans(): Promise<ShutdownReadinessPlan[]> {
    const response = await fetch('/api/shutdown-readiness');
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(responseError(payload, 'Shutdown readiness could not be loaded'));
    }
    if (!isRecord(payload) || !Array.isArray(payload['data'])) {
      throw new Error('The server returned invalid shutdown readiness data');
    }
    return payload['data'].map(parseShutdownReadinessPlan);
  }

  async saveShutdownReadinessPlan(
    deviceId: string,
    plan: ShutdownReadinessPlanInput,
  ): Promise<ShutdownReadinessPlan> {
    const response = await fetch(`/api/shutdown-readiness/${encodeURIComponent(deviceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(responseError(payload, 'Shutdown readiness could not be saved'));
    }
    if (!isRecord(payload) || !isRecord(payload['data'])) {
      throw new Error('The server returned invalid shutdown readiness data');
    }
    return parseShutdownReadinessPlan(payload['data']);
  }

  async getAlertSettings(): Promise<AlertSettings> {
    const response = await fetch('/api/alerts/settings');
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(responseError(payload, 'Alert settings could not be loaded'));
    if (!isRecord(payload) || !isAlertSettings(payload['data'])) {
      throw new Error('The server returned invalid alert settings');
    }
    return payload['data'];
  }

  async getVoltInternals(): Promise<VoltInternals | null> {
    try {
      const response = await fetch('/api/diagnostics/internals');
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (!isRecord(payload)) return null;
      return parseVoltInternals(payload['data']);
    } catch {
      return null;
    }
  }

  async saveAlertSettings(settings: AlertSettingsForm): Promise<AlertSettings> {
    const response = await fetch('/api/alerts/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(responseError(payload, 'Alert settings could not be saved'));
    if (!isRecord(payload) || !isAlertSettings(payload['data'])) {
      throw new Error('The server returned invalid alert settings');
    }
    return payload['data'];
  }

  async sendAlertTest(channel: 'pushover' | 'email'): Promise<void> {
    const response = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    });
    if (response.ok) return;
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(responseError(payload, 'The test alert could not be delivered'));
  }

  async getInfluxDbSettings(): Promise<InfluxDbSettings> {
    const response = await fetch('/api/integrations/influxdb/settings');
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(responseError(payload, 'InfluxDB settings could not be loaded'));
    }
    if (!isRecord(payload) || !isInfluxDbSettings(payload['data'])) {
      throw new Error('The server returned invalid InfluxDB settings');
    }
    return payload['data'];
  }

  async saveInfluxDbSettings(settings: InfluxDbSettingsForm): Promise<InfluxDbSettings> {
    const response = await fetch('/api/integrations/influxdb/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(responseError(payload, 'InfluxDB settings could not be saved'));
    }
    if (!isRecord(payload) || !isInfluxDbSettings(payload['data'])) {
      throw new Error('The server returned invalid InfluxDB settings');
    }
    return payload['data'];
  }

  async sendInfluxDbTestWrite(): Promise<void> {
    const response = await fetch('/api/integrations/influxdb/test', { method: 'POST' });
    if (response.ok) return;
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(responseError(payload, 'The InfluxDB test write failed'));
  }

  async getEnergyImpactSettings(): Promise<EnergyImpactSettings> {
    const response = await fetch('/api/energy-impact/settings');
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(responseError(payload, 'Energy settings could not be loaded'));
    }
    if (!isRecord(payload) || !isEnergyImpactSettings(payload['data'])) {
      throw new Error('The server returned invalid energy settings');
    }
    return payload['data'];
  }

  async saveEnergyImpactSettings(settings: EnergyImpactSettings): Promise<EnergyImpactSettings> {
    const response = await fetch('/api/energy-impact/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(responseError(payload, 'Energy settings could not be saved'));
    }
    if (!isRecord(payload) || !isEnergyImpactSettings(payload['data'])) {
      throw new Error('The server returned invalid energy settings');
    }
    this.energyImpactRevision.update((revision) => revision + 1);
    return payload['data'];
  }

  async getEnergyImpact(deviceId: string): Promise<EnergyImpact> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const query = new URLSearchParams({ timeZone });
    const response = await fetch(
      `/api/devices/${encodeURIComponent(deviceId)}/energy-impact?${query}`,
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(responseError(payload, 'Energy impact could not be loaded'));
    }
    if (!isRecord(payload) || !isEnergyImpact(payload['data'])) {
      throw new Error('The server returned invalid energy impact data');
    }
    return payload['data'];
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message['type'] === 'initial') {
      const devices = Array.isArray(message['devices'])
        ? (message['devices'] as BackendDevice[])
        : [];
      const mode = normalizeMode(message['mode']);
      const scenario = typeof message['scenario'] === 'string' ? message['scenario'] : null;
      this.state.setBackendInitial(
        mode,
        devices.map(({ id, name, model, hostId, hostName }) => ({
          id,
          name,
          model,
          hostId,
          hostName,
        })),
        normalizeHosts(message['hosts']),
        normalizeSourceHealth(message['sources']),
        scenario,
      );
      this.retainHistoryReadings(devices);
      for (const device of devices) {
        if (device.snapshot) {
          this.state.setBackendSnapshot(normalizeSnapshot(device.snapshot));
          this.recordHistoryReading(device.snapshot);
        }
      }
      return;
    }

    if (message['type'] === 'hosts') {
      const devices = Array.isArray(message['devices'])
        ? (message['devices'] as BackendDevice[])
        : [];
      const mode = normalizeMode(message['mode']);
      this.state.setBackendHosts(
        mode,
        devices.map(({ id, name, model, hostId, hostName }) => ({
          id,
          name,
          model,
          hostId,
          hostName,
        })),
        normalizeHosts(message['hosts']),
        normalizeSourceHealth(message['sources']),
        typeof message['scenario'] === 'string' ? message['scenario'] : null,
      );
      this.retainHistoryReadings(devices);
      for (const device of devices) {
        if (device.snapshot) {
          this.state.setBackendSnapshot(normalizeSnapshot(device.snapshot));
          this.recordHistoryReading(device.snapshot);
        }
      }
      return;
    }

    if (message['type'] === 'snapshot') {
      if (typeof message['scenario'] === 'string') {
        this.state.setScenarioFromBackend(message['scenario']);
      }
      const snapshot = message['data'] as BackendSnapshot | undefined;
      if (!snapshot || typeof snapshot.deviceId !== 'string') return;
      this.state.setBackendSnapshot(normalizeSnapshot(snapshot));
      this.recordHistoryReading(snapshot);
      const device = message['device'] as BackendDevice | null | undefined;
      if (device) {
        this.state.setBackendDevice({
          id: device.id,
          name: device.name,
          model: device.model,
          hostId: device.hostId,
          hostName: device.hostName,
        });
      }
      const events = message['events'];
      if (Array.isArray(events) && events.length > 0) {
        this.eventRevision.update((revision) => revision + 1);
      }
      if (
        Array.isArray(events) &&
        events.some(
          (event) =>
            isRecord(event) &&
            ['on-battery', 'mains-restored', 'connection-lost', 'connection-restored'].includes(
              String(event['type']),
            ),
        )
      ) {
        this.outageRevision.update((revision) => revision + 1);
      }
      return;
    }

    if (message['type'] === 'heartbeat') this.state.setApiConnected(true);
    if (message['type'] === 'health' || message['type'] === 'heartbeat') {
      const collector = message['collector'];
      if (isRecord(collector) && collector['mode']) {
        this.state.setBackendHealth(
          normalizeMode(collector['mode']),
          normalizeSourceHealth(message['sources']),
        );
      }
    }
  }

  private retainHistoryReadings(devices: BackendDevice[]): void {
    const activeDeviceIds = new Set(devices.map((device) => device.id));
    this.latestHistoryReadings.update((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => activeDeviceIds.has(id))),
    );
  }

  private recordHistoryReading(snapshot: BackendSnapshot): void {
    if (snapshot.freshness !== 'fresh' || !Number.isFinite(Date.parse(snapshot.observedAt))) return;
    this.latestHistoryReadings.update((current) => ({
      ...current,
      [snapshot.deviceId]: {
        observedAt: snapshot.observedAt,
        realPower: snapshot.realPower,
        loadPercent: snapshot.loadPercent,
        inputVoltage: snapshot.inputVoltage,
      },
    }));
  }

  private async mutateHost(
    path: string,
    method: 'POST' | 'PUT',
    host: object,
  ): Promise<BackendHost> {
    const response = await this.hostRequest<{ data?: BackendHost }>(path, method, host);
    if (!response.data) throw new Error('The server did not return the saved host');
    return response.data;
  }

  private async hostRequest<T = { data?: unknown }>(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: object,
  ): Promise<T> {
    const response = await fetch(path, {
      method,
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errorMessage =
        isRecord(payload) &&
        isRecord(payload['error']) &&
        typeof payload['error']['message'] === 'string'
          ? payload['error']['message']
          : 'Host settings could not be saved';
      throw new Error(errorMessage);
    }
    return payload as T;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVoltInternals(value: unknown): VoltInternals | null {
  if (!isRecord(value) || !isRecord(value['memory']) || !isRecord(value['database'])) return null;
  const memory = value['memory'];
  const database = value['database'];
  const records = database['records'];
  if (!isRecord(records)) return null;
  const numericValues = [
    value['uptimeMs'],
    memory['rssBytes'],
    memory['heapUsedBytes'],
    memory['heapTotalBytes'],
    memory['externalBytes'],
    database['sizeBytes'],
    records['total'],
    records['hosts'],
    records['devices'],
    records['samples'],
    records['events'],
    records['appSettings'],
    records['schemaMigrations'],
  ];
  if (
    !numericValues.every((item) => typeof item === 'number' && Number.isFinite(item)) ||
    typeof database['fileBacked'] !== 'boolean' ||
    typeof value['collectedAt'] !== 'string'
  ) {
    return null;
  }
  return value as unknown as VoltInternals;
}

function responseError(payload: unknown, fallback: string): string {
  return isRecord(payload) &&
    isRecord(payload['error']) &&
    typeof payload['error']['message'] === 'string'
    ? payload['error']['message']
    : fallback;
}

function parseIncidentEvent(value: unknown): IncidentEvent {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'number' ||
    typeof value['deviceId'] !== 'string' ||
    typeof value['deviceName'] !== 'string' ||
    typeof value['occurredAt'] !== 'string' ||
    typeof value['type'] !== 'string' ||
    typeof value['detail'] !== 'string' ||
    (value['tone'] !== 'good' &&
      value['tone'] !== 'warning' &&
      value['tone'] !== 'critical' &&
      value['tone'] !== 'neutral')
  ) {
    throw new Error('The server returned an invalid incident');
  }
  return value as unknown as IncidentEvent;
}

function parseShutdownReadinessPlan(value: unknown): ShutdownReadinessPlan {
  if (
    !isRecord(value) ||
    typeof value['deviceId'] !== 'string' ||
    !Array.isArray(value['dependentSystems']) ||
    !value['dependentSystems'].every((item) => typeof item === 'string') ||
    (value['coordination'] !== 'unverified' &&
      value['coordination'] !== 'verified' &&
      value['coordination'] !== 'not_configured') ||
    (value['updatedAt'] !== null && typeof value['updatedAt'] !== 'string')
  ) {
    throw new Error('The server returned invalid shutdown readiness data');
  }
  return value as unknown as ShutdownReadinessPlan;
}

function isAlertSettings(value: unknown): value is AlertSettings {
  if (!isRecord(value)) return false;
  const rules = value['rules'];
  const pushover = value['pushover'];
  const email = value['email'];
  if (!isRecord(rules) || !isRecord(pushover) || !isRecord(email)) return false;

  return (
    typeof rules['onBattery'] === 'boolean' &&
    typeof rules['powerRestored'] === 'boolean' &&
    typeof rules['lowBattery'] === 'boolean' &&
    typeof rules['lowBatteryRestored'] === 'boolean' &&
    typeof rules['lowRuntime'] === 'boolean' &&
    typeof rules['runtimeThresholdMinutes'] === 'number' &&
    typeof rules['connectionLost'] === 'boolean' &&
    typeof rules['connectionRestored'] === 'boolean' &&
    typeof pushover['enabled'] === 'boolean' &&
    typeof pushover['configured'] === 'boolean' &&
    typeof email['enabled'] === 'boolean' &&
    typeof email['host'] === 'string' &&
    typeof email['port'] === 'number' &&
    typeof email['secure'] === 'boolean' &&
    typeof email['from'] === 'string' &&
    typeof email['to'] === 'string' &&
    typeof email['configured'] === 'boolean' &&
    typeof email['usernameConfigured'] === 'boolean' &&
    typeof email['credentialsConfigured'] === 'boolean'
  );
}

function isInfluxDbSettings(value: unknown): value is InfluxDbSettings {
  return (
    isRecord(value) &&
    typeof value['enabled'] === 'boolean' &&
    typeof value['url'] === 'string' &&
    typeof value['org'] === 'string' &&
    typeof value['bucket'] === 'string' &&
    typeof value['measurement'] === 'string' &&
    typeof value['configured'] === 'boolean' &&
    typeof value['tokenConfigured'] === 'boolean' &&
    (value['status'] === 'disabled' ||
      value['status'] === 'not-configured' ||
      value['status'] === 'waiting' ||
      value['status'] === 'connected' ||
      value['status'] === 'error') &&
    (value['lastWriteAt'] === null || typeof value['lastWriteAt'] === 'string') &&
    (value['lastError'] === null || typeof value['lastError'] === 'string')
  );
}

function isEnergyImpactSettings(value: unknown): value is EnergyImpactSettings {
  return (
    isRecord(value) &&
    isOptionalNumber(value['pricePerKwh']) &&
    typeof value['currency'] === 'string' &&
    isOptionalNumber(value['carbonIntensityGramsPerKwh'])
  );
}

function isEnergyImpact(value: unknown): value is EnergyImpact {
  return (
    isRecord(value) &&
    typeof value['deviceId'] === 'string' &&
    typeof value['timeZone'] === 'string' &&
    typeof value['currency'] === 'string' &&
    isOptionalNumber(value['pricePerKwh']) &&
    isOptionalNumber(value['carbonIntensityGramsPerKwh']) &&
    typeof value['maxGapSeconds'] === 'number' &&
    isRecord(value['periods']) &&
    isEnergyPeriodImpact(value['periods']['lastHour']) &&
    isEnergyPeriodImpact(value['periods']['last24Hours']) &&
    isEnergyPeriodImpact(value['periods']['last30Days']) &&
    Array.isArray(value['dayparts']) &&
    value['dayparts'].every(
      (item) =>
        isRecord(item) &&
        (item['id'] === 'night' ||
          item['id'] === 'morning' ||
          item['id'] === 'afternoon' ||
          item['id'] === 'evening') &&
        typeof item['label'] === 'string' &&
        typeof item['hours'] === 'string' &&
        isEnergyPeriodImpact(item),
    ) &&
    Array.isArray(value['dailyTrend']) &&
    value['dailyTrend'].every(
      (item) => isRecord(item) && typeof item['date'] === 'string' && isEnergyPeriodImpact(item),
    )
  );
}

function isEnergyPeriodImpact(value: unknown): value is EnergyPeriodImpact {
  return (
    isRecord(value) &&
    isOptionalNumber(value['energyKwh']) &&
    typeof value['estimatedEnergyKwh'] === 'number' &&
    isOptionalNumber(value['cost']) &&
    isOptionalNumber(value['co2Kg']) &&
    typeof value['coveragePercent'] === 'number'
  );
}

function isOptionalNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

export interface NutHostForm {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  clearCredentials: boolean;
}

export const HOME_ASSISTANT_NUMERIC_FIELDS = [
  'batteryCharge',
  'runtimeSeconds',
  'loadPercent',
  'realPower',
  'inputVoltage',
  'outputVoltage',
  'inputFrequency',
  'outputFrequency',
  'batteryVoltage',
  'temperature',
] as const;

export type HomeAssistantNumericField = (typeof HOME_ASSISTANT_NUMERIC_FIELDS)[number];

export interface HomeAssistantMetricForm {
  entityId: string;
  scale: number;
}

export interface HomeAssistantHostForm {
  name: string;
  url: string;
  accessToken: string;
  entities: {
    statusEntityId: string;
    onBatteryEntityId: string;
    chargingEntityId: string;
    lowBatteryEntityId: string;
    metrics: Record<HomeAssistantNumericField, HomeAssistantMetricForm>;
  };
}

function normalizeMode(value: unknown): Exclude<BackendMode, null> {
  return value === 'nut' ||
    value === 'homeassistant' ||
    value === 'multi' ||
    value === 'none' ||
    value === 'demo'
    ? value
    : 'demo';
}

function normalizeHosts(value: unknown): BackendHost[] {
  return Array.isArray(value) ? (value as BackendHost[]) : [];
}

function normalizeSourceHealth(value: unknown): SourceDiagnostic[] {
  return Array.isArray(value) ? (value as SourceDiagnostic[]) : [];
}

function normalizeSnapshot(snapshot: BackendSnapshot): UpsSnapshot {
  return {
    deviceId: snapshot.deviceId,
    deviceName: snapshot.deviceName,
    model: snapshot.model,
    manufacturer: snapshot.manufacturer,
    flow: snapshot.freshness === 'unavailable' ? 'stale' : snapshot.flow,
    status: snapshot.status,
    statusTokens: snapshot.statusTokens,
    lowBattery: snapshot.lowBattery,
    charging: snapshot.charging,
    batteryCharge: snapshot.batteryCharge,
    runtimeSeconds: snapshot.runtimeSeconds,
    loadPercent: snapshot.loadPercent,
    realPower: snapshot.realPower,
    powerEstimated: snapshot.powerEstimated,
    apparentPower: snapshot.apparentPower,
    ratedRealPower: snapshot.ratedRealPower,
    inputVoltage: snapshot.inputVoltage,
    outputVoltage: snapshot.outputVoltage,
    inputFrequency: snapshot.inputFrequency,
    outputFrequency: snapshot.outputFrequency,
    batteryVoltage: snapshot.batteryVoltage,
    temperature: snapshot.temperature,
    alarm: snapshot.alarm,
    observedAt: formatObservedAt(snapshot.observedAt, snapshot.freshness),
    rawVariables: snapshot.rawVariables,
  };
}

function formatObservedAt(value: string, freshness: BackendSnapshot['freshness']): string {
  if (freshness === 'unavailable') return 'No successful reading';
  const observedAt = Date.parse(value);
  if (!Number.isFinite(observedAt)) return 'Time unavailable';
  const minutes = Math.max(0, Math.floor((Date.now() - observedAt) / 60_000));
  if (minutes === 0) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${hours === 1 ? '' : 's'} ago`;
}
