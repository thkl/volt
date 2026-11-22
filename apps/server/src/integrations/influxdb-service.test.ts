import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfluxConfigurationError, InfluxDbService } from './influxdb-service.js';
import type { HostManager } from '../collector/host-manager.js';
import type { Store } from '../storage/store.js';

describe('InfluxDbService', () => {
  let service: InfluxDbService;

  afterEach(() => {
    service?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stores the token encrypted and writes a test point to the configured endpoint', async () => {
    const settings = new Map<string, string>();
    const store = {
      getAppSetting: (key: string) => settings.get(key) ?? null,
      setAppSetting: (key: string, value: string) => settings.set(key, value),
    } as unknown as Store;
    const collector = new EventEmitter() as unknown as HostManager;
    service = new InfluxDbService(store, 'a'.repeat(64), collector);
    const settingsView = service.saveSettings({
      enabled: true,
      url: 'https://influx.example.test/',
      org: 'volt org',
      bucket: 'ups bucket',
      measurement: 'volt ups',
      token: 'influx-secret',
      clearToken: false,
    });
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', request);

    await service.sendTestWrite();

    expect(settingsView).toMatchObject({
      configured: true,
      tokenConfigured: true,
      status: 'waiting',
    });
    expect(settings.get('influxdb')).not.toContain('influx-secret');
    expect(request).toHaveBeenCalledOnce();
    const requestCall = request.mock.calls[0];
    expect(requestCall).toBeDefined();
    const [input, init] = requestCall ?? [undefined, undefined];
    const url = new URL(String(input));
    expect(url.pathname).toBe('/api/v2/write');
    expect(url.searchParams.get('org')).toBe('volt org');
    expect(url.searchParams.get('bucket')).toBe('ups bucket');
    expect(url.searchParams.get('precision')).toBe('ms');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Token influx-secret' });
    expect(init?.body).toEqual(
      expect.stringContaining('volt\\ ups,source=volt-test test_write=true'),
    );
    expect(service.getSettings()).toMatchObject({ status: 'connected', lastError: null });
  });

  it('rejects incomplete enabled settings and reports HTTP write failures', async () => {
    const settings = new Map<string, string>();
    const store = {
      getAppSetting: (key: string) => settings.get(key) ?? null,
      setAppSetting: (key: string, value: string) => settings.set(key, value),
    } as unknown as Store;
    const collector = new EventEmitter() as unknown as HostManager;
    service = new InfluxDbService(store, 'a'.repeat(64), collector);

    expect(() =>
      service.saveSettings({
        enabled: true,
        url: '',
        org: '',
        bucket: '',
        measurement: '',
        token: '',
        clearToken: false,
      }),
    ).toThrow(InfluxConfigurationError);
    service.saveSettings({
      enabled: true,
      url: 'https://influx.example.test',
      org: 'org',
      bucket: 'bucket',
      measurement: 'volt_ups',
      token: 'secret',
      clearToken: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(service.sendTestWrite()).rejects.toThrow('InfluxDB rejected a write (HTTP 401)');
    expect(service.getSettings()).toMatchObject({
      status: 'error',
      lastError: 'InfluxDB rejected a write (HTTP 401)',
    });
  });
});
