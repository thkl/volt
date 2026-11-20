import { readFileSync } from 'node:fs';

const FILE_BACKED_SECRET_NAMES = [
  'AUTH_EMAIL',
  'AUTH_PASSWORD',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'INFISICAL_CLIENT_ID',
  'INFISICAL_CLIENT_SECRET',
  'INFISICAL_MACHINE_ID',
  'INFISICAL_MACHINE_TOKEN',
] as const;

export function resolveFileBackedSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...env };
  for (const name of FILE_BACKED_SECRET_NAMES) {
    const value = readEnvironmentSecret(env, name);
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
}

export function readEnvironmentSecret(
  env: NodeJS.ProcessEnv,
  name: (typeof FILE_BACKED_SECRET_NAMES)[number],
): string | undefined {
  const directValue = env[name];
  if (directValue) return directValue;

  const filePath = env[`${name}_FILE`]?.trim();
  if (!filePath) return directValue;

  let value: string;
  try {
    value = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`${name}_FILE could not be read`);
  }

  return value.replace(/(?:\r\n|\n|\r)+$/, '');
}
