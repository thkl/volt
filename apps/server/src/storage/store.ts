import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  DeviceSummary,
  DataSourceType,
  EventTone,
  Freshness,
  HostRecord,
  HostSummary,
  HistoryMetric,
  HistoryRange,
  OutageRange,
  PowerEvent,
  UpsSnapshot,
} from '../domain/models.js';

export interface PowerEventInput {
  deviceId: string;
  occurredAt: string;
  type: string;
  detail: string;
  tone: EventTone;
  previousState: string | null;
  newState: string | null;
  transitionKey: string;
}

export interface HistoryPoint {
  observedAt: string;
  value: number;
  minimum: number;
  maximum: number;
}

export interface HistoryResult {
  deviceId: string;
  range: HistoryRange;
  from: string;
  to: string;
  bucketMs: number;
  series: Partial<Record<HistoryMetric, HistoryPoint[]>>;
}

export interface EventPage {
  data: PowerEvent[];
  nextCursor: string | null;
}

export interface OutageEpisode {
  id: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  status: 'completed' | 'ongoing' | 'uncertain';
  uncertainty: 'connection-gap' | 'missing-start' | 'missing-return' | null;
}

export interface OutageSummary {
  deviceId: string;
  range: OutageRange;
  from: string;
  to: string;
  outageCount: number;
  completedCount: number;
  uncertainCount: number;
  confirmedDurationMs: number;
  longestConfirmedDurationMs: number | null;
  outages: OutageEpisode[];
}

export interface DatabaseDiagnostics {
  fileBacked: boolean;
  sizeBytes: number;
  records: {
    total: number;
    hosts: number;
    devices: number;
    samples: number;
    events: number;
    appSettings: number;
    schemaMigrations: number;
  };
}

export interface PowerSample {
  observedAtMs: number;
  realPower: number | null;
  powerEstimated: boolean;
}

interface DeviceRow {
  id: string;
  host_id: string;
  host_name: string | null;
  ups_name: string;
  description: string;
  model: string;
  manufacturer: string;
  availability: number;
  first_seen_at: string;
  last_seen_at: string | null;
  snapshot_json: string | null;
}

interface HostRow {
  id: string;
  name: string;
  source_type: DataSourceType;
  endpoint_config_json: string;
  encrypted_credentials: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  device_id: string;
  device_name: string;
  occurred_at: string;
  occurred_at_ms: number;
  type: string;
  detail: string;
  tone: EventTone;
  previous_state: string | null;
  new_state: string | null;
}

interface HistoryRow extends Record<string, number | null> {
  bucket_ms: number;
}

interface PowerSampleRow {
  observed_at_ms: number;
  real_power: number | null;
  power_estimated: number;
}

const RANGE_MS: Record<HistoryRange, number> = {
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

const OUTAGE_RANGE_MS: Record<OutageRange, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '90d': 90 * 24 * 60 * 60_000,
};

const METRIC_COLUMNS: Record<HistoryMetric, string> = {
  realPower: 'real_power',
  loadPercent: 'load_percent',
  batteryCharge: 'battery_charge',
  inputVoltage: 'input_voltage',
  outputVoltage: 'output_voltage',
};

const INITIAL_SCHEMA = `
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  server_key TEXT NOT NULL,
  ups_name TEXT NOT NULL,
  description TEXT NOT NULL,
  model TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  availability INTEGER NOT NULL CHECK (availability IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT,
  observed_at TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  flow TEXT NOT NULL,
  status_tokens TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
) STRICT;

CREATE TABLE samples (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  flow TEXT NOT NULL,
  status_tokens TEXT NOT NULL,
  battery_charge REAL,
  runtime_seconds REAL,
  load_percent REAL,
  real_power REAL,
  power_estimated INTEGER NOT NULL CHECK (power_estimated IN (0, 1)),
  apparent_power REAL,
  input_voltage REAL,
  output_voltage REAL,
  input_frequency REAL,
  output_frequency REAL,
  battery_voltage REAL,
  temperature REAL
) STRICT;
CREATE INDEX samples_device_time ON samples(device_id, observed_at_ms);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  tone TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  transition_key TEXT NOT NULL UNIQUE
) STRICT;
CREATE INDEX events_device_time ON events(device_id, occurred_at_ms DESC, id DESC);
`;

