import { Injectable, computed, signal } from '@angular/core';
import { DEMO_DEVICES, DemoScenario, getDemoEvents, getDemoSnapshot } from './demo-data';
import type { DemoDevice, UpsSnapshot } from './demo-data';

export type BackendMode = 'demo' | 'nut' | 'homeassistant' | 'multi' | 'none' | null;

export interface BackendHost {
  id: string;
  name: string;
  sourceType: string;
  endpointConfig: Record<string, unknown>;
  credentialsConfigured: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SourceDiagnostic {
  hostId: string;
  name: string;
  sourceType: string;
  host: string | null;
  port: number | null;
  tls: boolean;
  status: 'ready' | 'degraded';
  connected: boolean;
  phase: string | null;
  discoveredUps: number;
  upsNames: string[];
  lastPollAt: string | null;
  lastDiscoveryAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
}

@Injectable({ providedIn: 'root' })
export class DemoState {
  readonly now = signal(Date.now());
  readonly devices = signal<DemoDevice[]>(DEMO_DEVICES);
  readonly scenarios: Array<{ id: DemoScenario; label: string }> = [
    { id: 'online', label: 'Online · grid' },
    { id: 'charging', label: 'Charging · utility' },
    { id: 'on-battery', label: 'On battery' },
    { id: 'low-battery', label: 'Low battery' },
    { id: 'stale', label: 'Stale data' },
    { id: 'unknown', label: 'Unknown status' },
    { id: 'missing-sensors', label: 'Missing sensors' },
  ];

  readonly scenario = signal<DemoScenario>('online');
  readonly backendMode = signal<BackendMode>(null);
  readonly apiConnected = signal(false);
  readonly hosts = signal<BackendHost[]>([]);
  readonly sourceHealth = signal<SourceDiagnostic[]>([]);
  readonly selectedDeviceId = signal(DEMO_DEVICES[0].id);
  private readonly remoteSnapshots = signal<Record<string, UpsSnapshot>>({});
  readonly isDemo = computed(() => this.backendMode() === null || this.backendMode() === 'demo');
  readonly selectedDevice = computed(
    () =>
      this.devices().find((device) => device.id === this.selectedDeviceId()) ??
      this.devices()[0] ??
      DEMO_DEVICES[0],
  );
  readonly snapshot = computed(() => this.snapshotFor(this.selectedDeviceId()));
  readonly events = computed(() => getDemoEvents(this.scenario(), this.selectedDevice().name));
  readonly statusText = computed(() => {
    if (this.backendMode() === 'none') return 'No source configured';
    if (
      this.backendMode() !== null &&
      this.backendMode() !== 'demo' &&
      this.devices().length === 0
    ) {
      return 'Waiting for UPS data';
    }
    if (this.backendMode() && this.backendMode() !== 'demo' && !this.apiConnected()) {
      return 'Live connection lost';
    }
    const sample = this.snapshot();
    if (sample.flow === 'stale') return 'Data stale';
    if (sample.flow === 'unknown') return 'Status unknown';
    if (sample.lowBattery) return 'Low battery';
    if (sample.flow === 'battery') return 'On battery';
    return 'System online';
  });
  readonly statusTone = computed(() => {
    if (this.backendMode() === 'none') return 'muted';
    if (
      this.backendMode() !== null &&
      this.backendMode() !== 'demo' &&
      this.devices().length === 0
    ) {
      return 'muted';
    }
    if (this.backendMode() && this.backendMode() !== 'demo' && !this.apiConnected()) return 'muted';
    const sample = this.snapshot();
    if (sample.flow === 'stale' || sample.flow === 'unknown') return 'muted';
    if (sample.lowBattery) return 'critical';
    if (sample.flow === 'battery') return 'warning';
    return 'good';
  });

  updateClock(): void {
    this.now.set(Date.now());
  }

  freshnessState(snapshot: UpsSnapshot): 'fresh' | 'stale' | 'unavailable' {
    return snapshot.freshness ?? (snapshot.flow === 'stale' ? 'stale' : 'fresh');
  }

  freshnessLabel(snapshot: UpsSnapshot): string {
    const freshness = this.freshnessState(snapshot);
    if (this.backendMode() !== null && this.backendMode() !== 'demo' && !this.apiConnected()) {
      return 'Feed disconnected';
    }
    if (freshness === 'unavailable') return 'No reading';
    if (freshness === 'stale') return 'Stale data';
    return this.isDemo() ? 'Simulated data' : 'Live data';
  }

  freshnessTone(snapshot: UpsSnapshot): 'good' | 'warning' | 'muted' {
    if (this.backendMode() !== null && this.backendMode() !== 'demo' && !this.apiConnected()) {
      return 'warning';
    }
    const freshness = this.freshnessState(snapshot);
    if (freshness === 'fresh') return 'good';
    return freshness === 'stale' ? 'warning' : 'muted';
  }

