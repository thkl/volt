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
import type { AppConfig } from '../config.js';
import {
  DEMO_SCENARIOS,
  DATA_SOURCE_TYPES,
  type DataSourceTypeDescriptor,
  HISTORY_METRICS,
  HISTORY_RANGES,
  type HistoryMetric,
  type HistoryRange,
} from '../domain/models.js';
import { Store } from '../storage/store.js';
import { AuthManager } from '../auth/auth-manager.js';
import {
  AlertConfigurationError,
  AlertDeliveryError,
  AlertService,
} from '../alerts/alert-service.js';

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
}

export function createApp({
  config,
  store,
  collector,
  collectorTypes = [...DATA_SOURCE_TYPES],
  authManager = new AuthManager(config),
  alertService,
}: ApiDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(noCache);
  app.use(cors(config));
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

  app.post('/api/alerts/test', async (request, response) => {
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

  app.post('/api/hosts', (request, response) => {
    const host = parseNutHostInput(request.body);
    try {
      response.status(201).json({ data: collector.addNutHost(host) });
    } catch (error) {
      throw hostMutationError(error);
    }
  });

  app.put('/api/hosts/:id', (request, response) => {
    const host = parseNutHostInput(request.body);
    try {
      response.json({ data: collector.updateNutHost(request.params['id'] ?? '', host) });
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

  app.get('/api/devices/:id/history', (request, response) => {
    const deviceId = request.params['id'] ?? '';
    if (!store.getDevice(deviceId)) throw new ApiError(404, 'not_found', 'Device not found');
    const range = parseRange(request.query['range']);
    const metrics = parseMetrics(request.query['metrics']);
    response.json({ data: store.getHistory(deviceId, range, metrics) });
  });

  app.get('/api/events', (request, response) => {
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