export class Store {
  private readonly database: DatabaseSync;
  private readonly databasePath: string;

  constructor(path: string) {
    this.databasePath = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.database.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  getDiagnostics(): DatabaseDiagnostics {
    const records = {
      hosts: this.countRows('hosts'),
      devices: this.countRows('devices'),
      samples: this.countRows('samples'),
      events: this.countRows('events'),
      appSettings: this.countRows('app_settings'),
      schemaMigrations: this.countRows('schema_migrations'),
    };
    const fileBacked = this.databasePath !== ':memory:';
    const sizeBytes = fileBacked
      ? [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`].reduce(
          (total, path) => total + fileSize(path),
          0,
        )
      : 0;

    return {
      fileBacked,
      sizeBytes,
      records: {
        ...records,
        total: Object.values(records).reduce((total, count) => total + count, 0),
      },
    };
  }

  upsertHost(
    host: Omit<HostRecord, 'createdAt' | 'updatedAt' | 'credentialsConfigured'>,
    clearCredentials = false,
  ): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO hosts (
          id, name, source_type, endpoint_config_json, encrypted_credentials,
          enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          source_type = excluded.source_type,
          endpoint_config_json = excluded.endpoint_config_json,
          encrypted_credentials = CASE WHEN ? = 1 THEN NULL
            ELSE COALESCE(excluded.encrypted_credentials, hosts.encrypted_credentials) END,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at`,
      )
      .run(
        host.id,
        host.name,
        host.sourceType,
        JSON.stringify(host.endpointConfig),
        host.encryptedCredentials,
        host.enabled ? 1 : 0,
        now,
        now,
        clearCredentials ? 1 : 0,
      );
  }

  listHosts(): HostSummary[] {
    const rows = this.database
      .prepare('SELECT * FROM hosts ORDER BY name COLLATE NOCASE, id')
      .all() as unknown as HostRow[];
    return rows.map(mapHostSummary);
  }

  listEnabledHosts(): HostSummary[] {
    const rows = this.database
      .prepare('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id')
      .all() as unknown as HostRow[];
    return rows.map(mapHostSummary);
  }

  listEnabledHostRecords(): HostRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id')
      .all() as unknown as HostRow[];
    return rows.map(mapHostRecord);
  }

