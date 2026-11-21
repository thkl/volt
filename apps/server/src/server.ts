import { createServer, type Server } from 'node:http';
import { createApp } from './api/app.js';
import { WebSocketHub } from './api/websocket-hub.js';
import { HostManager } from './collector/host-manager.js';
import type { AppConfig } from './config.js';
import { Store } from './storage/store.js';
import { createDefaultCollectorRegistry } from './collector/registry.js';
import { encryptCredentials } from './security/credentials.js';
import { loadOrCreateCredentialKey } from './security/key-store.js';
import { AuthManager } from './auth/auth-manager.js';
import { AlertService } from './alerts/alert-service.js';
import { InfluxDbService } from './integrations/influxdb-service.js';

export interface VoltServer {
  readonly httpServer: Server;
  readonly collector: HostManager;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createVoltServer(config: AppConfig): VoltServer {
  const store = new Store(config.databasePath);
  let credentialKey: string;
  try {
    credentialKey = loadOrCreateCredentialKey(config.databasePath, config.credentialsEncryptionKey);
    seedConfiguredHosts(store, config, credentialKey);
  } catch (error) {
    store.close();
    throw error;
  }

  const retentionCleanup = () => {
    const now = Date.now();
    try {
      store.deleteExpired(
        now - config.sampleRetentionDays * 24 * 60 * 60_000,
        now - config.eventRetentionDays * 24 * 60 * 60_000,
      );
    } catch {
      console.error(JSON.stringify({ level: 'error', message: 'SQLite retention cleanup failed' }));
    }
  };
  retentionCleanup();
  const retentionTimer = setInterval(retentionCleanup, 6 * 60 * 60_000);
  retentionTimer.unref();

  const registry = createDefaultCollectorRegistry();
  const collector = new HostManager(store, config, credentialKey, registry);
  const alertService = new AlertService(store, credentialKey, collector);
  const influxDbService = new InfluxDbService(store, credentialKey, collector);
  const authManager = new AuthManager(config);
  const app = createApp({
    config,
    store,
    collector,
    collectorTypes: registry.catalog(),
    authManager,
    alertService,
    influxDbService,
  });
  const httpServer = createServer(app);
  const websocketHub = new WebSocketHub(httpServer, config, store, collector, authManager);

  return {
    httpServer,
    collector,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        httpServer.once('error', onError);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', onError);
          collector.start();
          resolve();
        });
      }),
    close: async () => {
      clearInterval(retentionTimer);
      alertService.close();
      influxDbService.close();
      collector.stop();
      websocketHub.close();
      await new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      store.close();
    },
  };
}

function seedConfiguredHosts(store: Store, config: AppConfig, credentialKey: string): void {
  if (!config.demoMode && config.nutHost) {
    const hostId = `${config.nutHost}:${config.nutPort}`;
    const credentials =
      config.nutUsername && config.nutPassword
        ? encryptCredentials(
            { username: config.nutUsername, password: config.nutPassword },
            credentialKey,
          )
        : null;
    store.upsertHost(
      {
        id: hostId,
        name: config.nutName ?? config.nutHost,
        sourceType: 'nut',
        endpointConfig: {
          host: config.nutHost,
          port: config.nutPort,
          tls: config.nutTls,
          protocol: 'tcp',
        },
        encryptedCredentials: credentials,
        enabled: true,
      },
      config.clearNutCredentials,
    );
    for (const demoId of store.disableHostsByType('demo')) {
      store.disableHost(demoId);
    }
    return;
  }

  if (!config.demoMode) {
    store.disableHostsByType('demo');
    return;
  }

  if (store.listHosts().length === 0 && config.demoMode) {
    store.upsertHost({
      id: 'demo',
      name: 'Demo simulator',
      sourceType: 'demo',
      endpointConfig: {},
      encryptedCredentials: null,
      enabled: true,
    });
  }
}
