import { WebSocket, WebSocketServer } from 'ws';
import { AuthManager } from '../auth/auth-manager.js';
export class WebSocketHub {
    config;
    store;
    collector;
    authManager;
    energyImpactService;
    server;
    clientStates = new WeakMap();
    heartbeat;
    energyRefresh;
    onSnapshot = (snapshot, events) => {
        this.broadcast({
            type: 'snapshot',
            data: snapshot,
            device: this.store.getDevice(snapshot.deviceId),
            events,
            scenario: this.collector.getDemoScenario(),
            sources: this.collector.sourceHealth(),
        });
    };
    onHosts = (update) => {
        const activeDeviceIds = new Set(update.devices.map((device) => device.id));
        for (const client of this.server.clients) {
            const state = this.clientStates.get(client);
            if (state?.energyImpactSubscription &&
                !activeDeviceIds.has(state.energyImpactSubscription.deviceId)) {
                state.energyImpactSubscription = null;
            }
        }
        this.broadcast({
            type: 'hosts',
            mode: update.collector.mode,
            scenario: this.collector.getDemoScenario(),
            ...update,
        });
    };
    onHealth = (collector, sources) => {
        this.broadcast({ type: 'health', collector, sources });
    };
    constructor(httpServer, config, store, collector, authManager = new AuthManager(config), energyImpactService) {
        this.config = config;
        this.store = store;
        this.collector = collector;
        this.authManager = authManager;
        this.energyImpactService = energyImpactService;
        this.server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
        this.server.on('connection', (client, request) => this.handleConnection(client, request));
        this.server.on('error', (error) => console.error(JSON.stringify({ level: 'error', message: 'WebSocket server error', error: error.message })));
        this.collector.on('snapshot', this.onSnapshot);
        this.collector.on('hosts', this.onHosts);
        this.collector.on('health', this.onHealth);
        httpServer.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
        this.heartbeat = setInterval(() => this.sendHeartbeat(), 25_000);
        this.heartbeat.unref();
        this.energyRefresh = setInterval(() => this.refreshEnergySubscriptions(), 60_000);
        this.energyRefresh.unref();
    }
    close() {
        clearInterval(this.heartbeat);
        clearInterval(this.energyRefresh);
        this.collector.off('snapshot', this.onSnapshot);
        this.collector.off('hosts', this.onHosts);
        this.collector.off('health', this.onHealth);
        for (const client of this.server.clients)
            client.close(1001, 'Server shutting down');
        this.server.close();
    }
    handleUpgrade(request, socket, head) {
        let path;
        try {
            path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
        }
        catch {
            socket.destroy();
            return;
        }
        if (path !== '/api/ws') {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        const origin = request.headers.origin;
        if (origin && !this.isAllowedOrigin(origin, request)) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        const sessionToken = this.authManager.sessionTokenFromHeader(request.headers.cookie);
        if (this.authManager.enabled && !this.authManager.hasValidSessionToken(sessionToken)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        this.server.handleUpgrade(request, socket, head, (client) => {
            this.server.emit('connection', client, request);
        });
    }
    handleConnection(client, request) {
        this.clientStates.set(client, {
            alive: true,
            sessionToken: this.authManager.sessionTokenFromHeader(request.headers.cookie),
            energyImpactSubscription: null,
            lastEnergyImpactRefreshAt: 0,
        });
        client.on('pong', () => {
            const state = this.clientStates.get(client);
            if (state)
                state.alive = true;
        });
        client.on('message', (message) => this.handleMessage(client, message.toString()));
        client.on('error', () => client.terminate());
        this.send(client, {
            type: 'initial',
            mode: this.collector.health().mode,
            scenario: this.collector.getDemoScenario(),
            hosts: this.store.listEnabledHosts(),
            devices: this.store.listDevices(),
            collector: this.collector.health(),
            sources: this.collector.sourceHealth(),
        });
    }
    sendHeartbeat() {
        const at = new Date().toISOString();
        for (const client of this.server.clients) {
            const state = this.clientStates.get(client);
            if (client.readyState !== WebSocket.OPEN)
                continue;
            if (this.authManager.enabled &&
                (!state || !this.authManager.hasValidSessionToken(state.sessionToken))) {
                client.close(1008, 'Authentication expired');
                continue;
            }
            if (state && !state.alive) {
                client.terminate();
                continue;
            }
            if (state)
                state.alive = false;
            client.ping();
            this.send(client, {
                type: 'heartbeat',
                at,
                collector: this.collector.health(),
                sources: this.collector.sourceHealth(),
            });
        }
    }
    handleMessage(client, raw) {
        if (raw === '{"type":"ping"}') {
            this.send(client, { type: 'pong', at: new Date().toISOString() });
            return;
        }
        let message;
        try {
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed))
                throw new Error('Invalid message');
            message = parsed;
        }
        catch {
            client.close(1008, 'Invalid message');
            return;
        }
        const state = this.clientStates.get(client);
        if (message['type'] === 'unsubscribe-energy-impact' && state) {
            state.energyImpactSubscription = null;
            return;
        }
        if (message['type'] === 'refresh-energy-impact' && state) {
            const now = Date.now();
            if (!state.energyImpactSubscription || now - state.lastEnergyImpactRefreshAt < 1_000) {
                return;
            }
            state.lastEnergyImpactRefreshAt = now;
            this.sendEnergyImpact(client, state.energyImpactSubscription);
            return;
        }
        if (message['type'] === 'subscribe-energy-impact' && state) {
            const deviceId = message['deviceId'];
            if (typeof deviceId !== 'string' || deviceId.length > 255) {
                this.send(client, {
                    type: 'energy-impact-error',
                    deviceId: typeof deviceId === 'string' ? deviceId : '',
                    message: 'Choose a valid UPS device',
                });
                return;
            }
            const activeDevice = this.store.listDevices().some((device) => device.id === deviceId);
            if (!activeDevice) {
                this.send(client, {
                    type: 'energy-impact-error',
                    deviceId,
                    message: 'UPS device is not available',
                });
                return;
            }
            const timeZone = message['timeZone'];
            if (typeof timeZone !== 'string' || timeZone.length > 128) {
                this.send(client, {
                    type: 'energy-impact-error',
                    deviceId,
                    message: 'A valid time zone is required',
                });
                return;
            }
            if (state.energyImpactSubscription?.deviceId === deviceId &&
                state.energyImpactSubscription.timeZone === timeZone) {
                return;
            }
            state.energyImpactSubscription = { deviceId, timeZone };
            this.sendEnergyImpact(client, state.energyImpactSubscription);
            return;
        }
        client.close(1008, 'Unsupported message');
    }
    refreshEnergySubscriptions() {
        if (!this.energyImpactService)
            return;
        const activeDeviceIds = new Set(this.store.listDevices().map((device) => device.id));
        const subscriptions = new Map();
        for (const client of this.server.clients) {
            if (client.readyState !== WebSocket.OPEN)
                continue;
            const subscription = this.clientStates.get(client)?.energyImpactSubscription;
            if (!subscription)
                continue;
            if (!activeDeviceIds.has(subscription.deviceId)) {
                const state = this.clientStates.get(client);
                if (state)
                    state.energyImpactSubscription = null;
                continue;
            }
            const key = `${subscription.deviceId}\u0000${subscription.timeZone}`;
            const current = subscriptions.get(key) ?? { subscription, clients: [] };
            current.clients.push(client);
            subscriptions.set(key, current);
        }
        for (const { subscription, clients } of subscriptions.values()) {
            try {
                const data = this.energyImpactService.getImpact(subscription.deviceId, subscription.timeZone);
                for (const client of clients) {
                    this.send(client, { type: 'energy-impact', data });
                }
            }
            catch {
                for (const client of clients) {
                    this.send(client, {
                        type: 'energy-impact-error',
                        deviceId: subscription.deviceId,
                        message: 'Energy impact could not be calculated',
                    });
                }
            }
        }
    }
    sendEnergyImpact(client, subscription) {
        if (!this.energyImpactService) {
            this.send(client, {
                type: 'energy-impact-error',
                deviceId: subscription.deviceId,
                message: 'Energy impact is unavailable',
            });
            return;
        }
        try {
            const data = this.energyImpactService.getImpact(subscription.deviceId, subscription.timeZone);
            this.send(client, { type: 'energy-impact', data });
        }
        catch {
            this.send(client, {
                type: 'energy-impact-error',
                deviceId: subscription.deviceId,
                message: 'Energy impact could not be calculated',
            });
        }
    }
    broadcast(message) {
        for (const client of this.server.clients) {
            if (client.readyState === WebSocket.OPEN)
                this.send(client, message);
        }
    }
    send(client, message) {
        try {
            client.send(JSON.stringify(message));
        }
        catch {
            client.terminate();
        }
    }
    isAllowedOrigin(origin, request) {
        if (this.config.webOrigins.has(origin))
            return true;
        try {
            return new URL(origin).host === request.headers.host;
        }
        catch {
            return false;
        }
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
