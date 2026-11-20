import { describe, expect, it } from 'vitest';
import { normalizeUps, parseNumber } from './normalize.js';

describe('normalizeUps', () => {
  const ups = { name: 'test-ups', description: 'Test UPS' };

  it('preserves zero values and estimates watts only from load and nominal real power', () => {
    const snapshot = normalizeUps(
      'test-host:3493',
      ups,
      {
        'ups.status': 'OB LB',
        'battery.charge': '0',
        'battery.runtime': '0',
        'ups.load': '25',
        'ups.realpower.nominal': '500',
        'ups.power': '300',
      },
      '2026-11-20T10:00:00.000Z',
    );

    expect(snapshot.flow).toBe('battery');
    expect(snapshot.lowBattery).toBe(true);
    expect(snapshot.batteryCharge).toBe(0);
    expect(snapshot.runtimeSeconds).toBe(0);
    expect(snapshot.realPower).toBe(125);
    expect(snapshot.powerEstimated).toBe(true);
    expect(snapshot.apparentPower).toBe(300);
    expect(snapshot.inputVoltage).toBeNull();
    expect(snapshot.statusTokens).toEqual(['OB', 'LB']);
  });

  it('does not infer a source from an unknown or conflicting status', () => {
    expect(normalizeUps('host', ups, { 'ups.status': 'CAL' }).flow).toBe('unknown');
    expect(normalizeUps('host', ups, { 'ups.status': 'OL OB' }).flow).toBe('unknown');
  });
});

describe('parseNumber', () => {
  it('rejects malformed and non-finite readings', () => {
    expect(parseNumber(' 230.4 ')).toBe(230.4);
    expect(parseNumber('Infinity')).toBeNull();
    expect(parseNumber('230 volts')).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });
});
