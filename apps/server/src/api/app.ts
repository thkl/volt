import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';
import { isIP } from 'node:net';
import type { HostManager, NutHostInput } from '../collector/host-manager.js';
import type {
  HomeAssistantEntityMappings,
  HomeAssistantHostInput,
  HomeAssistantNumericField,
} from '../collector/homeassistant-config.js';
import { HOME_ASSISTANT_NUMERIC_FIELDS } from '../collector/homeassistant-config.js';
import type { AppConfig } from '../config.js';
import {
  DEMO_SCENARIOS,
  DATA_SOURCE_TYPES,
  OUTAGE_RANGES,
  type DataSourceTypeDescriptor,
  HISTORY_METRICS,
  HISTORY_RANGES,
  type HistoryMetric,
  type HistoryRange,
  type OutageRange,
  type ShutdownCoordination,
  type ShutdownReadinessPlan,
} from '../domain/models.js';
import { Store } from '../storage/store.js';
import { AuthManager } from '../auth/auth-manager.js';
import {
  AlertConfigurationError,
  AlertDeliveryError,
  AlertService,
} from '../alerts/alert-service.js';
import {
  InfluxConfigurationError,
  InfluxDbService,
  InfluxDeliveryError,
} from '../integrations/influxdb-service.js';
import {
  EnergyImpactConfigurationError,
  EnergyImpactService,
} from '../energy/energy-impact-service.js';
import {
  ANALYTICS_RATE_LIMIT,
  API_RATE_LIMIT,
  INTEGRATION_TEST_RATE_LIMIT,
  TokenBucketRateLimiter,
} from './rate-limiter.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiDependencies {
  config: AppConfig;
  store: Store;
  collector: HostManager;
  collectorTypes?: DataSourceTypeDescriptor[];
  authManager?: AuthManager;
  alertService?: AlertService;
  influxDbService?: InfluxDbService;
  energyImpactService?: EnergyImpactService;
}

const SHUTDOWN_READINESS_KEY_PREFIX = 'shutdown-readiness:';

