import { loadConfig } from './config.js';
import { loadInfisicalAuthSecrets } from './infisical-secrets.js';
import { resolveFileBackedSecrets } from './secret-env.js';
import { createVoltServer } from './server.js';

const environmentWithFiles = resolveFileBackedSecrets(process.env);
const hasEmail = Boolean(environmentWithFiles['AUTH_EMAIL']?.trim());
const localPasswordSignInComplete =
  hasEmail && Boolean(environmentWithFiles['AUTH_PASSWORD']?.length);
const localOidcSignInComplete =
  hasEmail &&
  Boolean(
    environmentWithFiles['OIDC_ISSUER']?.trim() &&
    environmentWithFiles['OIDC_CLIENT_ID']?.trim() &&
    environmentWithFiles['OIDC_CLIENT_SECRET']?.trim() &&
    environmentWithFiles['OIDC_REDIRECT_URI']?.trim(),
  );
const infisicalSecrets = await loadInfisicalAuthSecrets(process.env, {
  auth: !localPasswordSignInComplete && !localOidcSignInComplete,
  oidc: !localOidcSignInComplete,
});
const configEnvironment = { ...environmentWithFiles };
const authSettingNames = [
  'AUTH_EMAIL',
  'AUTH_PASSWORD',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ISSUER',
  'OIDC_REDIRECT_URI',
  'OIDC_CLIENT_AUTH_METHOD',
];
for (const name of authSettingNames) {
  const localValue = configEnvironment[name];
  const localValueIsSet =
    name === 'AUTH_PASSWORD' ? Boolean(localValue?.length) : Boolean(localValue?.trim());
  if (localValueIsSet) continue;
  const infisicalValue = infisicalSecrets[name];
  if (infisicalValue) configEnvironment[name] = infisicalValue;
}
const infisicalCredentialNames = [
  'INFISICAL_CLIENT_ID',
  'INFISICAL_CLIENT_ID_FILE',
  'INFISICAL_CLIENT_SECRET',
  'INFISICAL_CLIENT_SECRET_FILE',
  'INFISICAL_MACHINE_ID',
  'INFISICAL_MACHINE_ID_FILE',
  'INFISICAL_MACHINE_TOKEN',
  'INFISICAL_MACHINE_TOKEN_FILE',
];
for (const name of infisicalCredentialNames) {
  delete configEnvironment[name];
  delete process.env[name];
}
for (const name of [...authSettingNames, ...authSettingNames.map((name) => `${name}_FILE`)]) {
  delete process.env[name];
}

const config = loadConfig(configEnvironment);
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
