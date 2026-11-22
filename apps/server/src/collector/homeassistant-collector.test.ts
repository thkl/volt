import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import type { IngestionService } from './ingestion-service.js';
import { HOME_ASSISTANT_NUMERIC_FIELDS } from './homeassistant-config.js';
import type { HomeAssistantEntityMappings } from './homeassistant-config.js';
import { HomeAssistantCollector } from './homeassistant-collector.js';

describe('HomeAssistantCollector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('scales mapped entities and derives battery state from configured sensors', async () => {
    const ingestion = {
      ingest: vi.fn(),
      markUnavailable: vi.fn(),
    } as unknown as IngestionService;
    const collector = new HomeAssistantCollector(
      ingestion,
      loadConfig({}),
      'ha-home',
      'Home battery',
      endpointConfig({
        batteryCharge: ['sensor.charge', 100],
        runtimeSeconds: ['sensor.runtime_minutes', 60],
        loadPercent: ['sensor.load_fraction', 100],
        realPower: ['sensor.power_kw', 1000],
        inputVoltage: ['sensor.input_voltage', 1],
      }),
      { accessToken: 'ha-token' },
    );
    const fetchMock = vi.fn(async () =>
      Response.json([
        state('sensor.status', 'OL'),
        state('binary_sensor.on_battery', 'on'),
        state('binary_sensor.charging', 'on'),
        state('binary_sensor.low_battery', 'off'),
        state('sensor.charge', '0.85'),
        state('sensor.runtime_minutes', '12'),
        state('sensor.load_fraction', '0.24'),
        state('sensor.power_kw', '0.36'),
        state('sensor.input_voltage', '230'),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const observedAt = Date.parse('2026-11-22T12:00:00.000Z');

    await collector.pollOnce(observedAt);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://homeassistant.local:8123/api/states',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ha-token',
        },
        redirect: 'error',
      }),
    );
    expect(ingestion.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceName: 'Home battery',
        flow: 'battery',
        charging: true,
        lowBattery: false,
        batteryCharge: 85,
        runtimeSeconds: 720,
        loadPercent: 24,
        realPower: 360,
        inputVoltage: 230,
        observedAt: '2026-11-22T12:00:00.000Z',
      }),
      'Home battery',
    );
    expect(collector.health()).toMatchObject({
      mode: 'homeassistant',
      status: 'ready',
      connected: true,
      discoveredUps: 1,
      consecutiveFailures: 0,
    });
  });

  it('marks the mapped device unavailable after three failed polls', async () => {
    const ingestion = {
      ingest: vi.fn(),
      markUnavailable: vi.fn(),
    } as unknown as IngestionService;
    const collector = new HomeAssistantCollector(
      ingestion,
      loadConfig({}),
      'ha-home',
      'Home battery',
      endpointConfig({}),
      { accessToken: 'ha-token' },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await collector.pollOnce();
    await collector.pollOnce();
    await collector.pollOnce();

    expect(collector.health()).toMatchObject({
      status: 'degraded',
      connected: false,
      lastErrorCode: 'HTTP_401',
      consecutiveFailures: 3,
    });
    expect(ingestion.markUnavailable).toHaveBeenCalledWith(
      expect.any(String),
      'No successful Home Assistant state poll in three intervals',
    );
  });

  it('rejects insecure connection URLs containing credentials', () => {
    const ingestion = { ingest: vi.fn(), markUnavailable: vi.fn() } as unknown as IngestionService;
    expect(
      () =>
        new HomeAssistantCollector(
          ingestion,
          loadConfig({}),
          'ha-home',
          'Home battery',
          { ...endpointConfig({}), url: 'http://user:pass@homeassistant.local' },
          { accessToken: 'ha-token' },
        ),
    ).toThrow('Home Assistant URL must be an absolute HTTP or HTTPS URL');
  });
});

function endpointConfig(
  mapped: Partial<Record<(typeof HOME_ASSISTANT_NUMERIC_FIELDS)[number], [string, number]>>,
) {
  const metrics = Object.fromEntries(
    HOME_ASSISTANT_NUMERIC_FIELDS.map((field) => [field, null]),
  ) as HomeAssistantEntityMappings['metrics'];
  for (const [field, [entityId, scale]] of Object.entries(mapped)) {
    metrics[field as keyof typeof metrics] = { entityId, scale };
  }
  return {
    url: 'http://homeassistant.local:8123/',
    entities: {
      statusEntityId: 'sensor.status',
      onBatteryEntityId: 'binary_sensor.on_battery',
      chargingEntityId: 'binary_sensor.charging',
      lowBatteryEntityId: 'binary_sensor.low_battery',
      metrics,
    },
  };
}

function state(entity_id: string, value: string) {
  return { entity_id, state: value, attributes: {} };
}