export function createApp({
  config,
  store,
  collector,
  collectorTypes = [...DATA_SOURCE_TYPES],
  authManager = new AuthManager(config),
  alertService,
  influxDbService,
  energyImpactService,
}: ApiDependencies): Express {
  const app = express();
  const apiRateLimiter = new TokenBucketRateLimiter('API', API_RATE_LIMIT);
  const analyticsRateLimiter = new TokenBucketRateLimiter('analytics', ANALYTICS_RATE_LIMIT);
  const integrationTestRateLimiter = new TokenBucketRateLimiter(
    'integration test',
    INTEGRATION_TEST_RATE_LIMIT,
  );
  if (config.trustedProxyCidrs.length > 0) {
    app.set('trust proxy', [...config.trustedProxyCidrs]);
  }
  app.disable('x-powered-by');
  app.use(noCache);
  app.use(cors(config));
  app.use('/api', apiRateLimiter.middleware);
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use('/api/auth', authManager.router());
  app.use('/api', authManager.middleware, authManager.csrfGuard);

  app.get('/api/health', (_request, response) => {
    const collectorHealth = collector.health();
    response.json({
      status: 'ok',
      demoMode: collectorHealth.mode === 'demo',
      collector: collectorHealth,
      sources: collector.sourceHealth(),
      storage: { status: 'ready' },
    });
  });

  app.get('/api/diagnostics/internals', (_request, response) => {
    const memory = process.memoryUsage();
    response.json({
      data: {
        uptimeMs: Math.floor(process.uptime() * 1000),
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
        },
        database: store.getDiagnostics(),
        collectedAt: new Date().toISOString(),
      },
    });
  });

  app.get('/api/hosts', (_request, response) => {
    response.json({ data: store.listEnabledHosts() });
  });

  app.get('/api/hosts/:id/health', (request, response) => {
    const hostId = request.params['id'] ?? '';
    const host = collector.sourceHealthById(hostId);
    if (!host) throw new ApiError(404, 'not_found', 'Host is not configured or enabled');
    response.json({ data: host });
  });

  app.get('/api/collector-types', (_request, response) => {
    response.json({ data: collectorTypes });
  });

  app.get('/api/alerts/settings', (_request, response) => {
    if (!alertService)
      throw new ApiError(503, 'alerts_unavailable', 'Alert settings are unavailable');
    response.json({ data: alertService.getSettings() });
  });

  app.put('/api/alerts/settings', (request, response) => {
    if (!alertService)
      throw new ApiError(503, 'alerts_unavailable', 'Alert settings are unavailable');
    try {
      response.json({ data: alertService.saveSettings(request.body) });
    } catch (error) {
      throw alertConfigurationError(error);
    }
  });

  app.post('/api/alerts/test', integrationTestRateLimiter.middleware, async (request, response) => {
    if (!alertService)
      throw new ApiError(503, 'alerts_unavailable', 'Alert settings are unavailable');
    const channel = isRecord(request.body) ? request.body['channel'] : undefined;
    if (channel !== 'pushover' && channel !== 'email') {
      throw new ApiError(400, 'validation_error', 'Choose Pushover or email as the test channel');
    }
    try {
      await alertService.sendTest(channel);
      response.json({ data: { sent: true } });
    } catch (error) {
      throw alertConfigurationError(error);
    }
  });

  app.get('/api/integrations/influxdb/settings', (_request, response) => {
    if (!influxDbService) {
      throw new ApiError(503, 'integration_unavailable', 'InfluxDB integration is unavailable');
    }
    response.json({ data: influxDbService.getSettings() });
  });

  app.put('/api/integrations/influxdb/settings', (request, response) => {
    if (!influxDbService) {
      throw new ApiError(503, 'integration_unavailable', 'InfluxDB integration is unavailable');
    }
    try {
      response.json({ data: influxDbService.saveSettings(request.body) });
    } catch (error) {
      throw influxConfigurationError(error);
    }
  });

  app.post(
    '/api/integrations/influxdb/test',
    integrationTestRateLimiter.middleware,
    async (_request, response) => {
      if (!influxDbService) {
        throw new ApiError(503, 'integration_unavailable', 'InfluxDB integration is unavailable');
      }
      try {
        await influxDbService.sendTestWrite();
        response.json({ data: { sent: true } });
      } catch (error) {
        throw influxConfigurationError(error);
      }
    },
  );

  app.get('/api/energy-impact/settings', (_request, response) => {
    if (!energyImpactService) {
      throw new ApiError(
        503,
        'energy_impact_unavailable',
        'Energy impact settings are unavailable',
      );
    }
    response.json({ data: energyImpactService.getSettings() });
  });

  app.put('/api/energy-impact/settings', (request, response) => {
    if (!energyImpactService) {
      throw new ApiError(
        503,
        'energy_impact_unavailable',
        'Energy impact settings are unavailable',
      );
    }
    try {
      response.json({ data: energyImpactService.saveSettings(request.body) });
    } catch (error) {
      throw energyImpactConfigurationError(error);
    }
  });

  app.post('/api/hosts', (request, response) => {
    try {
      if (isRecord(request.body) && request.body['sourceType'] === 'homeassistant') {
        const host = parseHomeAssistantHostInput(request.body);
        response.status(201).json({ data: collector.addHomeAssistantHost(host) });
      } else {
        const host = parseNutHostInput(request.body);
        response.status(201).json({ data: collector.addNutHost(host) });
      }
    } catch (error) {
      throw hostMutationError(error);
    }
  });

  app.put('/api/hosts/:id', (request, response) => {
    try {
      if (isRecord(request.body) && request.body['sourceType'] === 'homeassistant') {
        const host = parseHomeAssistantHostInput(request.body);
        response.json({
          data: collector.updateHomeAssistantHost(request.params['id'] ?? '', host),
        });
      } else {
        const host = parseNutHostInput(request.body);
        response.json({ data: collector.updateNutHost(request.params['id'] ?? '', host) });
      }
    } catch (error) {
      throw hostMutationError(error);
    }
  });

  app.delete('/api/hosts/:id', (request, response) => {
    try {
      collector.removeHost(request.params['id'] ?? '');
      response.json({ data: { removed: true } });
    } catch (error) {
      throw hostMutationError(error);
    }
  });

  app.get('/api/devices', (_request, response) => {
    response.json({ data: store.listDevices() });
  });

  app.get('/api/devices/:id', (request, response) => {
    const device = store.getDevice(request.params['id'] ?? '');
    if (!device) throw new ApiError(404, 'not_found', 'Device not found');
    response.json({ data: device });
  });

  app.get('/api/devices/:id/history', analyticsRateLimiter.middleware, (request, response) => {
    const deviceId = routeParam(request.params['id']);
    if (!store.getDevice(deviceId)) throw new ApiError(404, 'not_found', 'Device not found');
    const range = parseRange(request.query['range']);
    const metrics = parseMetrics(request.query['metrics']);
    response.json({ data: store.getHistory(deviceId, range, metrics) });
  });

  app.get(
    '/api/devices/:id/energy-impact',
    analyticsRateLimiter.middleware,
    (request, response) => {
      if (!energyImpactService) {
        throw new ApiError(503, 'energy_impact_unavailable', 'Energy impact is unavailable');
      }
      const deviceId = routeParam(request.params['id']);
      if (!store.getDevice(deviceId)) throw new ApiError(404, 'not_found', 'Device not found');
      try {
        const timeZone = queryString(request.query['timeZone']) ?? 'UTC';
        response.json({ data: energyImpactService.getImpact(deviceId, timeZone) });
      } catch (error) {
        throw energyImpactConfigurationError(error);
      }
    },
  );

  app.get('/api/devices/:id/outages', analyticsRateLimiter.middleware, (request, response) => {
    const deviceId = routeParam(request.params['id']);
    if (!store.getDevice(deviceId)) throw new ApiError(404, 'not_found', 'Device not found');
    const range = parseOutageRange(request.query['range']);
    response.json({ data: store.getOutageSummary(deviceId, range) });
  });

  app.get('/api/events', analyticsRateLimiter.middleware, (request, response) => {
    const deviceId = queryString(request.query['device']);
    if (deviceId && !store.getDevice(deviceId)) {
      throw new ApiError(404, 'not_found', 'Device not found');
    }
    const limit = parseLimit(request.query['limit']);
    const cursorId = parseCursor(queryString(request.query['cursor']));
    const page = store.getEvents({
      ...(deviceId ? { deviceId } : {}),
      limit,
      ...(cursorId !== undefined ? { cursorId } : {}),
    });
    response.json(page);
  });

  app.get('/api/shutdown-readiness', (_request, response) => {
    const plans = store.listDevices().map((device) => readShutdownPlan(store, device.id));
    response.json({ data: plans });
  });

  app.put('/api/shutdown-readiness/:deviceId', (request, response) => {
    const deviceId = request.params['deviceId'] ?? '';
    if (!store.getDevice(deviceId)) throw new ApiError(404, 'not_found', 'UPS device not found');
    const input = parseShutdownPlanInput(request.body);
    const plan: ShutdownReadinessPlan = {
      deviceId,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    store.setAppSetting(`${SHUTDOWN_READINESS_KEY_PREFIX}${deviceId}`, JSON.stringify(plan));
    response.json({ data: plan });
  });

  app.post('/api/demo/scenario', (request, response) => {
    const scenario = (request.body as { scenario?: unknown } | undefined)?.scenario;
    if (typeof scenario !== 'string' || !DEMO_SCENARIOS.some((item) => item.id === scenario)) {
      throw new ApiError(400, 'validation_error', 'A supported demo scenario is required');
    }
    if (!collector.selectDemoScenario(scenario)) {
      throw new ApiError(404, 'not_found', 'Demo controls are not available');
    }
    response.json({ data: { scenario: collector.getDemoScenario() } });
  });

  app.post('/api/demo/ups', (_request, response) => {
    try {
      response.status(201).json({ data: collector.addDemoUps() });
    } catch (error) {
      throw hostMutationError(error);
    }
  });

  app.use('/api', (_request, _response) => {
    throw new ApiError(404, 'not_found', 'API endpoint not found');
  });

  const indexPath = join(resolve(config.webDistDir), 'index.html');
  if (existsSync(indexPath)) {
    app.use(express.static(resolve(config.webDistDir), { index: false, fallthrough: true }));
    app.get(/^(?!\/api\/).*/, (_request, response, next) => {
      response.sendFile(indexPath, (error) => {
        if (error) next(error);
      });
    });
  }

  app.use((_request, _response, next) => next(new ApiError(404, 'not_found', 'Route not found')));
  app.use(errorHandler);
  return app;
}

