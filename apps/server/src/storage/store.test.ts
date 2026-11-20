import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UpsSnapshot } from '../domain/models.js';
import { IngestionService } from '../collector/ingestion-service.js';
import { decryptCredentials, encryptCredentials } from '../security/credentials.js';
import { Store } from './store.js';

describe('Store', () => {
  it('persists snapshots, samples and deduplicated power transition events', () => {
    const store = new Store(':memory:');
    const ingestion = new IngestionService(store, { hostId: 'test', sampleIntervalMs: 30_000 });
    const baseTime = Date.now();
    const online = snapshot('online', new Date(baseTime).toISOString());
    const onBattery = snapshot('battery', new Date(baseTime + 35_000).toISOString());

    ingestion.ingest(online, 'Demo UPS');
    ingestion.ingest(onBattery, 'Demo UPS');
    ingestion.ingest(onBattery, 'Demo UPS');

    expect(store.listDevices()).toHaveLength(1);
    expect(store.getDevice('test-ups')?.snapshot?.flow).toBe('battery');
    expect(store.countSamples('test-ups')).toBe(2);
    expect(store.getEvents({ limit: 10 }).data.map((event) => event.type)).toEqual(['on-battery']);

    const history = store.getHistory('test-ups', '1h', ['realPower'], baseTime + 60_000);
    expect(history.series.realPower).toHaveLength(2);
    expect(history.series.realPower?.at(-1)?.value).toBe(178);
    store.close();
  });

  it('persists host metadata while keeping encrypted credentials out of API summaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'volt-host-store-'));
    const databasePath = join(directory, 'volt.sqlite');
    const key = 'a'.repeat(64);
    const encryptedCredentials = encryptCredentials(
      { username: 'volt-reader', password: 'not-in-plaintext' },
      key,
    );
    let store = new Store(databasePath);
    try {
      store.upsertHost({
        id: 'ups.example.test:3493',
        name: 'Garage NUT',
        sourceType: 'nut',
        endpointConfig: { host: 'ups.example.test', port: 3493, tls: true },
        encryptedCredentials,
        enabled: true,
      });
      store.close();

      store = new Store(databasePath);
      const [host] = store.listHosts();
      expect(host).toMatchObject({
        id: 'ups.example.test:3493',
        name: 'Garage NUT',
        sourceType: 'nut',
        credentialsConfigured: true,
        endpointConfig: { host: 'ups.example.test', port: 3493, tls: true },
      });
      expect(JSON.stringify(host)).not.toContain('not-in-plaintext');
      expect(
        decryptCredentials(
          store.getHostRecord('ups.example.test:3493')!.encryptedCredentials!,
          key,
        ),
      ).toEqual({ username: 'volt-reader', password: 'not-in-plaintext' });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('migrates existing devices into source host records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'volt-host-migration-'));
    const databasePath = join(directory, 'volt.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        server_key TEXT NOT NULL,
        ups_name TEXT NOT NULL,
        description TEXT NOT NULL,
        model TEXT NOT NULL,
        manufacturer TEXT NOT NULL,
        availability INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT,
        observed_at TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        flow TEXT NOT NULL,
        status_tokens TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      ) STRICT;
      INSERT INTO devices VALUES (
        'legacy-device', 'ups.example.test:3493', 'ups1', 'Garage UPS', 'Model X', 'Vendor',
        1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z', 1767225600000, 'online', '["OL"]', '{}'
      );
    `);
    legacy.close();

    const store = new Store(databasePath);
    try {
      expect(store.listDevices()).toMatchObject([
        { id: 'legacy-device', hostId: 'ups.example.test:3493', hostName: 'NUT server' },
      ]);
      expect(store.listHosts()).toMatchObject([
        { id: 'ups.example.test:3493', sourceType: 'nut', credentialsConfigured: false },
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function snapshot(flow: 'online' | 'battery', observedAt: string): UpsSnapshot {
  const battery = flow === 'battery';
  return {
    deviceId: 'test-ups',
    deviceName: 'test-ups',
    model: 'Test UPS',
    manufacturer: 'Test',
    flow,
    freshness: 'fresh',
    status: battery ? 'OB' : 'OL',
    statusTokens: battery ? ['OB'] : ['OL'],
    lowBattery: false,
    charging: false,
    batteryCharge: battery ? 76 : 100,
    runtimeSeconds: battery ? 2180 : 2520,
    loadPercent: battery ? 23 : 24,
    realPower: battery ? 178 : 186,
    powerEstimated: false,
    apparentPower: 300,
    ratedRealPower: 900,
    inputVoltage: battery ? null : 230,
    outputVoltage: 230,
    inputFrequency: battery ? null : 50,
    outputFrequency: 50,
    batteryVoltage: 26,
    temperature: 31,
    alarm: null,
    observedAt,
    rawVariables: { 'ups.status': battery ? 'OB' : 'OL' },
  };
}
