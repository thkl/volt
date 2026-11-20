import { Injectable, computed, signal } from '@angular/core';
import { DEMO_DEVICES, DemoScenario, getDemoEvents, getDemoSnapshot } from './demo-data';
import type { DemoDevice, DemoEvent, UpsSnapshot } from './demo-data';

export type BackendMode = 'demo' | 'nut' | 'multi' | 'none' | null;

export interface BackendHost {
  id: string;
  name: string;
  sourceType: string;
  endpointConfig: Record<string, string | number | boolean | null>;
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
  private readonly remoteEvents = signal<DemoEvent[]>([]);
  readonly isDemo = computed(() => this.backendMode() === null || this.backendMode() === 'demo');
  readonly selectedDevice = computed(
    () =>
      this.devices().find((device) => device.id === this.selectedDeviceId()) ??
      this.devices()[0] ??
      DEMO_DEVICES[0],
  );
  readonly snapshot = computed(() => {
    const snapshot = this.remoteSnapshots()[this.selectedDeviceId()];
    if (snapshot) return snapshot;
    if (this.backendMode() && this.backendMode() !== 'demo') {
      return unavailableSnapshot(this.selectedDevice());
    }
    return getDemoSnapshot(this.scenario(), this.selectedDeviceId());
  });
  readonly events = computed(() =>
    this.backendMode() === 'demo' || this.backendMode() === null
      ? getDemoEvents(this.scenario(), this.selectedDevice().name)
      : this.remoteEvents().filter(
          (event) => !event.deviceId || event.deviceId === this.selectedDeviceId(),
        ),
  );
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
    if (mode === 'demo' || mode === 'none') this.remoteEvents.set([]);
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

  setBackendEvents(events: DemoEvent[]): void {
    this.remoteEvents.set(events);
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
    rawVariables: {},
  };
}
