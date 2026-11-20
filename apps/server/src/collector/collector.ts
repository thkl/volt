import { DemoSource, DEMO_DEVICES } from '../demo/demo-source.js';
import { stableDeviceId } from '../domain/ids.js';
import { NutConnection, NutProtocolError, type NutUps } from '../nut/protocol.js';
import { normalizeUps } from '../nut/normalize.js';
import type { AppConfig } from '../config.js';
import { IngestionService } from './ingestion-service.js';
import type { CollectorMode } from '../domain/models.js';
import type { NutCredentials } from '../security/credentials.js';

export interface CollectorHealth {
  mode: CollectorMode;
  status: 'ready' | 'degraded';
  connected: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  phase?: 'starting' | 'connecting' | 'discovering' | 'reading' | 'idle' | 'ready' | 'error';
  discoveredUps?: number;
  upsNames?: string[];
  lastDiscoveryAt?: string | null;
  lastErrorCode?: string | null;
  consecutiveFailures?: number;
}

export interface Collector {
  start(): void;
  stop(): void;
  health(): CollectorHealth;
}

export class DemoCollector implements Collector {
  readonly source = new DemoSource();
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastPollAt: string | null = null;

  constructor(
    private readonly ingestion: IngestionService,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.isRunning = false;
  }

  health(): CollectorHealth {
    return {
      mode: 'demo',
      status: 'ready',
      connected: true,
      lastPollAt: this.lastPollAt,
      lastError: null,
    };
  }

  selectScenario(value: string): boolean {
    if (!this.source.selectScenario(value)) return false;
    this.poll();
    return true;
  }

  private poll(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const now = Date.now();
      for (const snapshot of this.source.snapshots(now)) {
        const device = DEMO_DEVICES.find((candidate) => candidate.id === snapshot.deviceId);
        this.ingestion.ingest(snapshot, device?.name ?? snapshot.deviceName);
      }
      this.lastPollAt = new Date(now).toISOString();
    } finally {
      this.isRunning = false;
    }
  }
}

export class NutCollector implements Collector {
  private timer: NodeJS.Timeout | null = null;
  private currentConnection: NutConnection | null = null;
  private isRunning = false;
  private connected = false;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private nextDiscoveryAt = 0;
  private failures = 0;
  private stopped = false;
  private phase: NonNullable<CollectorHealth['phase']> = 'starting';
  private lastDiscoveryAt: string | null = null;
  private lastErrorCode: string | null = null;
  private lastLoggedDiagnostic: string | null = null;
  private knownUps: NutUps[] = [];
  private readonly deviceFailures = new Map<string, number>();

  constructor(
    private readonly ingestion: IngestionService,
    private readonly config: AppConfig,
    private readonly hostId = `${config.nutHost}:${config.nutPort}`,
    private readonly credentials: NutCredentials | null = null,
  ) {
    if (!config.nutHost) throw new Error('NUT_HOST is required for the NUT collector');
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.pollAndSchedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.currentConnection?.close();
    this.currentConnection = null;
  }

  health(): CollectorHealth {
    return {
      mode: 'nut',
      status:
        this.connected && this.deviceFailures.size === 0 && this.knownUps.length > 0
          ? 'ready'
          : 'degraded',
      connected: this.connected,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      phase: this.phase,
      discoveredUps: this.knownUps.length,
      upsNames: this.knownUps.map((ups) => ups.name),
      lastDiscoveryAt: this.lastDiscoveryAt,
      lastErrorCode: this.lastErrorCode,
      consecutiveFailures: Math.max(this.failures, ...this.deviceFailures.values(), 0),
    };
  }

