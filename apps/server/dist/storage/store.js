import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const RANGE_MS = {
    '1h': 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
};
const METRIC_COLUMNS = {
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
    database;
    constructor(path) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        this.database = new DatabaseSync(path);
        this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        if (path !== ':memory:')
            this.database.exec('PRAGMA journal_mode = WAL;');
        this.migrate();
    }
    close() {
        this.database.close();
    }
    upsertHost(host, clearCredentials = false) {
        const now = new Date().toISOString();
        this.database
            .prepare(`INSERT INTO hosts (
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
          updated_at = excluded.updated_at`)
            .run(host.id, host.name, host.sourceType, JSON.stringify(host.endpointConfig), host.encryptedCredentials, host.enabled ? 1 : 0, now, now, clearCredentials ? 1 : 0);
    }
    listHosts() {
        const rows = this.database
            .prepare('SELECT * FROM hosts ORDER BY name COLLATE NOCASE, id')
            .all();
        return rows.map(mapHostSummary);
    }
    listEnabledHosts() {
        const rows = this.database
            .prepare('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id')
            .all();
        return rows.map(mapHostSummary);
    }
    listEnabledHostRecords() {
        const rows = this.database
            .prepare('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id')
            .all();
        return rows.map(mapHostRecord);
    }
    disableHost(id) {
        const result = this.database
            .prepare('UPDATE hosts SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1')
            .run(new Date().toISOString(), id);
        return Number(result.changes) > 0;
    }
    disableHostsByType(sourceType) {
        const rows = this.database
            .prepare('SELECT id FROM hosts WHERE source_type = ? AND enabled = 1')
            .all(sourceType);
        this.database
            .prepare('UPDATE hosts SET enabled = 0, updated_at = ? WHERE source_type = ? AND enabled = 1')
            .run(new Date().toISOString(), sourceType);
        return rows.map((row) => row.id);
    }
    getHostRecord(id) {
        const row = this.database.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
        return row ? mapHostRecord(row) : null;
    }
    listDevices() {
        const rows = this.database
            .prepare(`SELECT devices.*, hosts.name AS host_name FROM devices
         JOIN hosts ON hosts.id = devices.host_id AND hosts.enabled = 1
         ORDER BY hosts.name COLLATE NOCASE, devices.ups_name COLLATE NOCASE, devices.id`)
            .all();
        return rows.map(mapDeviceRow);
    }
    getDevice(id) {
        const row = this.database
            .prepare(`SELECT devices.*, hosts.name AS host_name FROM devices
         JOIN hosts ON hosts.id = devices.host_id WHERE devices.id = ?`)
            .get(id);
        return row ? mapDeviceRow(row) : null;
    }
    getLastSampleAt(id) {
        const row = this.database
            .prepare('SELECT MAX(observed_at_ms) AS latest FROM samples WHERE device_id = ?')
            .get(id);
        return row?.latest ?? null;
    }
    writeObservation(snapshot, description, hostId, events, includeSample) {
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
                .prepare(`INSERT INTO devices (
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
            snapshot_json = excluded.snapshot_json`)
                .run(snapshot.deviceId, hostId, hostId, snapshot.deviceName, description || snapshot.deviceName, snapshot.model, snapshot.manufacturer, snapshot.freshness === 'fresh' ? 1 : 0, firstSeenAt, lastSeenAt ?? null, snapshot.observedAt, observedAtMs, snapshot.flow, JSON.stringify(snapshot.statusTokens), JSON.stringify(snapshot));
            if (includeSample)
                this.insertSample(snapshot, observedAtMs);
            for (const event of events)
                this.insertEvent(event);
            this.database.exec('COMMIT');
        }
        catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
    getHistory(deviceId, range, metrics, now = Date.now()) {
        const durationMs = RANGE_MS[range];
        const fromMs = now - durationMs;
        const bucketMs = Math.max(30_000, Math.ceil(durationMs / 1000 / 30_000) * 30_000);
        const aggregateColumns = metrics
            .map((metric) => {
            const column = METRIC_COLUMNS[metric];
            return `AVG(${column}) AS ${metric}_avg, MIN(${column}) AS ${metric}_min, MAX(${column}) AS ${metric}_max`;
        })
            .join(', ');
        const statement = this.database.prepare(`SELECT CAST(observed_at_ms / ? AS INTEGER) * ? AS bucket_ms, ${aggregateColumns}
       FROM samples
       WHERE device_id = ? AND observed_at_ms >= ?
       GROUP BY bucket_ms
       ORDER BY bucket_ms ASC
       LIMIT 1000`);
        const rows = statement.all(bucketMs, bucketMs, deviceId, fromMs);
        const series = {};
        for (const metric of metrics) {
            const points = [];
            for (const row of rows) {
                const value = row[`${metric}_avg`];
                const minimum = row[`${metric}_min`];
                const maximum = row[`${metric}_max`];
                if (value === null ||
                    value === undefined ||
                    minimum === null ||
                    minimum === undefined ||
                    maximum === null ||
                    maximum === undefined) {
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
    getEvents(options) {
        const conditions = [];
        const params = [];
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
            .prepare(`SELECT events.*, devices.ups_name AS device_name
         FROM events JOIN devices ON devices.id = events.device_id
         ${where}
         ORDER BY events.occurred_at_ms DESC, events.id DESC
         LIMIT ?`)
            .all(...params, options.limit + 1);
        const hasMore = rows.length > options.limit;
        const visibleRows = rows.slice(0, options.limit);
        const data = visibleRows.map(mapEventRow);
        const last = visibleRows[visibleRows.length - 1];
        return {
            data,
            nextCursor: hasMore && last ? Buffer.from(String(last.id)).toString('base64url') : null,
        };
    }
    deleteExpired(sampleCutoffMs, eventCutoffMs) {
        this.database.exec('BEGIN IMMEDIATE');
        try {
            const samples = Number(this.database.prepare('DELETE FROM samples WHERE observed_at_ms < ?').run(sampleCutoffMs)
                .changes);
            const events = Number(this.database.prepare('DELETE FROM events WHERE occurred_at_ms < ?').run(eventCutoffMs)
                .changes);
            this.database.exec('COMMIT');
            return { samples, events };
        }
        catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
    countSamples(deviceId) {
        const row = this.database
            .prepare('SELECT COUNT(*) AS count FROM samples WHERE device_id = ?')
            .get(deviceId);
        return row.count;
    }
    getAppSetting(key) {
        const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
        return row?.value ?? null;
    }
    setAppSetting(key, value) {
        this.database
            .prepare(`INSERT INTO app_settings(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(key, value);
    }
    migrate() {
        this.database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;');
        if (this.schemaVersion() < 1) {
            this.database.exec('BEGIN IMMEDIATE');
            try {
                this.database.exec(INITIAL_SCHEMA);
                this.recordMigration(1);
                this.database.exec('COMMIT');
            }
            catch (error) {
                this.database.exec('ROLLBACK');
                throw error;
            }
        }
        if (this.schemaVersion() < 2)
            this.migrateHosts();
        if (this.schemaVersion() < 3)
            this.migrateAppSettings();
    }
    schemaVersion() {
        const applied = this.database
            .prepare('SELECT MAX(version) AS version FROM schema_migrations')
            .get();
        return applied.version ?? 0;
    }
    recordMigration(version) {
        this.database
            .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
            .run(version, new Date().toISOString());
    }
    migrateHosts() {
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
        }
        catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
    migrateAppSettings() {
        this.database.exec('BEGIN IMMEDIATE');
        try {
            this.database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
            this.recordMigration(3);
            this.database.exec('COMMIT');
        }
        catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
    insertSample(snapshot, observedAtMs) {
        this.database
            .prepare(`INSERT INTO samples (
          device_id, observed_at, observed_at_ms, flow, status_tokens,
          battery_charge, runtime_seconds, load_percent, real_power, power_estimated,
          apparent_power, input_voltage, output_voltage, input_frequency,
          output_frequency, battery_voltage, temperature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(snapshot.deviceId, snapshot.observedAt, observedAtMs, snapshot.flow, JSON.stringify(snapshot.statusTokens), snapshot.batteryCharge, snapshot.runtimeSeconds, snapshot.loadPercent, snapshot.realPower, snapshot.powerEstimated ? 1 : 0, snapshot.apparentPower, snapshot.inputVoltage, snapshot.outputVoltage, snapshot.inputFrequency, snapshot.outputFrequency, snapshot.batteryVoltage, snapshot.temperature);
    }
    insertEvent(event) {
        this.database
            .prepare(`INSERT OR IGNORE INTO events (
          device_id, occurred_at, occurred_at_ms, type, detail, tone,
          previous_state, new_state, transition_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(event.deviceId, event.occurredAt, Date.parse(event.occurredAt), event.type, event.detail, event.tone, event.previousState, event.newState, event.transitionKey);
    }
}
function mapDeviceRow(row) {
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
function mapHostSummary(row) {
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
function mapHostRecord(row) {
    return {
        ...mapHostSummary(row),
        encryptedCredentials: row.encrypted_credentials,
    };
}
function parseEndpointConfig(value) {
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
        return {};
    }
}
function parseSnapshot(value) {
    if (!value)
        return null;
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function mapEventRow(row) {
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
function round(value) {
    return Math.round(value * 100) / 100;
}
