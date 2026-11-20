import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NutCollector } from './collector.js';
import { IngestionService } from './ingestion-service.js';
import { loadConfig } from '../config.js';
import { Store } from '../storage/store.js';

const networkDescribe =
  process.env['RUN_LOCAL_NETWORK_TESTS'] === 'true' ? describe : describe.skip;

networkDescribe('NutCollector', () => {
  let nutServer: ReturnType<typeof createServer> | undefined;
  let store: Store | undefined;

  afterEach(async () => {
    if (nutServer) await new Promise<void>((resolve) => nutServer?.close(() => resolve()));
    store?.close();
    nutServer = undefined;
    store = undefined;
  });

  it('discovers and polls UPS data using only read-only LIST commands', async () => {
    const commands: string[] = [];
    nutServer = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (request: string) => {
        for (const command of request.trim().split('\n')) {
          commands.push(command);
          if (command === 'LIST UPS') {
            socket.write('BEGIN LIST UPS\r\nUPS ups1 "Primary UPS"\r\nEND LIST UPS\r\n');
          } else if (command === 'LIST VAR ups1') {
            socket.write(
              'BEGIN LIST VAR ups1\r\n' +
                'VAR ups1 device.mfr "Example"\r\n' +
                'VAR ups1 device.model "Test Model"\r\n' +
                'VAR ups1 ups.status "OL"\r\n' +
                'VAR ups1 battery.charge "99"\r\n' +
                'VAR ups1 battery.runtime "2400"\r\n' +
                'VAR ups1 ups.load "20"\r\n' +
                'VAR ups1 ups.realpower "180"\r\n' +
                'VAR ups1 input.voltage "230.2"\r\n' +
                'END LIST VAR ups1\r\n',
            );
          } else {
            socket.write('ERR UNKNOWN-COMMAND\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolve) => nutServer?.listen(0, '127.0.0.1', resolve));
    const address = nutServer.address() as AddressInfo;
    const config = loadConfig({
      DEMO_MODE: 'false',
      NUT_HOST: '127.0.0.1',
      NUT_PORT: String(address.port),
      NUT_TIMEOUT_MS: '1000',
    });
    store = new Store(':memory:');
    const ingestion = new IngestionService(store, {
      hostId: `127.0.0.1:${address.port}`,
      sampleIntervalMs: config.sampleIntervalMs,
    });
    const collector = new NutCollector(ingestion, config);

    await collector.pollOnce();

    const devices = store.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.snapshot).toMatchObject({
      flow: 'online',
      batteryCharge: 99,
      realPower: 180,
      manufacturer: 'Example',
      model: 'Test Model',
    });
    expect(commands).toEqual(['LIST UPS', 'LIST VAR ups1']);
    expect(collector.health()).toMatchObject({ connected: true, status: 'ready' });
  });
});
