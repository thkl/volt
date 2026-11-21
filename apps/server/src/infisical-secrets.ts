import { readEnvironmentSecret } from './secret-env.js';

const AUTH_SECRET_NAMES = [
  'AUTH_EMAIL',
  'AUTH_PASSWORD',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
] as const;
const REQUEST_TIMEOUT_MS = 10_000;

export async function loadInfisicalAuthSecrets(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string> | null> {
  const clientId = firstSecretValue(env, ['INFISICAL_CLIENT_ID', 'INFISICAL_MACHINE_ID']);
  const clientSecret = firstSecretValue(env, [
    'INFISICAL_CLIENT_SECRET',
    'INFISICAL_MACHINE_TOKEN',
  ]);
  const projectId = env['INFISICAL_PROJECT_ID']?.trim() || undefined;
  const enabled = Boolean(clientId || clientSecret || projectId);
  if (!enabled) return null;

  if (!clientId || !clientSecret || !projectId) {
    throw new Error('Infisical requires a Universal Auth client ID, client secret, and project ID');
  }

  const siteUrl = normalizeSiteUrl(env['INFISICAL_SITE_URL']?.trim() || 'https://us.infisical.com');
  const environment = env['INFISICAL_ENVIRONMENT']?.trim() || 'prod';
  const secretPath = normalizeSecretPath(env['INFISICAL_SECRET_PATH']?.trim() || '/');

  let secrets: Record<string, string>;
  try {
    const loginUrl = apiUrl(siteUrl, '/api/v1/auth/universal-auth/login');
    const loginPayload = await requestJson(
      loginUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      },
      'Universal Auth login',
    );
    if (
      !isRecord(loginPayload) ||
      typeof loginPayload['accessToken'] !== 'string' ||
      !loginPayload['accessToken']
    ) {
      throw new InfisicalRequestError('Universal Auth login returned an invalid response');
    }

    const secretsUrl = apiUrl(siteUrl, '/api/v4/secrets');
    secretsUrl.search = new URLSearchParams({
      projectId,
      environment,
      expandSecretReferences: 'true',
      recursive: 'false',
      secretPath,
      viewSecretValue: 'true',
    }).toString();
    const response = await requestJson(
      secretsUrl,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${loginPayload['accessToken']}` },
      },
      'secret fetch',
    );
    if (!isRecord(response) || !Array.isArray(response['secrets'])) {
      throw new InfisicalRequestError('secret fetch returned an invalid response');
    }

    const values = new Map<string, string>();
    for (const value of response['secrets']) {
      if (
        isRecord(value) &&
        typeof value['secretKey'] === 'string' &&
        typeof value['secretValue'] === 'string'
      ) {
        values.set(value['secretKey'], value['secretValue']);
      }
    }
    secrets = Object.fromEntries(
      AUTH_SECRET_NAMES.flatMap((name) => {
        const value = values.get(name);
        return value === undefined || value.length === 0 ? [] : [[name, value]];
      }),
    );
  } catch (error) {
    if (error instanceof InfisicalRequestError) {
      throw new Error(`Infisical ${error.message}`);
    }
    throw new Error('Infisical authentication secrets could not be loaded');
  }

  if (!secrets['AUTH_EMAIL']) {
    throw new Error('Infisical secrets must include AUTH_EMAIL');
  }
  if (!secrets['AUTH_PASSWORD'] && !(secrets['OIDC_CLIENT_ID'] && secrets['OIDC_CLIENT_SECRET'])) {
    throw new Error('Infisical secrets must include AUTH_PASSWORD or both OIDC client credentials');
  }

  return secrets;
}

function firstSecretValue(
  env: NodeJS.ProcessEnv,
  names: Array<
    | 'INFISICAL_CLIENT_ID'
    | 'INFISICAL_CLIENT_SECRET'
    | 'INFISICAL_MACHINE_ID'
    | 'INFISICAL_MACHINE_TOKEN'
  >,
): string | undefined {
  for (const name of names) {
    const value = readEnvironmentSecret(env, name);
    if (value) return value;
  }
  return undefined;
}

function apiUrl(siteUrl: string, path: string): URL {
  return new URL(path.replace(/^\//, ''), `${siteUrl.replace(/\/$/, '')}/`);
}

async function requestJson(url: URL, init: RequestInit, operation: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new InfisicalRequestError(`${operation} timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      const code = getNetworkErrorCode(error);
      throw new InfisicalRequestError(
        `${operation} network request failed${code ? ` (${code})` : ''}`,
      );
    }
    if (!response.ok) {
      throw new InfisicalRequestError(`${operation} returned HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new InfisicalRequestError(`${operation} timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      throw new InfisicalRequestError(`${operation} response was not valid JSON`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function getNetworkErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('cause' in error)) return null;
  const cause = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return null;
  return typeof cause.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : null;
}

class InfisicalRequestError extends Error {}

function normalizeSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INFISICAL_SITE_URL must be a valid absolute URL');
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'INFISICAL_SITE_URL must use HTTPS and cannot contain credentials or query data',
    );
  }
  return url.href.replace(/\/$/, '');
}

function normalizeSecretPath(value: string): string {
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error('INFISICAL_SECRET_PATH must be an absolute secret folder path');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
