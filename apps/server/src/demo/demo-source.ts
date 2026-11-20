import { EventEmitter } from 'node:events';
import type { DemoScenario, UpsSnapshot } from '../domain/models.js';
import { DEMO_SCENARIOS } from '../domain/models.js';

export interface DemoDevice {
  id: string;
  name: string;
  model: string;
  loadOffset: number;
  powerOffset: number;
}

export const DEMO_DEVICES: readonly DemoDevice[] = [
  {
    id: 'server-room',
    name: 'Server room',
    model: 'Tower UPS · 1500 VA',
    loadOffset: 0,
    powerOffset: 0,
  },
  {
    id: 'network-closet',
    name: 'Network closet',
    model: 'Rack UPS · 1000 VA',
    loadOffset: -4,
    powerOffset: -28,
  },
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

type Fixture = Pick<
  UpsSnapshot,
  | 'flow'
  | 'freshness'
  | 'status'
  | 'statusTokens'
  | 'lowBattery'
  | 'charging'
  | 'batteryCharge'
  | 'runtimeSeconds'
  | 'loadPercent'
  | 'realPower'
  | 'powerEstimated'
  | 'apparentPower'
  | 'ratedRealPower'
  | 'inputVoltage'
  | 'outputVoltage'
  | 'inputFrequency'
  | 'outputFrequency'
  | 'batteryVoltage'
  | 'temperature'
  | 'alarm'
  | 'rawVariables'
>;

const fixtures: Record<DemoScenario, Fixture> = {
  online: {
    flow: 'online',
    freshness: 'fresh',
    status: 'OL',
    statusTokens: ['OL'],
    lowBattery: false,
    charging: false,
    batteryCharge: 100,
    runtimeSeconds: 2520,
    loadPercent: 24,
    realPower: 186,
    powerEstimated: false,
    apparentPower: 310,
    ratedRealPower: 900,
    inputVoltage: 230.4,
    outputVoltage: 230.1,
    inputFrequency: 50,
    outputFrequency: 50,
    batteryVoltage: 27.2,
    temperature: 31.4,
    alarm: null,
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
  charging: {
    ...fixturesPlaceholder(),
    status: 'OL CHRG',
    statusTokens: ['OL', 'CHRG'],
    charging: true,
    batteryCharge: 82,
    runtimeSeconds: 1980,
    rawVariables: {
      'ups.status': 'OL CHRG',
      'battery.charge': '82',
      'battery.runtime': '1980',
      'ups.load': '24',
      'ups.realpower': '186',
      'input.voltage': '230.4',
      'output.voltage': '230.1',
    },
  },
  'on-battery': {
    ...fixturesPlaceholder(),
    flow: 'battery',
    status: 'OB',
    statusTokens: ['OB'],
    batteryCharge: 76,
    runtimeSeconds: 2180,
    loadPercent: 23,
    realPower: 178,
    apparentPower: 296,
    inputVoltage: null,
    inputFrequency: null,
    outputVoltage: 229.8,
    batteryVoltage: 25.8,
    rawVariables: {
      'ups.status': 'OB',
      'battery.charge': '76',
      'battery.runtime': '2180',
      'ups.load': '23',
      'ups.realpower': '178',
      'output.voltage': '229.8',
    },
  },
  'low-battery': {
    ...fixturesPlaceholder(),
    flow: 'battery',
    status: 'OB LB',
    statusTokens: ['OB', 'LB'],
    lowBattery: true,
    batteryCharge: 18,
    runtimeSeconds: 640,
    loadPercent: 31,
    realPower: 238,
    apparentPower: 340,
    inputVoltage: null,
    inputFrequency: null,
    outputVoltage: 229.4,
    batteryVoltage: 23.1,
    temperature: 34.8,
    alarm: 'Battery charge is low',
    rawVariables: {
      'ups.status': 'OB LB',
      'battery.charge': '18',
      'battery.runtime': '640',
      'ups.load': '31',
      'ups.realpower': '238',
      'ups.alarm': 'Battery charge is low',
    },
  },
  stale: {
    ...fixturesPlaceholder(),
    flow: 'stale',
    freshness: 'stale',
    status: 'OL',
    statusTokens: ['OL'],
  },
  unknown: {
    ...fixturesPlaceholder(),
    flow: 'unknown',
    status: 'CAL',
    statusTokens: ['CAL'],
    batteryCharge: 82,
    runtimeSeconds: 1940,
    loadPercent: 21,
    realPower: null,
    inputVoltage: 229.9,
    outputVoltage: 230,
    inputFrequency: 50,
    outputFrequency: 50,
    batteryVoltage: 26.5,
    temperature: 30.8,
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
    ...fixturesPlaceholder(),
    batteryCharge: null,
    runtimeSeconds: null,
    realPower: null,
    inputVoltage: null,
    inputFrequency: null,
    outputVoltage: 230.1,
    outputFrequency: 50,
    batteryVoltage: null,
    temperature: null,
    rawVariables: {
      'ups.status': 'OL',
      'ups.load': '24',
      'output.voltage': '230.1',
      'output.frequency': '50.0',
    },
  },
};

function fixturesPlaceholder(): Fixture {
  return {
    flow: 'online',
    freshness: 'fresh',
    status: 'OL',
    statusTokens: ['OL'],
    lowBattery: false,
    charging: false,
    batteryCharge: 100,
    runtimeSeconds: 2520,
    loadPercent: 24,
    realPower: 186,
    powerEstimated: false,
    apparentPower: 310,
    ratedRealPower: 900,
    inputVoltage: 230.4,
    outputVoltage: 230.1,
    inputFrequency: 50,
    outputFrequency: 50,
    batteryVoltage: 27.2,
    temperature: 31.4,
    alarm: null,
    rawVariables: {},
  };
}

export class DemoSource extends EventEmitter {
  private selectedScenario: DemoScenario = 'online';

  get scenario(): DemoScenario {
    return this.selectedScenario;
  }

  selectScenario(value: string): boolean {
    const scenario = DEMO_SCENARIOS.find((item) => item.id === value)?.id;
    if (!scenario) return false;
    this.selectedScenario = scenario;
    this.emit('scenario', scenario);
    return true;
  }

  snapshots(now = Date.now()): UpsSnapshot[] {
    return DEMO_DEVICES.map((device) => demoSnapshot(this.selectedScenario, device, now));
  }
}

export function demoSnapshot(
  scenario: DemoScenario,
  device: DemoDevice,
  now = Date.now(),
): UpsSnapshot {
  const fixture = structuredClone(fixtures[scenario]);
  const observedAt = scenario === 'stale' ? now - 14 * 60_000 : now;
  const variables = { ...demoBatteryHealthVariables, ...fixture.rawVariables };
  const adjust = (value: number | null, delta: number): number | null =>
    value === null ? null : Math.round((value + delta) * 10) / 10;

  if (device.loadOffset !== 0 && fixture.loadPercent !== null) {
    fixture.loadPercent = adjust(fixture.loadPercent, device.loadOffset);
    variables['ups.load'] = String(fixture.loadPercent);
  }
  if (device.powerOffset !== 0 && fixture.realPower !== null) {
    fixture.realPower = adjust(fixture.realPower, device.powerOffset);
    variables['ups.realpower'] = String(fixture.realPower);
  }
  if (device.id === 'network-closet' && fixture.outputVoltage !== null) {
    fixture.outputVoltage = adjust(fixture.outputVoltage, -0.2);
  }
  if (device.id === 'network-closet' && fixture.inputVoltage !== null) {
    fixture.inputVoltage = adjust(fixture.inputVoltage, 0.3);
  }

  return {
    ...fixture,
    deviceId: device.id,
    deviceName: device.name,
    model: device.model,
    manufacturer: 'Demo hardware',
    observedAt: new Date(observedAt).toISOString(),
    rawVariables: variables,
  };
}
