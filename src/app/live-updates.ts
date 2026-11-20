import { Injectable, inject } from '@angular/core';
import { DemoEvent, DemoScenario, UpsSnapshot } from './demo-data';
import { BackendHost, BackendMode, DemoState, SourceDiagnostic } from './demo-state';

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

interface BackendEvent {
  id: number;
  deviceId: string;
  deviceName: string;
  occurredAt: string;
  type: string;
  detail: string;
  tone: DemoEvent['tone'];
}

export interface BackendHistoryPoint {
  observedAt: string;
  value: number;
  minimum: number;
  maximum: number;
}

export interface BackendHistory {
  from: string;
  to: string;
  bucketMs: number;
  series: Partial<Record<'realPower' | 'loadPercent' | 'inputVoltage', BackendHistoryPoint[]>>;
}

@Injectable({ providedIn: 'root' })
export class LiveUpdates {
  private readonly state = inject(DemoState);
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private reconnectAttempts = 0;
  private stopped = false;

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

  async removeHost(id: string): Promise<void> {
    await this.hostRequest(`/api/hosts/${encodeURIComponent(id)}`, 'DELETE');
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
      for (const device of devices) {
        if (device.snapshot) this.state.setBackendSnapshot(normalizeSnapshot(device.snapshot));
      }
      if (mode !== 'demo' && mode !== 'none') void this.refreshEvents();
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
      for (const device of devices) {
        if (device.snapshot) this.state.setBackendSnapshot(normalizeSnapshot(device.snapshot));
      }
      if (mode !== 'demo' && mode !== 'none') void this.refreshEvents();
      return;
    }

    if (message['type'] === 'snapshot') {
      if (typeof message['scenario'] === 'string') {
        this.state.setScenarioFromBackend(message['scenario']);
      }
      const snapshot = message['data'] as BackendSnapshot | undefined;
      if (!snapshot || typeof snapshot.deviceId !== 'string') return;
      this.state.setBackendSnapshot(normalizeSnapshot(snapshot));
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
      if (
        Array.isArray(events) &&
        events.length > 0 &&
        this.state.backendMode() !== 'demo' &&
        this.state.backendMode() !== 'none'
      ) {
        void this.refreshEvents();
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

  private async refreshEvents(): Promise<void> {
    try {
      const response = await fetch('/api/events?limit=100');
      if (!response.ok) return;
      const payload = (await response.json()) as { data?: BackendEvent[] };
      this.state.setBackendEvents((payload.data ?? []).map(normalizeEvent));
    } catch {
      // The live snapshot stream remains useful while an event refresh is retried later.
    }
  }

  private async mutateHost(
    path: string,
    method: 'POST' | 'PUT',
    host: NutHostForm,
  ): Promise<BackendHost> {
    const response = await this.hostRequest<{ data?: BackendHost }>(path, method, host);
    if (!response.data) throw new Error('The server did not return the saved host');
    return response.data;
  }

  private async hostRequest<T = { data?: unknown }>(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: NutHostForm,
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

export interface NutHostForm {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  clearCredentials: boolean;
}

function normalizeMode(value: unknown): Exclude<BackendMode, null> {
  return value === 'nut' || value === 'multi' || value === 'none' || value === 'demo'
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

function normalizeEvent(event: BackendEvent): DemoEvent {
  const occurredAt = new Date(event.occurredAt);
  return {
    id: event.id,
    deviceId: event.deviceId,
    time: Number.isNaN(occurredAt.valueOf())
      ? 'Time unavailable'
      : occurredAt.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
    device: event.deviceName,
    type: event.type
      .split('-')
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(' '),
    detail: event.detail,
    tone: event.tone,
  };
}
