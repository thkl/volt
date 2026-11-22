import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { AuthManager } from '../auth/auth-manager.js';
import { loadConfig } from '../config.js';
import type { EnergyImpactService, EnergyImpactView } from '../energy/energy-impact-service.js';
import type { HostManager } from '../collector/host-manager.js';
import type { Store } from '../storage/store.js';
import { WebSocketHub } from './websocket-hub.js';

const DEVICE_ID = 'ups-1';

interface HubClientState {
  alive: boolean;
  sessionToken: string | undefined;
  energyImpactSubscription: { deviceId: string; timeZone: string } | null;
  lastEnergyImpactRefreshAt: number;
}

interface HubInternals {
  clientStates: WeakMap<WebSocket, HubClientState>;
  handleMessage(client: WebSocket, raw: string): void;
}

describe('WebSocketHub energy impact subscriptions', () => {
  let hub: WebSocketHub;
  let client: WebSocket;
  let sendMessage: ReturnType<typeof vi.fn>;
  let energyImpactService: EnergyImpactService & { getImpact: ReturnType<typeof vi.fn> };
  let handleMessage: HubInternals['handleMessage'];

  beforeEach(() => {
    const config = loadConfig({});
    const httpServer = createServer();
    const store = { listDevices: () => [{ id: DEVICE_ID }] } as unknown as Store;
    const collector = new EventEmitter() as unknown as HostManager;
    energyImpactService = {
      getImpact: vi.fn((deviceId: string, timeZone: string) =>
        createImpactView(deviceId, timeZone),
      ),
    } as unknown as EnergyImpactService & { getImpact: ReturnType<typeof vi.fn> };
    hub = new WebSocketHub(
      httpServer,
      config,
      store,
      collector,
      new AuthManager(config),
      energyImpactService,
    );

    sendMessage = vi.fn();
    client = {
      readyState: WebSocket.OPEN,
      send: sendMessage,
      close: vi.fn(),
      terminate: vi.fn(),
    } as unknown as WebSocket;
    const internals = hub as unknown as HubInternals;
    internals.clientStates.set(client, {
      alive: true,
      sessionToken: undefined,
      energyImpactSubscription: null,
      lastEnergyImpactRefreshAt: 0,
    });
    handleMessage = internals.handleMessage.bind(hub);
  });

  afterEach(() => {
    hub.close();
    vi.restoreAllMocks();
  });

  it('calculates and sends only once for duplicate identical subscriptions', () => {
    const subscription = JSON.stringify({
      type: 'subscribe-energy-impact',
      deviceId: DEVICE_ID,
      timeZone: 'Europe/Berlin',
    });

    handleMessage(client, subscription);
    handleMessage(client, subscription);

    expect(energyImpactService.getImpact).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendMessage.mock.calls[0]?.[0]))).toMatchObject({
      type: 'energy-impact',
      data: { deviceId: DEVICE_ID, timeZone: 'Europe/Berlin' },
    });
  });

  it('allows explicit refreshes while limiting them to one per second', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    handleMessage(
      client,
      JSON.stringify({
        type: 'subscribe-energy-impact',
        deviceId: DEVICE_ID,
        timeZone: 'Europe/Berlin',
      }),
    );

    const refresh = JSON.stringify({ type: 'refresh-energy-impact' });
    handleMessage(client, refresh);
    handleMessage(client, refresh);

    expect(energyImpactService.getImpact).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

function createImpactView(deviceId: string, timeZone: string): EnergyImpactView {
  const period = {
    energyKwh: null,
    estimatedEnergyKwh: 0,
    cost: null,
    co2Kg: null,
    coveragePercent: 0,
  };
  return {
    deviceId,
    timeZone,
    currency: 'EUR',
    pricePerKwh: null,
    carbonIntensityGramsPerKwh: null,
    maxGapSeconds: 60,
    periods: { lastHour: period, last24Hours: period, last30Days: period },
    dayparts: [],
    dailyTrend: [],
  };
}
