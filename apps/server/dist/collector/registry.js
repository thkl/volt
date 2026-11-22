import { DATA_SOURCE_TYPES, } from '../domain/models.js';
import { DemoCollector, NutCollector } from './collector.js';
import { HomeAssistantCollector } from './homeassistant-collector.js';
export class CollectorRegistry {
    adapters;
    constructor(adapters) {
        this.adapters = new Map(adapters.map((adapter) => [adapter.type, adapter]));
        if (this.adapters.size !== adapters.length) {
            throw new Error('Collector adapter types must be unique');
        }
    }
    create(type, context) {
        const adapter = this.adapters.get(type);
        if (!adapter) {
            throw new Error(`Collector type "${type}" is registered for future use but not implemented`);
        }
        return adapter.create(context);
    }
    catalog() {
        return DATA_SOURCE_TYPES.map((source) => ({
            ...source,
            implemented: this.adapters.has(source.type),
        }));
    }
}
export function createDefaultCollectorRegistry() {
    return new CollectorRegistry([
        {
            type: 'demo',
            create: ({ ingestion, config, hostName, endpointConfig }) => {
                const demoUpsId = endpointConfig['demoUpsId'];
                if (typeof demoUpsId === 'string') {
                    const device = {
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
            create: ({ ingestion, config, hostId, credentials }) => new NutCollector(ingestion, config, hostId, asNutCredentials(credentials)),
        },
        {
            type: 'homeassistant',
            create: ({ ingestion, config, hostId, hostName, endpointConfig, credentials }) => new HomeAssistantCollector(ingestion, config, hostId, hostName, endpointConfig, credentials),
        },
    ]);
}
function asNutCredentials(credentials) {
    if (!credentials)
        return null;
    const { username, password } = credentials;
    if (!username || !password) {
        throw new Error('NUT credentials must contain a username and password');
    }
    return { username, password };
}
function numericOffset(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
