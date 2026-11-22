import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoState } from './demo-state';
import { LiveUpdates } from './live-updates';
import type { EnergyImpact } from './live-updates';

interface LiveUpdatesInternals {
  socket: WebSocket | null;
  receive(raw: unknown): void;
}

describe('LiveUpdates energy-impact messages', () => {
  let updates: LiveUpdates;
  let socket: {
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [DemoState, LiveUpdates] });
    updates = TestBed.inject(LiveUpdates);
    socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    (updates as unknown as LiveUpdatesInternals).socket = socket as unknown as WebSocket;
  });

  afterEach(() => {
    updates.pause();
    vi.restoreAllMocks();
  });

  it('sends subscribe, explicit refresh and unsubscribe messages as separate operations', () => {
    updates.subscribeEnergyImpact('ups-1');
    updates.refreshEnergyImpact();
    updates.subscribeEnergyImpact(null);

    const messages = socket.send.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(messages[0]).toMatchObject({ type: 'subscribe-energy-impact', deviceId: 'ups-1' });
    expect(messages[0].timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(messages[1]).toEqual({ type: 'refresh-energy-impact' });
    expect(messages[2]).toEqual({ type: 'unsubscribe-energy-impact' });
  });

  it('stores valid pushed impacts without emitting another subscription message', () => {
    const impact = createImpact('ups-1');
    const internals = updates as unknown as LiveUpdatesInternals;

    internals.receive(JSON.stringify({ type: 'energy-impact', data: impact }));

    expect(updates.energyImpactFor('ups-1')).toEqual(impact);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('ignores malformed impacts and retains server-provided impact errors', () => {
    const internals = updates as unknown as LiveUpdatesInternals;
    internals.receive(JSON.stringify({ type: 'energy-impact', data: { deviceId: 'ups-1' } }));
    internals.receive(
      JSON.stringify({
        type: 'energy-impact-error',
        deviceId: 'ups-1',
        message: 'Energy data is unavailable',
      }),
    );

    expect(updates.energyImpactFor('ups-1')).toBeNull();
    expect(updates.energyImpactErrorFor('ups-1')).toBe('Energy data is unavailable');
  });
});

function createImpact(deviceId: string): EnergyImpact {
  const period = {
    energyKwh: 0.1,
    estimatedEnergyKwh: 0.1,
    cost: 0.03,
    co2Kg: 0.001,
    coveragePercent: 100,
  };
  return {
    deviceId,
    timeZone: 'UTC',
    currency: 'EUR',
    pricePerKwh: 0.3,
    carbonIntensityGramsPerKwh: 10,
    maxGapSeconds: 60,
    periods: { lastHour: period, last24Hours: period, last30Days: period },
    dayparts: [],
    dailyTrend: [],
  };
}
