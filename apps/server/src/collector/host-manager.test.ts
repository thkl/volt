import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { decryptCredentials } from '../security/credentials.js';
import { Store } from '../storage/store.js';
import { CollectorRegistry } from './registry.js';
import type { Collector, CollectorHealth } from './collector.js';
import type { CollectorAdapter } from './registry.js';
import { HostManager } from './host-manager.js';
import type { HomeAssistantHostInput } from './homeassistant-config.js';

const KEY = 'a'.repeat(64);

describe('HostManager', () => {
  let store: Store;
  let manager: HostManager;

  afterEach(() => {
    manager?.stop();
    store?.close();
    vi.restoreAllMocks();
  });

  it('encrypts NUT credentials and emits one hosts update after add', () => {
    const collector = fakeCollector();
    const create = vi.fn(() => collector);
    ({ store, manager } = createManager('nut', create));
    const hostsUpdates = vi.fn();
    manager.on('hosts', hostsUpdates);

    const host = manager.addNutHost({
      name: 'Garage UPS',
      host: 'ups.example.test',
      port: 3493,
      tls: false,
      username: 'reader',
      password: 'secret',
    });

    const saved = store.getHostRecord(host.id);
    expect(host).toMatchObject({
      name: 'Garage UPS',
      sourceType: 'nut',
      credentialsConfigured: true,
      endpointConfig: { host: 'ups.example.test', port: 3493, tls: false, protocol: 'tcp' },
    });
    expect(host).not.toHaveProperty('encryptedCredentials');
    expect(saved?.encryptedCredentials).not.toContain('secret');
    expect(decryptCredentials(saved!.encryptedCredentials!, KEY)).toEqual({
      username: 'reader',
      password: 'secret',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: host.id,
        credentials: { username: 'reader', password: 'secret' },
      }),
    );
    expect(collector.start).toHaveBeenCalledOnce();
    expect(hostsUpdates).toHaveBeenCalledOnce();
  });

  it('encrypts Home Assistant tokens and requires a token on creation', () => {
    const collector = fakeCollector();
    const create = vi.fn(() => collector);
    ({ store, manager } = createManager('homeassistant', create));
    const input: HomeAssistantHostInput = {
      name: 'Solar battery',
      url: 'https://ha.example.test',
      entities: {
        statusEntityId: null,
        onBatteryEntityId: null,
        chargingEntityId: null,
        lowBatteryEntityId: null,
        metrics: {
          batteryCharge: null,
          runtimeSeconds: null,
          loadPercent: null,
          realPower: null,
          inputVoltage: null,
          outputVoltage: null,
          inputFrequency: null,
          outputFrequency: null,
          batteryVoltage: null,
          temperature: null,
        },
      },
      accessToken: 'long-lived-token',
    };

    const host = manager.addHomeAssistantHost(input);
    const saved = store.getHostRecord(host.id);

    expect(host).toMatchObject({
      sourceType: 'homeassistant',
      credentialsConfigured: true,
      endpointConfig: { url: input.url, entities: input.entities },
    });
    expect(host).not.toHaveProperty('encryptedCredentials');
    expect(saved?.encryptedCredentials).not.toContain('long-lived-token');
    expect(decryptCredentials(saved!.encryptedCredentials!, KEY)).toEqual({
      accessToken: 'long-lived-token',
    });
    expect(() =>
      manager.addHomeAssistantHost({ ...input, name: 'Missing token', accessToken: ' ' }),
    ).toThrow('Home Assistant access token is required');
  });

  it('stops the collector and deletes a host when it is removed', () => {
    const collector = fakeCollector();
    const create = vi.fn(() => collector);
    ({ store, manager } = createManager('nut', create));
    const host = manager.addNutHost({
      name: 'Garage UPS',
      host: 'ups.example.test',
      port: 3493,
      tls: false,
    });

    manager.removeHost(host.id);

    expect(collector.stop).toHaveBeenCalledOnce();
    expect(store.getHostRecord(host.id)).toBeNull();
    expect(manager.sourceHealth()).toEqual([]);
  });
});

function createManager(type: 'nut' | 'homeassistant', create: CollectorAdapter['create']) {
  const store = new Store(':memory:');
  const adapter: CollectorAdapter = { type, create };
  const registry = new CollectorRegistry([adapter]);
  const manager = new HostManager(store, loadConfig({}), KEY, registry);
  return { store, manager };
}

function fakeCollector() {
  const health: CollectorHealth = {
    mode: 'nut',
    status: 'ready',
    connected: true,
    lastPollAt: null,
    lastError: null,
    phase: 'ready',
  };
  return {
    start: vi.fn(),
    stop: vi.fn(),
    health: vi.fn(() => health),
  } as unknown as Collector & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
}
