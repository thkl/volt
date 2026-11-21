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

export type EnvironmentSecretName = (typeof FILE_BACKED_SECRET_NAMES)[number];
export type EnvironmentSecretSource = 'environment' | 'file' | 'unset';

export interface ResolvedEnvironmentSecret {
  value: string | undefined;
  source: EnvironmentSecretSource;
}

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
  name: EnvironmentSecretName,
): string | undefined {
  return resolveEnvironmentSecret(env, name).value;
}

export function resolveEnvironmentSecret(
  env: NodeJS.ProcessEnv,
  name: EnvironmentSecretName,
): ResolvedEnvironmentSecret {
  const directValue = env[name];
  if (directValue) return { value: directValue, source: 'environment' };

  const filePath = env[`${name}_FILE`]?.trim();
  if (!filePath) {
    return {
      value: directValue,
      source: directValue === undefined ? 'unset' : 'environment',
    };
  }

  let value: string;
  try {
    value = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`${name}_FILE could not be read`);
  }

  return { value: value.replace(/(?:\r\n|\n|\r)+$/, ''), source: 'file' };
}