const noCache: express.RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

function cors(config: AppConfig): express.RequestHandler {
  return (request, response, next) => {
    const origin = request.header('origin');
    if (origin && !isAllowedOrigin(origin, request, config)) {
      next(new ApiError(403, 'origin_not_allowed', 'Request origin is not allowed'));
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  };
}

function isAllowedOrigin(origin: string, request: Request, config: AppConfig): boolean {
  if (config.webOrigins.has(origin)) return true;
  try {
    return new URL(origin).host === request.get('host');
  } catch {
    return false;
  }
}

function parseRange(value: unknown): HistoryRange {
  const range = queryString(value) ?? '24h';
  if (!HISTORY_RANGES.some((candidate) => candidate === range)) {
    throw new ApiError(400, 'validation_error', 'Range must be one of 1h, 24h, 7d or 30d');
  }
  return range as HistoryRange;
}

function parseOutageRange(value: unknown): OutageRange {
  const range = queryString(value) ?? '30d';
  if (!OUTAGE_RANGES.some((candidate) => candidate === range)) {
    throw new ApiError(400, 'validation_error', 'Outage range must be one of 24h, 7d, 30d or 90d');
  }
  return range as OutageRange;
}

function parseMetrics(value: unknown): HistoryMetric[] {
  const raw =
    queryString(value) ?? 'realPower,loadPercent,batteryCharge,inputVoltage,outputVoltage';
  const metrics = [
    ...new Set(
      raw
        .split(',')
        .map((metric) => metric.trim())
        .filter(Boolean),
    ),
  ];
  if (
    metrics.length === 0 ||
    metrics.some((metric) => !HISTORY_METRICS.includes(metric as HistoryMetric))
  ) {
    throw new ApiError(400, 'validation_error', 'One or more history metrics are unsupported');
  }
  return metrics as HistoryMetric[];
}

function parseLimit(value: unknown): number {
  const raw = queryString(value) ?? '50';
  if (!/^\d+$/.test(raw)) throw new ApiError(400, 'validation_error', 'Limit must be an integer');
  const limit = Number(raw);
  if (limit < 1 || limit > 100) {
    throw new ApiError(400, 'validation_error', 'Limit must be between 1 and 100');
  }
  return limit;
}

function parseCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (!/^\d+$/.test(decoded)) throw new Error('Invalid cursor');
    const cursor = Number(decoded);
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('Invalid cursor');
    return cursor;
  } catch {
    throw new ApiError(400, 'validation_error', 'Cursor is invalid');
  }
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function routeParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function parseNutHostInput(value: unknown): NutHostInput {
  if (!isRecord(value)) {
    throw new ApiError(400, 'validation_error', 'Host settings must be an object');
  }
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const host = typeof value['host'] === 'string' ? value['host'].trim() : '';
  const port = value['port'];
  const tls = value['tls'];
  const username = typeof value['username'] === 'string' ? value['username'].trim() : '';
  const password = typeof value['password'] === 'string' ? value['password'] : '';
  const clearCredentials = value['clearCredentials'] === true;

  if (!name || name.length > 100) {
    throw new ApiError(
      400,
      'validation_error',
      'Name is required and must be 100 characters or fewer',
    );
  }
  if (!isValidHost(host)) {
    throw new ApiError(400, 'validation_error', 'Enter a valid NUT host name or IP address');
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, 'validation_error', 'Port must be an integer between 1 and 65535');
  }
  if (typeof tls !== 'boolean') {
    throw new ApiError(400, 'validation_error', 'TLS must be true or false');
  }
  if (username.length > 256 || password.length > 256) {
    throw new ApiError(400, 'validation_error', 'NUT credentials must be 256 characters or fewer');
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new ApiError(400, 'validation_error', 'Enter both a username and password');
  }
  if (clearCredentials && username) {
    throw new ApiError(
      400,
      'validation_error',
      'Enter new credentials or remove saved credentials',
    );
  }
  return {
    name,
    host,
    port,
    tls,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    clearCredentials,
  };
}