  async pollOnce(now = Date.now()): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.phase = 'connecting';
    let connection: NutConnection | null = null;
    try {
      connection = await NutConnection.connect(
        this.config.nutHost!,
        this.config.nutPort,
        this.config.requestTimeoutMs,
        { tls: this.config.nutTls, credentials: this.credentials },
      );
      this.currentConnection = connection;
      this.connected = true;
      this.failures = 0;

      if (now >= this.nextDiscoveryAt || this.knownUps.length === 0) {
        this.phase = 'discovering';
        const discovered = await connection.listUps();
        this.updateDiscovery(discovered, new Date(now).toISOString());
        this.knownUps = discovered;
        this.lastDiscoveryAt = new Date(now).toISOString();
        this.nextDiscoveryAt = now + this.config.discoveryIntervalMs;
      }

      this.phase = 'reading';
      for (const ups of this.knownUps) {
        const id = stableDeviceId(this.hostId, ups.name);
        try {
          const variables = await connection.listVariables(ups.name);
          const snapshot = normalizeUps(this.hostId, ups, variables, new Date(now).toISOString());
          this.deviceFailures.delete(id);
          this.ingestion.ingest(snapshot, ups.description);
        } catch (error) {
          const failures = (this.deviceFailures.get(id) ?? 0) + 1;
          this.deviceFailures.set(id, failures);
          const diagnostic = describeNutError(error);
          this.reportDiagnostic(
            `Failed to read UPS "${ups.name}": ${diagnostic.message}`,
            diagnostic.code,
            'reading',
          );
          if (failures >= 3) {
            this.ingestion.markUnavailable(id, 'No successful variable list in three polls');
          }
        }
      }

      this.lastPollAt = new Date(now).toISOString();
      if (this.deviceFailures.size === 0) this.connected = true;
      if (this.knownUps.length === 0) {
        this.reportDiagnostic(
          'NUT responded to discovery, but LIST UPS returned no UPS devices',
          'NO_UPS_DISCOVERED',
          'discovering',
        );
        this.phase = 'idle';
      } else if (this.deviceFailures.size === 0) {
        this.clearDiagnostic();
        this.phase = 'ready';
      } else {
        this.phase = 'error';
      }
    } catch (error) {
      this.connected = false;
      this.failures += 1;
      const diagnostic = describeNutError(error);
      this.reportDiagnostic(diagnostic.message, diagnostic.code, this.phase);
      this.phase = 'error';
      if (this.failures >= 3) {
        for (const ups of this.knownUps) {
          const id = stableDeviceId(this.hostId, ups.name);
          this.ingestion.markUnavailable(id, 'No successful NUT poll in three intervals');
        }
      }
    } finally {
      connection?.close();
      if (this.currentConnection === connection) this.currentConnection = null;
      this.isRunning = false;
    }
  }

  private async pollAndSchedule(): Promise<void> {
    await this.pollOnce();
    if (this.stopped) return;
    const backoffMs = this.failures === 0 ? 0 : Math.min(1000 * 2 ** (this.failures - 1), 60_000);
    const delay = Math.max(this.config.pollIntervalMs, backoffMs);
    this.timer = setTimeout(() => void this.pollAndSchedule(), delay);
    this.timer.unref();
  }

  private updateDiscovery(discovered: NutUps[], observedAt: string): void {
    const currentNames = new Set(discovered.map((ups) => ups.name));
    for (const previous of this.knownUps) {
      if (currentNames.has(previous.name)) continue;
      const id = stableDeviceId(this.hostId, previous.name);
      this.ingestion.markUnavailable(
        id,
        'UPS is no longer returned by NUT discovery',
        'unavailable',
      );
      this.deviceFailures.delete(id);
    }
    const discoveredIds = new Set(discovered.map((ups) => stableDeviceId(this.hostId, ups.name)));
    for (const id of this.deviceFailures.keys()) {
      if (!discoveredIds.has(id)) this.deviceFailures.delete(id);
    }
    this.lastPollAt = observedAt;
  }

  private reportDiagnostic(message: string, code: string, phase: string): void {
    this.lastError = message;
    this.lastErrorCode = code;
    const fingerprint = `${phase}:${code}:${message}`;
    if (this.lastLoggedDiagnostic === fingerprint) return;
    this.lastLoggedDiagnostic = fingerprint;
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'NUT collector diagnostic',
        hostId: this.hostId,
        host: this.config.nutHost,
        port: this.config.nutPort,
        phase,
        code,
        detail: message,
      }),
    );
  }

  private clearDiagnostic(): void {
    if (this.lastLoggedDiagnostic) {
      console.info(
        JSON.stringify({
          level: 'info',
          message: 'NUT collector recovered',
          hostId: this.hostId,
          host: this.config.nutHost,
          port: this.config.nutPort,
          discoveredUps: this.knownUps.length,
        }),
      );
    }
    this.lastLoggedDiagnostic = null;
    this.lastError = null;
    this.lastErrorCode = null;
  }
}

function describeNutError(error: unknown): { code: string; message: string } {
  if (error instanceof NutProtocolError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return { code: 'TIMEOUT', message: 'NUT request timed out' };
  }
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  if (errorCode && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/.test(errorCode)) {
    return { code: errorCode, message: `NUT server connection failed (${errorCode})` };
  }
  if (error instanceof Error && /TLS negotiation failed/.test(error.message)) {
    return { code: 'TLS_ERROR', message: error.message.slice(0, 240) };
  }
  return {
    code: errorCode ?? 'NUT_ERROR',
    message: error instanceof Error ? error.message.slice(0, 240) : 'Unknown NUT error',
  };
}
