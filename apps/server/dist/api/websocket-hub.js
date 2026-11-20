import { WebSocket, WebSocketServer } from 'ws';
import { AuthManager } from '../auth/auth-manager.js';
export class WebSocketHub {
    config;
    store;
    collector;
    authManager;
    server;
    clientStates = new WeakMap();
    heartbeat;
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
    constructor(httpServer, config, store, collector, authManager = new AuthManager(config)) {
        this.config = config;
        this.store = store;
        this.collector = collector;
        this.authManager = authManager;
        this.server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
        this.server.on('connection', (client, request) => this.handleConnection(client, request));
        this.server.on('error', (error) => console.error(JSON.stringify({ level: 'error', message: 'WebSocket server error', error: error.message })));
        this.collector.on('snapshot', this.onSnapshot);
        this.collector.on('hosts', this.onHosts);
        this.collector.on('health', this.onHealth);
        httpServer.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
        this.heartbeat = setInterval(() => this.sendHeartbeat(), 25_000);
        this.heartbeat.unref();
    }
    close() {
        clearInterval(this.heartbeat);
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
        });
        client.on('pong', () => {
            const state = this.clientStates.get(client);
            if (state)
                state.alive = true;
        });
        client.on('message', (message) => {
            if (message.toString() === '{"type":"ping"}') {
                this.send(client, { type: 'pong', at: new Date().toISOString() });
            }
            else {
                client.close(1008, 'The Volt stream is read-only');
            }
        });
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
