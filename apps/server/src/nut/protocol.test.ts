import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NutConnection } from './protocol.js';

const networkDescribe =
  process.env['RUN_LOCAL_NETWORK_TESTS'] === 'true' ? describe : describe.skip;

networkDescribe('NutConnection', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it('parses framed list replies when the TCP response arrives in partial chunks', async () => {
    server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (request: string) => {
        if (request.trim() === 'LIST UPS') {
          socket.write('BEGIN LIST UPS\r\nUPS su700 "Development ');
          setTimeout(() => socket.write('box"\r\nEND LIST UPS\r\n'), 2);
        } else if (request.trim() === 'LIST VAR su700') {
          socket.write('BEGIN LIST VAR su700\r\nVAR su700 ups.status "OB LB"\r\n');
          socket.write('VAR su700 ups.alarm "Power failure: \\"utility\\""\r\n');
          socket.write('END LIST VAR su700\r\n');
        }
      });
    });
    const connection = await connectToTestServer(server);
    try {
      await expect(connection.listUps()).resolves.toEqual([
        { name: 'su700', description: 'Development box' },
      ]);
      await expect(connection.listVariables('su700')).resolves.toEqual({
        'ups.status': 'OB LB',
        'ups.alarm': 'Power failure: "utility"',
      });
    } finally {
      connection.close();
    }
  });

  it('rejects unsafe UPS names before sending a command', async () => {
    server = createServer((_socket) => undefined);
    const connection = await connectToTestServer(server);
    try {
      await expect(connection.listVariables('su700; FSD')).rejects.toThrow('unsafe UPS name');
    } finally {
      connection.close();
    }
  });
});

async function connectToTestServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return NutConnection.connect('127.0.0.1', address.port, 1000);
}
