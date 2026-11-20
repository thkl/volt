export type DemoScenario =
  'online' | 'charging' | 'on-battery' | 'low-battery' | 'stale' | 'unknown' | 'missing-sensors';

export type FlowState = 'online' | 'battery' | 'stale' | 'unknown';

export type ChartRange = '1h' | '24h' | '7d' | '30d';

export type DashboardView = 'overview' | 'history' | 'events';

export interface DemoDevice {
  id: string;
  name: string;
  model: string;
  hostId?: string;
  hostName?: string;
}

export interface UpsSnapshot {
  deviceId: string;
  deviceName: string;
  model: string;
  manufacturer: string;
  flow: FlowState;
  status: string;
  statusTokens: string[];
  lowBattery: boolean;
  charging: boolean;
  batteryCharge: number | null;
  runtimeSeconds: number | null;
  loadPercent: number | null;
  realPower: number | null;
  powerEstimated: boolean;
  apparentPower?: number | null;
  ratedRealPower?: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  inputFrequency: number | null;
  outputFrequency: number | null;
  batteryVoltage: number | null;
  temperature: number | null;
  alarm?: string | null;
  observedAt: string;
  rawVariables: Record<string, string>;
}

export interface DemoEvent {
  id?: number;
  deviceId?: string;
  time: string;
  device: string;
  type: string;
  detail: string;
  tone: 'good' | 'warning' | 'critical' | 'neutral';
}

export const DEMO_DEVICES: DemoDevice[] = [
  { id: 'server-room', name: 'Server room', model: 'Tower UPS · 1500 VA' },
  { id: 'network-closet', name: 'Network closet', model: 'Rack UPS · 1000 VA' },
];

const demoBatteryHealthVariables: Record<string, string> = {
  'battery.status': 'ok',
  'battery.date': '2025/08/01',
  'battery.date.maintenance': '2027/08/01',
  'battery.type': 'PbAc',
  'battery.capacity': '7.2',
  'battery.capacity.nominal': '7.2',
  'battery.packs': '1',
  'battery.packs.bad': '0',
  'ups.test.result': 'Done and passed',
  'ups.test.date': '2026/10/20',
};

const scenarioBase: Record<
  DemoScenario,
  Omit<UpsSnapshot, 'deviceId' | 'deviceName' | 'model' | 'manufacturer'>
> = {
  online: {
    flow: 'online',
    status: 'OL',
    statusTokens: ['OL'],
    lowBattery: false,
    charging: false,
    batteryCharge: 100,
    runtimeSeconds: 2520,
    loadPercent: 24,
    realPower: 186,
    powerEstimated: false,
    inputVoltage: 230.4,
    outputVoltage: 230.1,
    inputFrequency: 50.0,
    outputFrequency: 50.0,
    batteryVoltage: 27.2,
    temperature: 31.4,
    observedAt: 'Just now',
    rawVariables: {
      'ups.status': 'OL',
      'battery.charge': '100',
      'battery.runtime': '2520',
      'ups.load': '24',
      'ups.realpower': '186',
      'input.voltage': '230.4',
      'output.voltage': '230.1',
      'input.frequency': '50.0',
    },
  },
  charging: {
    flow: 'online',
    status: 'OL CHRG',
    statusTokens: ['OL', 'CHRG'],
    lowBattery: false,
    charging: true,
    batteryCharge: 82,
    runtimeSeconds: 1980,
    loadPercent: 24,
    realPower: 186,
    powerEstimated: false,
    inputVoltage: 230.4,
    outputVoltage: 230.1,
    inputFrequency: 50.0,
    outputFrequency: 50.0,
    batteryVoltage: 27.2,
    temperature: 31.4,
    observedAt: 'Just now',
    rawVariables: {
      'ups.status': 'OL CHRG',
      'battery.charge': '82',
      'battery.runtime': '1980',
      'ups.load': '24',
      'ups.realpower': '186',
      'input.voltage': '230.4',
      'output.voltage': '230.1',
      'input.frequency': '50.0',
    },
  },
  'on-battery': {
    flow: 'battery',
    status: 'OB',
    statusTokens: ['OB'],
    lowBattery: false,
    charging: false,
    batteryCharge: 76,
    runtimeSeconds: 2180,
    loadPercent: 23,
    realPower: 178,
    powerEstimated: false,
    inputVoltage: null,
    outputVoltage: 229.8,
    inputFrequency: null,
    outputFrequency: 50.0,
    batteryVoltage: 25.8,
    temperature: 32.1,
    observedAt: 'Just now',
    rawVariables: {
      'ups.status': 'OB',
      'battery.charge': '76',
      'battery.runtime': '2180',
      'ups.load': '23',
      'ups.realpower': '178',
      'output.voltage': '229.8',
      'output.frequency': '50.0',
    },
  },
  'low-battery': {
    flow: 'battery',
    status: 'OB LB',
    statusTokens: ['OB', 'LB'],
    lowBattery: true,
    charging: false,
    batteryCharge: 18,
    runtimeSeconds: 640,
    loadPercent: 31,
    realPower: 238,
    powerEstimated: false,
    inputVoltage: null,
    outputVoltage: 229.4,
    inputFrequency: null,
    outputFrequency: 50.0,
    batteryVoltage: 23.1,
    temperature: 34.8,
    observedAt: 'Just now',
    rawVariables: {
      'ups.status': 'OB LB',
      'battery.charge': '18',
      'battery.runtime': '640',
      'ups.load': '31',
      'ups.realpower': '238',
      'output.voltage': '229.4',
      'output.frequency': '50.0',
      'ups.alarm': 'Battery charge is low',
    },
  },
  stale: {
    flow: 'stale',
    status: 'OL · stale',
    statusTokens: ['OL'],
    lowBattery: false,
    charging: false,
    batteryCharge: 100,
    runtimeSeconds: 2520,
    loadPercent: 24,
    realPower: 186,
    powerEstimated: false,
    inputVoltage: 230.4,
    outputVoltage: 230.1,
    inputFrequency: 50.0,
    outputFrequency: 50.0,
    batteryVoltage: 27.2,
    temperature: 31.4,
    observedAt: '14 min ago',
    rawVariables: {
      'ups.status': 'OL',
      'battery.charge': '100',
      'battery.runtime': '2520',
      'ups.load': '24',
      'ups.realpower': '186',
      'input.voltage': '230.4',
      'output.voltage': '230.1',
    },
  },
  unknown: {
    flow: 'unknown',
    status: 'CAL',
    statusTokens: ['CAL'],
    lowBattery: false,
    charging: false,
    batteryCharge: 82,
    runtimeSeconds: 1940,
    loadPercent: 21,
    realPower: null,
    powerEstimated: false,
    inputVoltage: 229.9,
    outputVoltage: 230.0,
    inputFrequency: 50.0,
    outputFrequency: 50.0,
    batteryVoltage: 26.5,
    temperature: 30.8,
    observedAt: 'Just now',
    rawVariables: {
      'ups.status': 'CAL',
      'battery.charge': '82',
      'battery.runtime': '1940',
      'ups.load': '21',
      'input.voltage': '229.9',
      'output.voltage': '230.0',
    },
  },
  'missing-sensors': {
    flow: 'online',
    status: 'OL',
    statusTokens: ['OL'],
    lowBattery: false,
    charging: false,
    batteryCharge: null,
    runtimeSeconds: null,
    loadPercent: 24,
    realPower: null,
    powerEstimated: false,
    inputVoltage: null,
    outputVoltage: 230.1,
    inputFrequency: null,
    outputFrequency: 50.0,
    batteryVoltage: null,
    temperature: null,
    observedAt: 'Just now',
    rawVariables: {
      'ups.status': 'OL',
      'ups.load': '24',
      'output.voltage': '230.1',
      'output.frequency': '50.0',
    },
  },
};