function parseHomeAssistantHostInput(value: unknown): HomeAssistantHostInput {
  if (!isRecord(value)) {
    throw new ApiError(400, 'validation_error', 'Home Assistant settings must be an object');
  }
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const rawUrl = typeof value['url'] === 'string' ? value['url'].trim() : '';
  const accessToken = typeof value['accessToken'] === 'string' ? value['accessToken'] : '';
  if (!name || name.length > 100) {
    throw new ApiError(
      400,
      'validation_error',
      'Name is required and must be 100 characters or fewer',
    );
  }
  if (!rawUrl || rawUrl.length > 2048) {
    throw new ApiError(400, 'validation_error', 'Enter a valid Home Assistant URL');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'validation_error', 'Enter an absolute Home Assistant URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      400,
      'validation_error',
      'Home Assistant URL must use HTTP or HTTPS without credentials, query or fragment',
    );
  }
  if (accessToken.length > 4096) {
    throw new ApiError(400, 'validation_error', 'Home Assistant access token is too long');
  }

  const rawEntities = value['entities'];
  if (!isRecord(rawEntities) || !isRecord(rawEntities['metrics'])) {
    throw new ApiError(400, 'validation_error', 'Map at least one Home Assistant entity');
  }
  const metricsInput = rawEntities['metrics'];
  const metrics = Object.fromEntries(
    HOME_ASSISTANT_NUMERIC_FIELDS.map((field) => [
      field,
      parseHomeAssistantMetric(metricsInput[field], field),
    ]),
  ) as HomeAssistantEntityMappings['metrics'];
  const entities: HomeAssistantEntityMappings = {
    statusEntityId: parseHomeAssistantEntityId(rawEntities['statusEntityId'], 'UPS status'),
    onBatteryEntityId: parseHomeAssistantEntityId(rawEntities['onBatteryEntityId'], 'On-battery'),
    chargingEntityId: parseHomeAssistantEntityId(rawEntities['chargingEntityId'], 'Charging'),
    lowBatteryEntityId: parseHomeAssistantEntityId(
      rawEntities['lowBatteryEntityId'],
      'Low-battery',
    ),
    metrics,
  };
  if (
    !entities.statusEntityId &&
    !entities.onBatteryEntityId &&
    !entities.chargingEntityId &&
    !entities.lowBatteryEntityId &&
    !HOME_ASSISTANT_NUMERIC_FIELDS.some((field) => metrics[field])
  ) {
    throw new ApiError(400, 'validation_error', 'Map at least one Home Assistant entity');
  }

  return {
    name,
    url: url.toString().replace(/\/$/, ''),
    accessToken: accessToken.trim(),
    entities,
  };
}

