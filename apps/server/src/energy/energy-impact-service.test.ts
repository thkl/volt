import { describe, expect, it, vi } from 'vitest';
import { EnergyImpactConfigurationError, EnergyImpactService } from './energy-impact-service.js';
import type { PowerSample, Store } from '../storage/store.js';

const DEVICE_ID = 'ups-1';
const SETTINGS = {
  pricePerKwh: 0.4,
  currency: 'eur',
  carbonIntensityGramsPerKwh: 200,
};

describe('EnergyImpactService', () => {
  it('calculates energy, cost, CO₂ and estimated energy from bounded samples', () => {
    const now = Date.parse('2026-11-22T11:59:00.000Z');
    const { service } = makeService([sample(now - 60_000, 360, true), sample(now, 360, true)]);
    service.saveSettings(SETTINGS);

    const impact = service.getImpact(DEVICE_ID, 'UTC', now);

    expect(impact).toMatchObject({
      deviceId: DEVICE_ID,
      timeZone: 'UTC',
      currency: 'EUR',
      maxGapSeconds: 60,
    });
    expect(impact.periods.lastHour.energyKwh).toBeCloseTo(0.006, 6);
    expect(impact.periods.lastHour.estimatedEnergyKwh).toBeCloseTo(0.006, 6);
    expect(impact.periods.lastHour.cost).toBeCloseTo(0.0024, 6);
    expect(impact.periods.lastHour.co2Kg).toBeCloseTo(0.0012, 6);
    expect(impact.periods.lastHour.coveragePercent).toBeCloseTo(1.7, 1);
  });

  it('splits power across local dayparts and labels the local date in the trend', () => {
    const now = Date.parse('2026-11-22T22:01:00.000Z');
    const { service } = makeService([sample(now - 60_000, 360, false), sample(now, 360, false)]);

    const impact = service.getImpact(DEVICE_ID, 'Europe/Berlin', now);

    expect(impact.dayparts.find((part) => part.id === 'night')?.energyKwh).toBeCloseTo(0.006, 6);
    expect(impact.dailyTrend.at(-1)).toMatchObject({ date: '2026-11-22', energyKwh: 0.006 });
  });

  it('treats large sample gaps as missing data', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const { service } = makeService([sample(now - 60_001, 360, false), sample(now, 360, false)]);

    const impact = service.getImpact(DEVICE_ID, 'UTC', now);

    expect(impact.periods.lastHour).toMatchObject({
      energyKwh: null,
      cost: null,
      co2Kg: null,
      coveragePercent: 0,
    });
  });

  it('persists normalized settings and rejects invalid values', () => {
    const { service, settings } = makeService([]);

    expect(service.getSettings()).toEqual({
      pricePerKwh: null,
      currency: 'EUR',
      carbonIntensityGramsPerKwh: null,
    });
    expect(service.saveSettings(SETTINGS)).toEqual({
      pricePerKwh: 0.4,
      currency: 'EUR',
      carbonIntensityGramsPerKwh: 200,
    });
    expect(JSON.parse(settings.get('energy-impact') ?? '{}')).toMatchObject({ version: 1 });
    expect(() => service.saveSettings({ ...SETTINGS, pricePerKwh: -1 })).toThrow(
      EnergyImpactConfigurationError,
    );
  });

  it('rejects an invalid time zone', () => {
    const { service } = makeService([]);
    expect(() => service.getImpact(DEVICE_ID, 'Not/A-Time-Zone', 1_800_000_000_000)).toThrow(
      EnergyImpactConfigurationError,
    );
  });
});

function makeService(samples: PowerSample[]) {
  const settings = new Map<string, string>();
  const store = {
    getAppSetting: (key: string) => settings.get(key) ?? null,
    setAppSetting: (key: string, value: string) => settings.set(key, value),
    getPowerSamples: vi.fn(() => samples),
  } as unknown as Store;
  return { service: new EnergyImpactService(store, 30_000), settings };
}

function sample(observedAtMs: number, realPower: number, powerEstimated: boolean): PowerSample {
  return { observedAtMs, realPower, powerEstimated };
}