  disableHost(id: string): boolean {
    const result = this.database
      .prepare('UPDATE hosts SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1')
      .run(new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  deleteHostAndData(id: string): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const devices = this.database
        .prepare('SELECT id FROM devices WHERE host_id = ?')
        .all(id) as unknown as Array<{ id: string }>;
      const deleteShutdownPlan = this.database.prepare('DELETE FROM app_settings WHERE key = ?');
      for (const device of devices) {
        deleteShutdownPlan.run(`shutdown-readiness:${device.id}`);
      }
      this.database.prepare('DELETE FROM devices WHERE host_id = ?').run(id);
      const result = this.database.prepare('DELETE FROM hosts WHERE id = ?').run(id);
      this.database.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  disableHostsByType(sourceType: DataSourceType): string[] {
    const rows = this.database
      .prepare('SELECT id FROM hosts WHERE source_type = ? AND enabled = 1')
      .all(sourceType) as unknown as Array<{ id: string }>;
    this.database
      .prepare('UPDATE hosts SET enabled = 0, updated_at = ? WHERE source_type = ? AND enabled = 1')
      .run(new Date().toISOString(), sourceType);
    return rows.map((row) => row.id);
  }

  getHostRecord(id: string): HostRecord | null {
    const row = this.database.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as
      HostRow | undefined;
    return row ? mapHostRecord(row) : null;
  }

  listDevices(): DeviceSummary[] {
    const rows = this.database
      .prepare(
        `SELECT devices.*, hosts.name AS host_name FROM devices
         JOIN hosts ON hosts.id = devices.host_id AND hosts.enabled = 1
         ORDER BY hosts.name COLLATE NOCASE, devices.ups_name COLLATE NOCASE, devices.id`,
      )
      .all() as unknown as DeviceRow[];
    return rows.map(mapDeviceRow);
  }

  getDevice(id: string): DeviceSummary | null {
    const row = this.database
      .prepare(
        `SELECT devices.*, hosts.name AS host_name FROM devices
         JOIN hosts ON hosts.id = devices.host_id WHERE devices.id = ?`,
      )
      .get(id) as DeviceRow | undefined;
    return row ? mapDeviceRow(row) : null;
  }

  getLastSampleAt(id: string): number | null {
    const row = this.database
      .prepare('SELECT MAX(observed_at_ms) AS latest FROM samples WHERE device_id = ?')
      .get(id) as { latest: number | null } | undefined;
    return row?.latest ?? null;
  }

  writeObservation(
    snapshot: UpsSnapshot,
    description: string,
    hostId: string,
    events: PowerEventInput[],
    includeSample: boolean,
  ): void {
    const observedAtMs = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observedAtMs))
      throw new Error('Snapshot observedAt must be a valid timestamp');
    const previous = this.getDevice(snapshot.deviceId);
    const firstSeenAt = previous?.firstSeenAt ?? snapshot.observedAt;
    const lastSeenAt = snapshot.freshness === 'fresh' ? snapshot.observedAt : previous?.lastSeenAt;

    if (!this.getHostRecord(hostId)) {
      this.upsertHost({
        id: hostId,
        name: hostId === 'demo' ? 'Demo simulator' : hostId,
        sourceType: hostId === 'demo' ? 'demo' : 'nut',
        endpointConfig: {},
        encryptedCredentials: null,
        enabled: true,
      });
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO devices (
            id, server_key, host_id, ups_name, description, model, manufacturer, availability,
            first_seen_at, last_seen_at, observed_at, observed_at_ms, flow, status_tokens, snapshot_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            server_key = excluded.server_key,
            host_id = excluded.host_id,
            ups_name = excluded.ups_name,
            description = excluded.description,
            model = excluded.model,
            manufacturer = excluded.manufacturer,
            availability = excluded.availability,
            last_seen_at = COALESCE(excluded.last_seen_at, devices.last_seen_at),
            observed_at = excluded.observed_at,
            observed_at_ms = excluded.observed_at_ms,
            flow = excluded.flow,
            status_tokens = excluded.status_tokens,
            snapshot_json = excluded.snapshot_json`,
        )
        .run(
          snapshot.deviceId,
          hostId,
          hostId,
          snapshot.deviceName,
          description || snapshot.deviceName,
          snapshot.model,
          snapshot.manufacturer,
          snapshot.freshness === 'fresh' ? 1 : 0,
          firstSeenAt,
          lastSeenAt ?? null,
          snapshot.observedAt,
          observedAtMs,
          snapshot.flow,
          JSON.stringify(snapshot.statusTokens),
          JSON.stringify(snapshot),
        );

      if (includeSample) this.insertSample(snapshot, observedAtMs);
      for (const event of events) this.insertEvent(event);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getHistory(
    deviceId: string,
    range: HistoryRange,
    metrics: HistoryMetric[],
    now = Date.now(),
  ): HistoryResult {
    const durationMs = RANGE_MS[range];
    const fromMs = now - durationMs;
    const bucketMs = Math.max(30_000, Math.ceil(durationMs / 1000 / 30_000) * 30_000);
    const aggregateColumns = metrics
      .map((metric) => {
        const column = METRIC_COLUMNS[metric];
        return `AVG(${column}) AS ${metric}_avg, MIN(${column}) AS ${metric}_min, MAX(${column}) AS ${metric}_max`;
      })
      .join(', ');
    const statement = this.database.prepare(
      `SELECT CAST(observed_at_ms / ? AS INTEGER) * ? AS bucket_ms, ${aggregateColumns}
       FROM samples
       WHERE device_id = ? AND observed_at_ms >= ?
       GROUP BY bucket_ms
       ORDER BY bucket_ms ASC
       LIMIT 1000`,
    );
    const rows = statement.all(bucketMs, bucketMs, deviceId, fromMs) as unknown as HistoryRow[];
    const series: Partial<Record<HistoryMetric, HistoryPoint[]>> = {};
    for (const metric of metrics) {
      const points: HistoryPoint[] = [];
      for (const row of rows) {
        const value = row[`${metric}_avg`];
        const minimum = row[`${metric}_min`];
        const maximum = row[`${metric}_max`];
        if (
          value === null ||
          value === undefined ||
          minimum === null ||
          minimum === undefined ||
          maximum === null ||
          maximum === undefined
        ) {
          continue;
        }
        points.push({
          observedAt: new Date(row.bucket_ms).toISOString(),
          value: round(value),
          minimum: round(minimum),
          maximum: round(maximum),
        });
      }
      series[metric] = points;
    }
    return {
      deviceId,
      range,
      from: new Date(fromMs).toISOString(),
      to: new Date(now).toISOString(),
      bucketMs,
      series,
    };
  }

  getPowerSamples(deviceId: string, fromMs: number, toMs: number): PowerSample[] {
    const previous = this.database
      .prepare(
        `SELECT observed_at_ms, real_power, power_estimated FROM samples
         WHERE device_id = ? AND observed_at_ms < ?
         ORDER BY observed_at_ms DESC, id DESC LIMIT 1`,
      )
      .get(deviceId, fromMs) as PowerSampleRow | undefined;
    const rows = this.database
      .prepare(
        `SELECT observed_at_ms, real_power, power_estimated FROM samples
         WHERE device_id = ? AND observed_at_ms >= ? AND observed_at_ms <= ?
         ORDER BY observed_at_ms ASC, id ASC`,
      )
      .all(deviceId, fromMs, toMs) as unknown as PowerSampleRow[];
    return [...(previous ? [previous] : []), ...rows].map((row) => ({
      observedAtMs: row.observed_at_ms,
      realPower: row.real_power,
      powerEstimated: row.power_estimated === 1,
    }));
  }

  getEvents(options: { deviceId?: string; limit: number; cursorId?: number }): EventPage {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.deviceId) {
      conditions.push('events.device_id = ?');
      params.push(options.deviceId);
    }
    if (options.cursorId !== undefined) {
      conditions.push('events.id < ?');
      params.push(options.cursorId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.database
      .prepare(
        `SELECT events.*, devices.ups_name AS device_name
         FROM events JOIN devices ON devices.id = events.device_id
         ${where}
         ORDER BY events.occurred_at_ms DESC, events.id DESC
         LIMIT ?`,
      )
      .all(...params, options.limit + 1) as unknown as EventRow[];
    const hasMore = rows.length > options.limit;
    const visibleRows = rows.slice(0, options.limit);
    const data = visibleRows.map(mapEventRow);
    const last = visibleRows[visibleRows.length - 1];
    return {
      data,
      nextCursor: hasMore && last ? Buffer.from(String(last.id)).toString('base64url') : null,
    };
  }

  getOutageSummary(deviceId: string, range: OutageRange, now = Date.now()): OutageSummary {
    const fromMs = now - OUTAGE_RANGE_MS[range];
    const previousPowerEvent = this.database
      .prepare(
        `SELECT events.*, devices.ups_name AS device_name
         FROM events JOIN devices ON devices.id = events.device_id
         WHERE events.device_id = ? AND events.occurred_at_ms < ?
           AND events.type IN ('on-battery', 'mains-restored')
         ORDER BY events.occurred_at_ms DESC, events.id DESC
         LIMIT 1`,
      )
      .get(deviceId, fromMs) as EventRow | undefined;
    const scanFromMs =
      previousPowerEvent?.type === 'on-battery' ? previousPowerEvent.occurred_at_ms : fromMs;
    const rows = this.database
      .prepare(
        `SELECT events.*, devices.ups_name AS device_name
         FROM events JOIN devices ON devices.id = events.device_id
         WHERE events.device_id = ? AND events.occurred_at_ms >= ?
           AND events.type IN ('on-battery', 'mains-restored', 'connection-lost')
         ORDER BY events.occurred_at_ms ASC, events.id ASC`,
      )
      .all(deviceId, scanFromMs) as unknown as EventRow[];

    const episodes: Array<OutageEpisode & { startMs: number | null; endMs: number | null }> = [];
    let open: { id: number; startedAt: string; startMs: number; observationGap: boolean } | null =
      null;
    for (const row of rows) {
      const occurredAtMs = Date.parse(row.occurred_at);
      if (row.type === 'on-battery') {
        if (open) {
          episodes.push({
            id: open.id,
            startedAt: open.startedAt,
            endedAt: null,
            durationMs: null,
            status: 'uncertain',
            uncertainty: 'missing-return',
            startMs: open.startMs,
            endMs: occurredAtMs,
          });
        }
        open = {
          id: row.id,
          startedAt: row.occurred_at,
          startMs: occurredAtMs,
          observationGap: false,
        };
      } else if (row.type === 'connection-lost' && open) {
        open.observationGap = true;
      } else if (row.type === 'mains-restored' && open) {
        const durationMs = Math.max(0, occurredAtMs - open.startMs);
        episodes.push({
          id: open.id,
          startedAt: open.startedAt,
          endedAt: row.occurred_at,
          durationMs,
          status: open.observationGap ? 'uncertain' : 'completed',
          uncertainty: open.observationGap ? 'connection-gap' : null,
          startMs: open.startMs,
          endMs: occurredAtMs,
        });
        open = null;
      } else if (row.type === 'mains-restored') {
        episodes.push({
          id: row.id,
          startedAt: null,
          endedAt: row.occurred_at,
          durationMs: null,
          status: 'uncertain',
          uncertainty: 'missing-start',
          startMs: null,
          endMs: occurredAtMs,
        });
      }
    }

    const device = this.getDevice(deviceId);
    const confirmedBattery =
      device?.snapshot?.freshness === 'fresh' && device.snapshot.flow === 'battery';
    const confirmedOnline =
      device?.snapshot?.freshness === 'fresh' && device.snapshot.flow === 'online';
    if (open) {
      if (confirmedOnline && device?.snapshot) {
        const endedAtMs = Date.parse(device.snapshot.observedAt);
        episodes.push({
          id: open.id,
          startedAt: open.startedAt,
          endedAt: device.snapshot.observedAt,
          durationMs: null,
          status: 'uncertain',
          uncertainty: open.observationGap ? 'connection-gap' : 'missing-return',
          startMs: open.startMs,
          endMs: Number.isFinite(endedAtMs) ? endedAtMs : null,
        });
      } else {
        const durationMs =
          confirmedBattery && !open.observationGap ? Math.max(0, now - open.startMs) : null;
        episodes.push({
          id: open.id,
          startedAt: open.startedAt,
          endedAt: null,
          durationMs,
          status: confirmedBattery ? 'ongoing' : 'uncertain',
          uncertainty: open.observationGap
            ? 'connection-gap'
            : confirmedBattery
              ? null
              : 'missing-return',
          startMs: open.startMs,
          endMs: null,
        });
      }
    } else if (confirmedBattery) {
      episodes.push({
        id: null,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        status: 'ongoing',
        uncertainty: 'missing-start',
        startMs: null,
        endMs: null,
      });
    }

    const overlapping = episodes
      .filter((episode) => episode.endMs === null || episode.endMs >= fromMs)
      .sort((first, second) => (second.startMs ?? -1) - (first.startMs ?? -1));
    const confirmed = overlapping.filter(
      (episode) =>
        (episode.status === 'completed' || episode.status === 'ongoing') &&
        episode.uncertainty === null &&
        episode.startMs !== null,
    );
    const confirmedDurations = confirmed.map((episode) =>
      Math.max(0, Math.min(episode.endMs ?? now, now) - Math.max(episode.startMs!, fromMs)),
    );
    const confirmedDurationMs = confirmedDurations.reduce((total, duration) => total + duration, 0);
    const longestConfirmedDurationMs = confirmedDurations.length
      ? Math.max(...confirmedDurations)
      : null;

    return {
      deviceId,
      range,
      from: new Date(fromMs).toISOString(),
      to: new Date(now).toISOString(),
      outageCount: overlapping.length,
      completedCount: overlapping.filter((episode) => episode.status === 'completed').length,
      uncertainCount: overlapping.filter(
        (episode) => episode.status === 'uncertain' || episode.uncertainty !== null,
      ).length,
      confirmedDurationMs,
      longestConfirmedDurationMs,
      outages: overlapping
        .slice(0, 100)
        .map(({ startMs: _start, endMs: _end, ...episode }) => episode),
    };
  }

  deleteExpired(
    sampleCutoffMs: number,
    eventCutoffMs: number,
  ): { samples: number; events: number } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const samples = Number(
        this.database.prepare('DELETE FROM samples WHERE observed_at_ms < ?').run(sampleCutoffMs)
          .changes,
      );
      const events = Number(
        this.database.prepare('DELETE FROM events WHERE occurred_at_ms < ?').run(eventCutoffMs)
          .changes,
      );
      this.database.exec('COMMIT');
      return { samples, events };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  countSamples(deviceId: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM samples WHERE device_id = ?')
      .get(deviceId) as { count: number };
    return row.count;
  }

  private countRows(table: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  getAppSetting(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setAppSetting(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO app_settings(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private migrate(): void {
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;',
    );
    if (this.schemaVersion() < 1) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(INITIAL_SCHEMA);
        this.recordMigration(1);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    if (this.schemaVersion() < 2) this.migrateHosts();
    if (this.schemaVersion() < 3) this.migrateAppSettings();
  }

  private schemaVersion(): number {
    const applied = this.database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null };
    return applied.version ?? 0;
  }

  private recordMigration(version: number): void {
    this.database
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
  }

  private migrateHosts(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE hosts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (source_type IN ('demo', 'nut', 'mqtt', 'homeassistant', 'unifi-http')),
          endpoint_config_json TEXT NOT NULL,
          encrypted_credentials TEXT,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        ALTER TABLE devices ADD COLUMN host_id TEXT REFERENCES hosts(id);

        INSERT INTO hosts (
          id, name, source_type, endpoint_config_json, encrypted_credentials,
          enabled, created_at, updated_at
        )
        SELECT DISTINCT
          server_key,
          CASE WHEN server_key = 'demo' THEN 'Demo simulator' ELSE 'NUT server' END,
          CASE WHEN server_key = 'demo' THEN 'demo' ELSE 'nut' END,
          '{}', NULL, 1,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM devices;

        UPDATE devices SET host_id = server_key WHERE host_id IS NULL;
        CREATE INDEX devices_host_name ON devices(host_id, ups_name COLLATE NOCASE);
      `);
      this.recordMigration(2);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateAppSettings(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(
        'CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;',
      );
      this.recordMigration(3);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private insertSample(snapshot: UpsSnapshot, observedAtMs: number): void {
    this.database
      .prepare(
        `INSERT INTO samples (
          device_id, observed_at, observed_at_ms, flow, status_tokens,
          battery_charge, runtime_seconds, load_percent, real_power, power_estimated,
          apparent_power, input_voltage, output_voltage, input_frequency,
          output_frequency, battery_voltage, temperature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.deviceId,
        snapshot.observedAt,
        observedAtMs,
        snapshot.flow,
        JSON.stringify(snapshot.statusTokens),
        snapshot.batteryCharge,
        snapshot.runtimeSeconds,
        snapshot.loadPercent,
        snapshot.realPower,
        snapshot.powerEstimated ? 1 : 0,
        snapshot.apparentPower,
        snapshot.inputVoltage,
        snapshot.outputVoltage,
        snapshot.inputFrequency,
        snapshot.outputFrequency,
        snapshot.batteryVoltage,
        snapshot.temperature,
      );
  }

  private insertEvent(event: PowerEventInput): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO events (
          device_id, occurred_at, occurred_at_ms, type, detail, tone,
          previous_state, new_state, transition_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.deviceId,
        event.occurredAt,
        Date.parse(event.occurredAt),
        event.type,
        event.detail,
        event.tone,
        event.previousState,
        event.newState,
        event.transitionKey,
      );
  }
}

function mapDeviceRow(row: DeviceRow): DeviceSummary {
  return {
    id: row.id,
    hostId: row.host_id,
    hostName: row.host_name ?? row.host_id,
    name: row.ups_name,
    description: row.description,
    model: row.model,
    manufacturer: row.manufacturer,
    availability: row.availability === 1 ? 'available' : 'unavailable',
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    snapshot: parseSnapshot(row.snapshot_json),
  };
}

function mapHostSummary(row: HostRow): HostSummary {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    endpointConfig: parseEndpointConfig(row.endpoint_config_json),
    credentialsConfigured: row.encrypted_credentials !== null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHostRecord(row: HostRow): HostRecord {
  return {
    ...mapHostSummary(row),
    encryptedCredentials: row.encrypted_credentials,
  };
}

function parseEndpointConfig(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseSnapshot(value: string | null): UpsSnapshot | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as UpsSnapshot;
  } catch {
    return null;
  }
}

function mapEventRow(row: EventRow): PowerEvent {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    occurredAt: row.occurred_at,
    type: row.type,
    detail: row.detail,
    tone: row.tone,
    previousState: row.previous_state,
    newState: row.new_state,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