function parseHomeAssistantEntityId(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(value.trim())
  ) {
    throw new ApiError(400, 'validation_error', `${label} entity ID is invalid`);
  }
  return value.trim();
}

function parseHomeAssistantMetric(
  value: unknown,
  field: HomeAssistantNumericField,
): { entityId: string; scale: number } | null {
  if (!isRecord(value)) {
    throw new ApiError(400, 'validation_error', `The ${field} mapping is invalid`);
  }
  const entityId = parseHomeAssistantEntityId(value['entityId'], field);
  if (!entityId) return null;
  const scale = value['scale'] === undefined ? 1 : value['scale'];
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 || scale > 1_000_000) {
    throw new ApiError(
      400,
      'validation_error',
      `The ${field} scaling factor must be greater than 0 and no more than 1,000,000`,
    );
  }
  return { entityId, scale };
}

function parseShutdownPlanInput(
  value: unknown,
): Omit<ShutdownReadinessPlan, 'deviceId' | 'updatedAt'> {
  if (!isRecord(value) || !Array.isArray(value['dependentSystems'])) {
    throw new ApiError(400, 'validation_error', 'A list of dependent systems is required');
  }
  if (value['dependentSystems'].length > 25) {
    throw new ApiError(400, 'validation_error', 'List no more than 25 dependent systems');
  }

  const dependentSystems: string[] = [];
  const seen = new Set<string>();
  for (const item of value['dependentSystems']) {
    if (typeof item !== 'string') {
      throw new ApiError(400, 'validation_error', 'Dependent system names must be text');
    }
    const name = item.trim();
    if (!name || name.length > 100) {
      throw new ApiError(
        400,
        'validation_error',
        'Dependent system names must contain 1 to 100 characters',
      );
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      dependentSystems.push(name);
      seen.add(key);
    }
  }

  const coordination = value['coordination'];
  if (
    coordination !== 'unverified' &&
    coordination !== 'verified' &&
    coordination !== 'not_configured'
  ) {
    throw new ApiError(400, 'validation_error', 'Choose a valid shutdown coordination status');
  }

  return { dependentSystems, coordination: coordination as ShutdownCoordination };
}

