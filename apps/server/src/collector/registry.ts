import {
  DATA_SOURCE_TYPES,
  type DataSourceType,
  type DataSourceTypeDescriptor,
} from '../domain/models.js';
import type { AppConfig } from '../config.js';
import type { HostCredentials, NutCredentials } from '../security/credentials.js';
import { DemoCollector, NutCollector, type Collector } from './collector.js';
import type { DemoDevice } from '../demo/demo-source.js';
import { HomeAssistantCollector } from './homeassistant-collector.js';
import type { IngestionService } from './ingestion-service.js';

export interface CollectorContext {
  config: AppConfig;
  ingestion: IngestionService;
  hostId: string;
  hostName: string;
  endpointConfig: Record<string, unknown>;
  credentials: HostCredentials | null;
}

export interface CollectorAdapter {
  readonly type: DataSourceType;
  create(context: CollectorContext): Collector;
}

export class CollectorRegistry {
  private readonly adapters: ReadonlyMap<DataSourceType, CollectorAdapter>;

  constructor(adapters: CollectorAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.type, adapter]));
    if (this.adapters.size !== adapters.length) {
      throw new Error('Collector adapter types must be unique');
    }
  }

  create(type: DataSourceType, context: CollectorContext): Collector {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`Collector type "${type}" is registered for future use but not implemented`);
    }
    return adapter.create(context);
  }

  catalog(): DataSourceTypeDescriptor[] {
    return DATA_SOURCE_TYPES.map((source) => ({
      ...source,
      implemented: this.adapters.has(source.type),
    }));
  }
}

export function createDefaultCollectorRegistry(): CollectorRegistry {
  return new CollectorRegistry([
    {
      type: 'demo',
      create: ({ ingestion, config, hostName, endpointConfig }) => {
        const demoUpsId = endpointConfig['demoUpsId'];
        if (typeof demoUpsId === 'string') {
          const device: DemoDevice = {
            id: `demo-ups-${demoUpsId}`,
            name: hostName,
            model: 'Demo UPS · 1500 VA',
            loadOffset: numericOffset(endpointConfig['loadOffset']),
            powerOffset: numericOffset(endpointConfig['powerOffset']),
          };
          return new DemoCollector(ingestion, config.pollIntervalMs, [device]);
        }
        return new DemoCollector(ingestion, config.pollIntervalMs);
      },
    },
    {
      type: 'nut',
      create: ({ ingestion, config, hostId, credentials }) =>
        new NutCollector(ingestion, config, hostId, asNutCredentials(credentials)),
    },
    {
      type: 'homeassistant',
      create: ({ ingestion, config, hostId, hostName, endpointConfig, credentials }) =>
        new HomeAssistantCollector(
          ingestion,
          config,
          hostId,
          hostName,
          endpointConfig,
          credentials,
        ),
    },
  ]);
}

function asNutCredentials(credentials: HostCredentials | null): NutCredentials | null {
  if (!credentials) return null;
  const { username, password } = credentials;
  if (!username || !password) {
    throw new Error('NUT credentials must contain a username and password');
  }
  return { username, password };
}

function numericOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
