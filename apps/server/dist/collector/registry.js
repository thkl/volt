import { DATA_SOURCE_TYPES, } from '../domain/models.js';
import { DemoCollector, NutCollector } from './collector.js';
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
            create: ({ ingestion, config }) => new DemoCollector(ingestion, config.pollIntervalMs),
        },
        {
            type: 'nut',
            create: ({ ingestion, config, hostId, credentials }) => new NutCollector(ingestion, config, hostId, asNutCredentials(credentials)),
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