function readShutdownPlan(store: Store, deviceId: string): ShutdownReadinessPlan {
  const raw = store.getAppSetting(`${SHUTDOWN_READINESS_KEY_PREFIX}${deviceId}`);
  if (!raw) {
    return { deviceId, dependentSystems: [], coordination: 'unverified', updatedAt: null };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError(500, 'settings_error', 'Shutdown readiness settings could not be read');
  }
  if (
    !isRecord(value) ||
    value['deviceId'] !== deviceId ||
    !Array.isArray(value['dependentSystems']) ||
    !value['dependentSystems'].every((item) => typeof item === 'string') ||
    (value['coordination'] !== 'unverified' &&
      value['coordination'] !== 'verified' &&
      value['coordination'] !== 'not_configured') ||
    (value['updatedAt'] !== null && typeof value['updatedAt'] !== 'string')
  ) {
    throw new ApiError(500, 'settings_error', 'Shutdown readiness settings could not be read');
  }
  return value as unknown as ShutdownReadinessPlan;
}

function isValidHost(host: string): boolean {
  if (!host || host.length > 253 || /[\s/@?#]/.test(host)) return false;
  if (isIP(host) !== 0) return true;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return false;
  const normalized = host.endsWith('.') ? host.slice(0, -1) : host;
  return normalized
    .split('.')
    .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hostMutationError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : 'Host settings could not be saved';
  return new ApiError(message.endsWith('not found') ? 404 : 400, 'host_error', message);
}

function alertConfigurationError(error: unknown): ApiError {
  if (error instanceof AlertConfigurationError) {
    return new ApiError(400, 'alert_configuration_error', error.message);
  }
  if (error instanceof AlertDeliveryError) {
    return new ApiError(
      502,
      'alert_delivery_failed',
      'The test alert could not be delivered. Check the channel settings and server logs.',
    );
  }
  return new ApiError(500, 'internal_error', 'Alert settings could not be saved');
}

function influxConfigurationError(error: unknown): ApiError {
  if (error instanceof InfluxConfigurationError) {
    return new ApiError(400, 'influx_configuration_error', error.message);
  }
  if (error instanceof InfluxDeliveryError) {
    return new ApiError(502, 'influx_delivery_failed', error.message);
  }
  return new ApiError(500, 'internal_error', 'InfluxDB settings could not be saved');
}

function energyImpactConfigurationError(error: unknown): ApiError {
  if (error instanceof EnergyImpactConfigurationError) {
    return new ApiError(400, 'energy_impact_configuration_error', error.message);
  }
  return new ApiError(500, 'internal_error', 'Energy impact could not be calculated');
}

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response: Response, _next) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  const code = (error as { type?: string } | undefined)?.type;
  if (code === 'entity.parse.failed' || code === 'entity.too.large') {
    response.status(code === 'entity.too.large' ? 413 : 400).json({
      error: {
        code: code === 'entity.too.large' ? 'payload_too_large' : 'invalid_json',
        message:
          code === 'entity.too.large'
            ? 'Request body is too large'
            : 'Request body must be valid JSON',
      },
    });
    return;
  }
  console.error(JSON.stringify({ level: 'error', message: 'Unhandled API error' }));
  response
    .status(500)
    .json({ error: { code: 'internal_error', message: 'Internal server error' } });
};