  freshnessAge(snapshot: UpsSnapshot): string {
    const observedAt = Date.parse(snapshot.lastObservedAt ?? '');
    if (Number.isFinite(observedAt)) {
      const ageMs = Math.max(0, this.now() - observedAt);
      if (ageMs < 10_000) return 'Updated just now';
      if (ageMs < 60_000) return `Updated ${Math.floor(ageMs / 1000)} sec ago`;
      const minutes = Math.floor(ageMs / 60_000);
      if (minutes < 60) return `Last reading ${minutes} min ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `Last reading ${hours} hr ago`;
      return `Last reading ${Math.floor(hours / 24)} days ago`;
    }
    if (this.freshnessState(snapshot) === 'unavailable') return 'No successful reading';
    if (this.isDemo() && this.freshnessState(snapshot) === 'fresh') return 'Simulated reading';
    if (snapshot.observedAt) return `Last reading ${snapshot.observedAt}`;
    return 'Waiting for a reading';
  }

  selectScenario(value: string): void {
    if (this.scenarios.some((scenario) => scenario.id === value)) {
      this.scenario.set(value as DemoScenario);
    }
  }

  selectDevice(value: string): void {
    if (this.devices().some((device) => device.id === value)) {
      this.selectedDeviceId.set(value);
    }
  }

  snapshotFor(deviceId: string): UpsSnapshot {
    const snapshot = this.remoteSnapshots()[deviceId];
    if (snapshot) return snapshot;
    if (this.backendMode() && this.backendMode() !== 'demo') {
      const device = this.devices().find((item) => item.id === deviceId) ?? this.selectedDevice();
      return unavailableSnapshot(device);
    }
    return getDemoSnapshot(this.scenario(), deviceId);
  }

  setApiConnected(connected: boolean): void {
    this.apiConnected.set(connected);
  }

  setBackendInitial(
    mode: Exclude<BackendMode, null>,
    devices: DemoDevice[],
    hosts: BackendHost[],
    sourceHealth: SourceDiagnostic[],
    scenario: string | null,
  ): void {
    this.setBackendState(mode, devices, hosts, sourceHealth, scenario, true);
  }

  setBackendHosts(
    mode: Exclude<BackendMode, null>,
    devices: DemoDevice[],
    hosts: BackendHost[],
    sourceHealth: SourceDiagnostic[],
    scenario: string | null,
  ): void {
    this.setBackendState(mode, devices, hosts, sourceHealth, scenario, false);
  }

  private setBackendState(
    mode: Exclude<BackendMode, null>,
    devices: DemoDevice[],
    hosts: BackendHost[],
    sourceHealth: SourceDiagnostic[],
    scenario: string | null,
    clearSnapshots: boolean,
  ): void {
    this.backendMode.set(mode);
    this.devices.set(devices);
    this.hosts.set(hosts);
    this.sourceHealth.set(sourceHealth);
    const activeDeviceIds = new Set(devices.map((device) => device.id));
    this.remoteSnapshots.update((current) =>
      clearSnapshots
        ? {}
        : Object.fromEntries(Object.entries(current).filter(([id]) => activeDeviceIds.has(id))),
    );
    if (devices.length > 0 && !devices.some((device) => device.id === this.selectedDeviceId())) {
      this.selectedDeviceId.set(devices[0].id);
    }
    if (scenario) this.setScenarioFromBackend(scenario);
  }

  setBackendHealth(mode: Exclude<BackendMode, null>, sourceHealth: SourceDiagnostic[]): void {
    this.backendMode.set(mode);
    this.sourceHealth.set(sourceHealth);
  }

  setBackendDevice(device: DemoDevice): void {
    this.devices.update((devices) => {
      const index = devices.findIndex((current) => current.id === device.id);
      if (index < 0) return [...devices, device];
      const next = [...devices];
      next[index] = device;
      return next;
    });
    if (!this.devices().some((item) => item.id === this.selectedDeviceId())) {
      this.selectedDeviceId.set(device.id);
    }
  }

  setBackendSnapshot(snapshot: UpsSnapshot): void {
    this.remoteSnapshots.update((current) => ({ ...current, [snapshot.deviceId]: snapshot }));
  }

  setScenarioFromBackend(value: string): void {
    if (this.scenarios.some((scenario) => scenario.id === value)) {
      this.scenario.set(value as DemoScenario);
    }
  }
}

function unavailableSnapshot(device: DemoDevice): UpsSnapshot {
  return {
    deviceId: device.id,
    deviceName: device.name,
    model: device.model,
    manufacturer: 'Unavailable',
    flow: 'stale',
    status: 'Unavailable',
    statusTokens: [],
    lowBattery: false,
    charging: false,
    batteryCharge: null,
    runtimeSeconds: null,
    loadPercent: null,
    realPower: null,
    powerEstimated: false,
    inputVoltage: null,
    outputVoltage: null,
    inputFrequency: null,
    outputFrequency: null,
    batteryVoltage: null,
    temperature: null,
    observedAt: 'No reading available',
    freshness: 'unavailable',
    lastObservedAt: null,
    rawVariables: {},
  };
}