export function getDemoSnapshot(scenario: DemoScenario, deviceId: string): UpsSnapshot {
  const device = DEMO_DEVICES.find((candidate) => candidate.id === deviceId) ?? DEMO_DEVICES[0];
  const base = scenarioBase[scenario];
  const secondaryDevice = device.id === 'network-closet';

  return {
    ...base,
    deviceId: device.id,
    deviceName: device.name,
    model: device.model,
    manufacturer: 'Demo hardware',
    rawVariables: { ...demoBatteryHealthVariables, ...base.rawVariables },
    loadPercent: shift(base.loadPercent, secondaryDevice ? -4 : 0),
    realPower: shift(base.realPower, secondaryDevice ? -28 : 0),
    outputVoltage: shift(base.outputVoltage, secondaryDevice ? -0.2 : 0),
    inputVoltage: shift(base.inputVoltage, secondaryDevice ? 0.3 : 0),
  };
}

function shift(value: number | null, amount: number): number | null {
  return value === null ? null : Math.round((value + amount) * 10) / 10;
}

export function getDemoEvents(scenario: DemoScenario, deviceName: string): DemoEvent[] {
  const onlineEvent: DemoEvent = {
    time: '09:41:02',
    device: deviceName,
    type: 'Mains restored',
    detail: 'Power returned to utility supply',
    tone: 'good',
  };
  const earlierOnlineEvent: DemoEvent = {
    time: '09:34:51',
    device: deviceName,
    type: 'Utility power',
    detail: 'UPS reported normal operation',
    tone: 'good',
  };
  const batteryEvent: DemoEvent = {
    time: '09:38:17',
    device: deviceName,
    type: 'On battery',
    detail: 'Utility input lost · output remains active',
    tone: 'warning',
  };
  const lowBatteryEvent: DemoEvent = {
    time: '09:40:53',
    device: deviceName,
    type: 'Low battery',
    detail: 'UPS reported the LB status flag',
    tone: 'critical',
  };
  const connectionEvent: DemoEvent = {
    time: '09:27:11',
    device: deviceName,
    type: 'Data stale',
    detail: 'No successful poll in the last 14 minutes',
    tone: 'neutral',
  };

  if (scenario === 'low-battery') {
    return [lowBatteryEvent, batteryEvent, earlierOnlineEvent];
  }
  if (scenario === 'on-battery') {
    return [batteryEvent, earlierOnlineEvent];
  }
  if (scenario === 'stale') {
    return [connectionEvent, earlierOnlineEvent];
  }
  if (scenario === 'unknown') {
    return [
      {
        time: '09:40:53',
        device: deviceName,
        type: 'Unrecognized status',
        detail: 'Raw status CAL is shown without inferred power flow',
        tone: 'neutral',
      },
      earlierOnlineEvent,
    ];
  }
  return scenario === 'online' ? [onlineEvent, batteryEvent] : [onlineEvent];
}
