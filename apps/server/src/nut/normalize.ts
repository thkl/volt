import type { FlowState, UpsSnapshot } from '../domain/models.js';
import { stableDeviceId } from '../domain/ids.js';
import type { NutUps } from './protocol.js';

export function normalizeUps(
  sourceId: string,
  ups: NutUps,
  variables: Record<string, string>,
  observedAt = new Date().toISOString(),
): UpsSnapshot {
  const status = variables['ups.status']?.trim() ?? '';
  const statusTokens = status ? status.split(/\s+/).map((token) => token.toUpperCase()) : [];
  const hasOnline = statusTokens.includes('OL');
  const hasBattery = statusTokens.includes('OB');
  const flow: FlowState = hasOnline === hasBattery ? 'unknown' : hasBattery ? 'battery' : 'online';
  const loadPercent = parseNumber(variables['ups.load']);
  const measuredPower = parseNumber(variables['ups.realpower']);
  const ratedRealPower = parseNumber(variables['ups.realpower.nominal']);
  const estimatedPower =
    measuredPower === null && loadPercent !== null && ratedRealPower !== null
      ? Math.round((loadPercent / 100) * ratedRealPower * 10) / 10
      : null;
  const manufacturer = firstValue(variables['device.mfr'], variables['ups.mfr']) ?? 'Unknown';
  const model = firstValue(variables['device.model'], variables['ups.model']) ?? 'Unknown UPS';

  return {
    deviceId: stableDeviceId(sourceId, ups.name),
    deviceName: ups.name,
    model,
    manufacturer,
    flow,
    freshness: 'fresh',
    status: status || 'Unknown',
    statusTokens,
    lowBattery: statusTokens.includes('LB'),
    charging: statusTokens.includes('CHRG'),
    batteryCharge: parseNumber(variables['battery.charge']),
    runtimeSeconds: parseNumber(variables['battery.runtime']),
    loadPercent,
    realPower: measuredPower ?? estimatedPower,
    powerEstimated: measuredPower === null && estimatedPower !== null,
    apparentPower: parseNumber(variables['ups.power']),
    ratedRealPower,
    inputVoltage: parseNumber(variables['input.voltage']),
    outputVoltage: parseNumber(variables['output.voltage']),
    inputFrequency: parseNumber(variables['input.frequency']),
    outputFrequency: parseNumber(variables['output.frequency']),
    batteryVoltage: parseNumber(variables['battery.voltage']),
    temperature: parseNumber(variables['ups.temperature']),
    alarm: firstValue(variables['ups.alarm']),
    observedAt,
    rawVariables: { ...variables },
  };
}

export function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
