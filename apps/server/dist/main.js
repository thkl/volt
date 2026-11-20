import { loadConfig } from './config.js';
import { createVoltServer } from './server.js';
const config = loadConfig();
const app = createVoltServer(config);
await app.listen();
console.log(JSON.stringify({
    level: 'info',
    message: 'Volt server listening',
    port: config.port,
    mode: app.collector.health().mode,
}));
let closing = false;
const shutdown = (signal) => {
    if (closing)
        return;
    closing = true;
    console.log(JSON.stringify({ level: 'info', message: 'Volt server shutting down', signal }));
    void app.close().catch((error) => {
        console.error(JSON.stringify({ level: 'error', message: 'Volt shutdown failed' }));
        process.exitCode = 1;
    });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
