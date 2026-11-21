import { resolveEnvironmentSecret, type EnvironmentSecretName } from './secret-env.js';

const AUTH_SECRET_NAMES = ['AUTH_EMAIL', 'AUTH_PASSWORD'] as const;
const OIDC_SECRET_NAMES = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;
const REQUEST_TIMEOUT_MS = 10_000;

export async function loadInfisicalAuthSecrets(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string> | null> {
  const clientIdCredential = firstSecretValue(env, ['INFISICAL_CLIENT_ID', 'INFISICAL_MACHINE_ID']);
  const clientSecretCredential = firstSecretValue(env, [
    'INFISICAL_CLIENT_SECRET',
    'INFISICAL_MACHINE_TOKEN',
  ]);
  const clientId = clientIdCredential?.value;
  const clientSecret = clientSecretCredential?.value;
  const projectId = env['INFISICAL_PROJECT_ID']?.trim() || undefined;
  const enabled = Boolean(clientId || clientSecret || projectId);
  if (!enabled) return null;

  const credentialPreviewEnabled = isEnabled(env['INFISICAL_DEBUG']);
  logInfisical('info', 'Infisical secret loading configured', {
    environment: env['INFISICAL_ENVIRONMENT']?.trim() || 'prod',
    projectIdConfigured: Boolean(projectId),
    authCredential: describeCredential(clientIdCredential),
    authSecret: describeCredential(clientSecretCredential),
    credentialPreviewsEnabled: credentialPreviewEnabled,
  });
  if (credentialPreviewEnabled) {
    logInfisical('debug', 'Infisical bootstrap credential previews', {
      clientId: previewCredential(clientIdCredential),
      clientSecret: previewCredential(clientSecretCredential),
    });
  }

  if (!clientId || !clientSecret || !projectId) {
    logInfisical('error', 'Infisical configuration is incomplete', {
      clientIdPresent: Boolean(clientId),
      clientSecretPresent: Boolean(clientSecret),
      projectIdPresent: Boolean(projectId),
    });
    throw new Error('Infisical requires a Universal Auth client ID, client secret, and project ID');
  }

  const siteUrl = normalizeSiteUrl(env['INFISICAL_SITE_URL']?.trim() || 'https://us.infisical.com');
  const environment = env['INFISICAL_ENVIRONMENT']?.trim() || 'prod';
  const defaultSecretPath = normalizeSecretPath(env['INFISICAL_SECRET_PATH']?.trim() || '/');
  const authSecretPath = normalizeSecretPath(
    env['INFISICAL_AUTH_SECRET_PATH']?.trim() || defaultSecretPath,
  );
  const oidcSecretPath = normalizeSecretPath(
    env['INFISICAL_OIDC_SECRET_PATH']?.trim() || defaultSecretPath,
  );
  logInfisical('info', 'Infisical secret loading started', {
    site: new URL(siteUrl).origin,
    environment,
    authSecretPath,
    oidcSecretPath,
  });

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

    const secretNamesByPath = new Map<string, Set<string>>();
    for (const [path, names] of [
      [authSecretPath, AUTH_SECRET_NAMES],
      [oidcSecretPath, OIDC_SECRET_NAMES],
    ] as const) {
      const pathNames = secretNamesByPath.get(path) ?? new Set<string>();
      for (const name of names) pathNames.add(name);
      secretNamesByPath.set(path, pathNames);
    }

    secrets = {};
    for (const [secretPath, names] of secretNamesByPath) {
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
        `secret fetch for ${secretPath} (environment ${environment})`,
      );
      if (!isRecord(response) || !Array.isArray(response['secrets'])) {
        throw new InfisicalRequestError(
          `secret fetch for ${secretPath} returned an invalid response`,
        );
      }

      for (const value of response['secrets']) {
        if (
          isRecord(value) &&
          typeof value['secretKey'] === 'string' &&
          typeof value['secretValue'] === 'string' &&
          names.has(value['secretKey'])
        ) {
          secrets[value['secretKey']] = value['secretValue'];
        }
      }
    }
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

interface BootstrapCredential {
  name: EnvironmentSecretName;
  source: 'environment' | 'file';
  value: string;
}

function firstSecretValue(
  env: NodeJS.ProcessEnv,
  names: EnvironmentSecretName[],
): BootstrapCredential | undefined {
  for (const name of names) {
    const resolved = resolveEnvironmentSecret(env, name);
    if (resolved.value) {
      return { name, source: resolved.source as 'environment' | 'file', value: resolved.value };
    }
  }
  return undefined;
}

function describeCredential(credential: BootstrapCredential | undefined) {
  return credential
    ? { variable: credential.name, source: credential.source }
    : { configured: false };
}

function previewCredential(credential: BootstrapCredential | undefined) {
  if (!credential) return { configured: false };
  return {
    variable: credential.name,
    source: credential.source,
    length: credential.value.length,
    firstFour: credential.value.length > 4 ? credential.value.slice(0, 4) : '[redacted]',
  };
}

function isEnabled(value: string | undefined): boolean {
  return ['true', '1', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function logInfisical(
  level: 'debug' | 'info' | 'error',
  message: string,
  fields: Record<string, unknown>,
): void {
  const log = level === 'error' ? console.error : console.log;
  log(JSON.stringify({ level, message, ...fields }));
}

function apiUrl(siteUrl: string, path: string): URL {
  return new URL(path.replace(/^\//, ''), `${siteUrl.replace(/\/$/, '')}/`);
}

async function requestJson(url: URL, init: RequestInit, operation: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  logInfisical('info', 'Infisical API request started', {
    operation,
    host: url.host,
    path: url.pathname,
    method: init.method ?? 'GET',
  });
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
      const detail = init.method === 'GET' ? await readApiErrorMessage(response) : null;
      logInfisical('error', 'Infisical API request failed', {
        operation,
        status: response.status,
        durationMs: Date.now() - startedAt,
        detail,
      });
      throw new InfisicalRequestError(
        `${operation} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    try {
      const payload = await response.json();
      logInfisical('info', 'Infisical API request completed', {
        operation,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return payload;
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

async function readApiErrorMessage(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return null;
    const detail =
      typeof payload['message'] === 'string'
        ? payload['message']
        : typeof payload['error'] === 'string'
          ? payload['error']
          : null;
    if (!detail) return null;
    const message = detail
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!message) return null;
    return message.slice(0, 200);
  } catch {
    return null;
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
