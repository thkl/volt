import { loadConfig, type AppConfig } from './config.js';
import { loadInfisicalAuthSecrets } from './infisical-secrets.js';
import { createVoltServer } from './server.js';

const infisicalSecrets = await loadInfisicalAuthSecrets(process.env);
let config: AppConfig;
if (infisicalSecrets) {
  const secretEnvironmentNames = [
    'AUTH_EMAIL',
    'AUTH_PASSWORD',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'INFISICAL_CLIENT_ID',
    'INFISICAL_CLIENT_ID_FILE',
    'INFISICAL_CLIENT_SECRET',
    'INFISICAL_CLIENT_SECRET_FILE',
    'INFISICAL_MACHINE_ID',
    'INFISICAL_MACHINE_ID_FILE',
    'INFISICAL_MACHINE_TOKEN',
    'INFISICAL_MACHINE_TOKEN_FILE',
    'AUTH_EMAIL_FILE',
    'AUTH_PASSWORD_FILE',
    'OIDC_CLIENT_ID_FILE',
    'OIDC_CLIENT_SECRET_FILE',
  ];
  const configEnvironment = { ...process.env };
  for (const name of secretEnvironmentNames) {
    delete configEnvironment[name];
    delete process.env[name];
  }
  Object.assign(configEnvironment, {
    AUTH_EMAIL: infisicalSecrets['AUTH_EMAIL'] ?? '',
    AUTH_PASSWORD: infisicalSecrets['AUTH_PASSWORD'] ?? '',
    OIDC_CLIENT_ID: infisicalSecrets['OIDC_CLIENT_ID'] ?? '',
    OIDC_CLIENT_SECRET: infisicalSecrets['OIDC_CLIENT_SECRET'] ?? '',
  });
  config = loadConfig(configEnvironment);
} else {
  config = loadConfig(process.env);
}
const app = createVoltServer(config);

await app.listen();
console.log(
  JSON.stringify({
    level: 'info',
    message: 'Volt server listening',
    port: config.port,
    mode: app.collector.health().mode,
  }),
);

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ level: 'info', message: 'Volt server shutting down', signal }));
  void app.close().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', message: 'Volt shutdown failed' }));
    process.exitCode = 1;
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
