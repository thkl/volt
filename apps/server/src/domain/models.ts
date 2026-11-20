export type FlowState = 'online' | 'battery' | 'stale' | 'unknown';

export type Freshness = 'fresh' | 'stale' | 'unavailable';

export interface DataSourceTypeDescriptor {
  type: DataSourceType;
  label: string;
  implemented: boolean;
}

export type DataSourceType = 'demo' | 'nut' | 'mqtt' | 'homeassistant' | 'unifi-http';

export const DATA_SOURCE_TYPES: ReadonlyArray<DataSourceTypeDescriptor> = [
  { type: 'demo', label: 'Demo simulator', implemented: true },
  { type: 'nut', label: 'Network UPS Tools', implemented: true },
  { type: 'mqtt', label: 'MQTT', implemented: false },
  { type: 'homeassistant', label: 'Home Assistant', implemented: false },
  { type: 'unifi-http', label: 'UniFi UPS HTTP API', implemented: false },
];

export interface HostSummary {
  id: string;
  name: string;
  sourceType: DataSourceType;
  endpointConfig: Record<string, string | number | boolean | null>;
  credentialsConfigured: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostRecord extends HostSummary {
  encryptedCredentials: string | null;
}

export type CollectorMode = DataSourceType | 'multi' | 'none';

export type DemoScenario =
  'online' | 'charging' | 'on-battery' | 'low-battery' | 'stale' | 'unknown' | 'missing-sensors';

export interface UpsSnapshot {
  deviceId: string;
  deviceName: string;
  model: string;
  manufacturer: string;
  flow: FlowState;
  freshness: Freshness;
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

export interface DeviceSummary {
  id: string;
  hostId: string;
  hostName: string;
  name: string;
  description: string;
  model: string;
  manufacturer: string;
  availability: 'available' | 'unavailable';
  firstSeenAt: string;
  lastSeenAt: string | null;
  snapshot: UpsSnapshot | null;
}

export type EventTone = 'good' | 'warning' | 'critical' | 'neutral';

export interface PowerEvent {
  id: number;
  deviceId: string;
  deviceName: string;
  occurredAt: string;
  type: string;
  detail: string;
  tone: EventTone;
  previousState: string | null;
  newState: string | null;
}

export type ShutdownCoordination = 'unverified' | 'verified' | 'not_configured';

export interface ShutdownReadinessPlan {
  deviceId: string;
  dependentSystems: string[];
  coordination: ShutdownCoordination;
  updatedAt: string | null;
}

export const DEMO_SCENARIOS: ReadonlyArray<{ id: DemoScenario; label: string }> = [
  { id: 'online', label: 'Online · grid' },
  { id: 'charging', label: 'Charging · utility' },
  { id: 'on-battery', label: 'On battery' },
  { id: 'low-battery', label: 'Low battery' },
  { id: 'stale', label: 'Stale data' },
  { id: 'unknown', label: 'Unknown status' },
  { id: 'missing-sensors', label: 'Missing sensors' },
];

export const HISTORY_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export const OUTAGE_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type OutageRange = (typeof OUTAGE_RANGES)[number];

export const HISTORY_METRICS = [
  'realPower',
  'loadPercent',
  'batteryCharge',
  'inputVoltage',
  'outputVoltage',
] as const;
export type HistoryMetric = (typeof HISTORY_METRICS)[number];
