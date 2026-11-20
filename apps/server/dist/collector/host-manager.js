import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DemoCollector } from './collector.js';
import { decryptCredentials, encryptCredentials } from '../security/credentials.js';
import { IngestionService } from './ingestion-service.js';
import { createDefaultCollectorRegistry } from './registry.js';
export class HostManager extends EventEmitter {
    store;
    config;
    credentialKey;
    registry;
    active = new Map();
    startErrors = new Map();
    healthTicker = null;
    constructor(store, config, credentialKey, registry = createDefaultCollectorRegistry()) {
        super();
        this.store = store;
        this.config = config;
        this.credentialKey = credentialKey;
        this.registry = registry;
    }
    start() {
        for (const host of this.store.listEnabledHostRecords())
            this.startHost(host);
        if (!this.healthTicker) {
            this.healthTicker = setInterval(() => this.emit('health', this.health(), this.sourceHealth()), 5_000);
            this.healthTicker.unref();
        }
    }
    stop() {
        if (this.healthTicker)
            clearInterval(this.healthTicker);
        this.healthTicker = null;
        for (const hostId of this.active.keys())
            this.stopHost(hostId, 'Server is shutting down');
    }
    sourceHealth() {
        return this.store.listEnabledHostRecords().map((host) => {
            const endpoint = host.endpointConfig;
            const active = this.active.get(host.id);
            const health = active?.collector.health();
            const startError = this.startErrors.get(host.id);
            return {
                hostId: host.id,
                name: host.name,
                sourceType: host.sourceType,
                host: typeof endpoint['host'] === 'string' ? endpoint['host'] : null,
                port: typeof endpoint['port'] === 'number' ? endpoint['port'] : null,
                tls: endpoint['tls'] === true,
                status: startError ? 'degraded' : (health?.status ?? 'degraded'),
                connected: health?.connected ?? false,
                phase: startError ? 'error' : (health?.phase ?? 'starting'),
                discoveredUps: health?.discoveredUps ?? 0,
                upsNames: health?.upsNames ?? [],
                lastPollAt: health?.lastPollAt ?? null,
                lastDiscoveryAt: health?.lastDiscoveryAt ?? null,
                lastError: startError ?? health?.lastError ?? (health ? null : 'Collector is starting'),
                lastErrorCode: startError ? 'COLLECTOR_START_FAILED' : (health?.lastErrorCode ?? null),
                consecutiveFailures: health?.consecutiveFailures ?? 0,
            };
        });
    }
    sourceHealthById(hostId) {
        return this.sourceHealth().find((item) => item.hostId === hostId) ?? null;
    }
    health() {
        const health = [...this.active.values()].map(({ collector }) => collector.health());
        const configured = this.store.listEnabledHosts();
        if (configured.length === 0) {
            return {
                mode: 'none',
                status: 'degraded',
                connected: false,
                lastPollAt: null,
                lastError: 'No data sources configured',
            };
        }
        const modes = new Set(configured.map((item) => item.sourceType));
        const mode = modes.size > 1 ? 'multi' : (configured[0]?.sourceType ?? 'none');
        const lastPollAt = health
            .map((item) => item.lastPollAt)
            .filter((item) => item !== null)
            .sort()
            .at(-1) ?? null;
        return {
            mode: mode,
            status: this.startErrors.size > 0 || health.some((item) => item.status === 'degraded')
                ? 'degraded'
                : 'ready',
            connected: this.startErrors.size === 0 &&
                health.length === configured.length &&
                health.every((item) => item.connected),
            lastPollAt,
            lastError: this.startErrors.size > 0
                ? 'One or more configured collectors could not start'
                : (health.find((item) => item.lastError !== null)?.lastError ?? null),
        };
    }
    getDemoScenario() {
        const active = [...this.active.values()].find((item) => item.collector instanceof DemoCollector);
        return active?.collector instanceof DemoCollector ? active.collector.source.scenario : null;
    }
    selectDemoScenario(scenario) {
        const demo = [...this.active.values()].find(({ collector }) => collector instanceof DemoCollector)?.collector;
        return demo instanceof DemoCollector ? demo.selectScenario(scenario) : false;
    }
    addNutHost(input) {
        const credentials = optionalCredentials(input);
        const host = {
            id: randomUUID(),
            name: input.name,
            sourceType: 'nut',
            endpointConfig: { host: input.host, port: input.port, tls: input.tls, protocol: 'tcp' },
            encryptedCredentials: credentials
                ? encryptCredentials(credentials, this.credentialKey)
                : null,
            credentialsConfigured: Boolean(credentials),
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        if (!this.store.listEnabledHosts().some((item) => item.sourceType === 'nut')) {
            for (const demoId of this.store.disableHostsByType('demo')) {
                this.stopHost(demoId, 'Demo source was replaced by a NUT host');
            }
        }
        this.store.upsertHost(host);
        const saved = this.store.getHostRecord(host.id);
        if (!saved)
            throw new Error('NUT host was not saved');
        this.startHost(saved);
        this.emitHostsChanged();
        return publicHost(saved);
    }
    updateNutHost(id, input) {
        const current = this.store.getHostRecord(id);
        if (!current || current.sourceType !== 'nut')
            throw new Error('NUT host not found');
        const credentials = optionalCredentials(input);
        this.stopHost(id, 'NUT host configuration changed');
        this.startErrors.delete(id);
        this.store.upsertHost({
            ...current,
            name: input.name,
            endpointConfig: { host: input.host, port: input.port, tls: input.tls, protocol: 'tcp' },
            encryptedCredentials: credentials
                ? encryptCredentials(credentials, this.credentialKey)
                : null,
            enabled: true,
        }, input.clearCredentials ?? false);
        const saved = this.store.getHostRecord(id);
        if (!saved)
            throw new Error('NUT host was not saved');
        this.startHost(saved);
        this.emitHostsChanged();
        return publicHost(saved);
    }
    removeHost(id) {
        const host = this.store.getHostRecord(id);
        if (!host || !host.enabled)
            throw new Error('Host not found');
        if (host.sourceType === 'demo')
            throw new Error('The demo source cannot be removed');
        this.stopHost(id, 'Host was removed');
        this.startErrors.delete(id);
        this.store.disableHost(id);
        this.emitHostsChanged();
    }
    startHost(host) {
        if (!host.enabled || this.active.has(host.id))
            return;
        try {
            const endpoint = host.endpointConfig;
            const hostName = typeof endpoint['host'] === 'string' ? endpoint['host'] : null;
            const port = typeof endpoint['port'] === 'number' ? endpoint['port'] : 3493;
            const tls = endpoint['tls'] === true;
            const credentials = host.encryptedCredentials
                ? decryptCredentials(host.encryptedCredentials, this.credentialKey)
                : null;
            const hostConfig = {
                ...this.config,
                demoMode: host.sourceType === 'demo',
                nutHost: host.sourceType === 'nut' ? hostName : null,
                nutName: host.name,
                nutPort: port,
                nutTls: tls,
                nutUsername: credentials?.['username'] ?? null,
                nutPassword: credentials?.['password'] ?? null,
                credentialsEncryptionKey: this.credentialKey,
            };
            const ingestion = new IngestionService(this.store, {
                hostId: host.id,
                sampleIntervalMs: this.config.sampleIntervalMs,
            });
            ingestion.on('snapshot', (snapshot, events) => this.emit('snapshot', snapshot, events, host.id));
            const collector = this.registry.create(host.sourceType, {
                config: hostConfig,
                ingestion,
                hostId: host.id,
                credentials,
            });
            this.active.set(host.id, { host, collector, ingestion });
            this.startErrors.delete(host.id);
            collector.start();
        }
        catch (error) {
            this.active.delete(host.id);
            this.startErrors.set(host.id, error instanceof Error ? error.message : 'Collector could not start');
        }
    }
    stopHost(hostId, reason) {
        const active = this.active.get(hostId);
        if (!active)
            return;
        active.collector.stop();
        for (const device of this.store.listDevices().filter((item) => item.hostId === hostId)) {
            active.ingestion.markUnavailable(device.id, reason, 'unavailable');
        }
        this.active.delete(hostId);
    }
    emitHostsChanged() {
        this.emit('hosts', {
            hosts: this.store.listEnabledHosts(),
            devices: this.store.listDevices(),
            collector: this.health(),
            sources: this.sourceHealth(),
        });
    }
}
function optionalCredentials(input) {
    const username = input.username?.trim() ?? '';
    const password = input.password ?? '';
    if (Boolean(username) !== Boolean(password)) {
        throw new Error('Username and password must be provided together');
    }
    if (!username)
        return null;
    return { username, password };
}
function publicHost(host) {
    const { encryptedCredentials: _encryptedCredentials, ...summary } = host;
    return { ...summary, credentialsConfigured: Boolean(host.encryptedCredentials) };
}
