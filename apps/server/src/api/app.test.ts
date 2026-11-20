import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from './app.js';
import { WebSocketHub } from './websocket-hub.js';
import { HostManager } from '../collector/host-manager.js';
import { loadConfig } from '../config.js';
import { Store } from '../storage/store.js';

const networkDescribe =
  process.env['RUN_LOCAL_NETWORK_TESTS'] === 'true' ? describe : describe.skip;

networkDescribe('Volt API and WebSocket stream', () => {
  let httpServer: Server | undefined;
  let websocket: WebSocket | undefined;
  let hub: WebSocketHub | undefined;
  let collector: HostManager | undefined;
  let store: Store | undefined;

  afterEach(async () => {
    collector?.stop();
    websocket?.terminate();
    hub?.close();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }
    store?.close();
    httpServer = undefined;
    websocket = undefined;
    hub = undefined;
    collector = undefined;
    store = undefined;
  });

  it('serves health and device data, then publishes demo scenario updates to WebSocket clients', async () => {
    const config = loadConfig({ DEMO_MODE: 'true', WEB_DIST_DIR: '/not-built' });
    store = new Store(':memory:');
    store.upsertHost({
      id: 'demo',
      name: 'Demo simulator',
      sourceType: 'demo',
      endpointConfig: {},
      encryptedCredentials: null,
      enabled: true,
    });
    collector = new HostManager(store, config, 'a'.repeat(64));
    collector.start();
    httpServer = createServer(createApp({ config, store, collector }));
    hub = new WebSocketHub(httpServer, config, store, collector);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    expect(health).toMatchObject({ status: 'ok', demoMode: true, collector: { mode: 'demo' } });
    const devices = await fetch(`${baseUrl}/api/devices`).then((response) => response.json());
    expect(devices.data).toHaveLength(2);
    const hosts = await fetch(`${baseUrl}/api/hosts`).then((response) => response.json());
    expect(hosts.data).toMatchObject([{ id: 'demo', sourceType: 'demo' }]);
    const collectorTypes = await fetch(`${baseUrl}/api/collector-types`).then((response) =>
      response.json(),
    );
    expect(collectorTypes.data).toContainEqual({
      type: 'mqtt',
      label: 'MQTT',
      implemented: false,
    });

    websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`);
    const initial = await nextJsonMessage(websocket);
    expect(initial).toMatchObject({
      type: 'initial',
      mode: 'demo',
      devices: [{ id: 'server-room' }],
    });

    const update = nextJsonMessage(websocket, (message) => message.type === 'snapshot');
    const changed = await fetch(`${baseUrl}/api/demo/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'low-battery' }),
    });
    expect(changed.status).toBe(200);
    await expect(update).resolves.toMatchObject({
      type: 'snapshot',
      data: { statusTokens: ['OB', 'LB'], lowBattery: true },
    });

    const invalidRange = await fetch(`${baseUrl}/api/devices/server-room/history?range=all`);
    expect(invalidRange.status).toBe(400);
    const unknownDevice = await fetch(`${baseUrl}/api/devices/missing`);
    expect(unknownDevice.status).toBe(404);
  });
});

async function nextJsonMessage(
  client: WebSocket,
  predicate: (message: Record<string, any>) => boolean = () => true,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket message')),
      2000,
    );
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, any>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      client.off('message', onMessage);
      resolve(message);
    };
    client.on('message', onMessage);
  });
}
