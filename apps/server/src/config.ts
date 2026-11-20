import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface AppConfig {
  host: string;
  port: number;
  demoMode: boolean;
  nutHost: string | null;
  nutName: string | null;
  nutPort: number;
  nutTls: boolean;
  nutUsername: string | null;
  nutPassword: string | null;
  clearNutCredentials: boolean;
  credentialsEncryptionKey: string | null;
  pollIntervalMs: number;
  discoveryIntervalMs: number;
  requestTimeoutMs: number;
  sampleIntervalMs: number;
  sampleRetentionDays: number;
  eventRetentionDays: number;
  databasePath: string;
  webDistDir: string;
  webOrigins: ReadonlySet<string>;
  auth: {
    enabled: boolean;
    email: string | null;
    password: string | null;
    cookieSecure: boolean;
    oidc: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
      redirectUri: string;
    } | null;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const demoMode = parseBoolean(env['DEMO_MODE'], true, 'DEMO_MODE');
  const nutHost = nonEmpty(env['NUT_HOST']);
  const nutUsername = nonEmpty(env['NUT_USERNAME']);
  const nutPassword = nonEmpty(env['NUT_PASSWORD']);
  const clearNutCredentials = parseBoolean(
    env['CLEAR_NUT_CREDENTIALS'],
    false,
    'CLEAR_NUT_CREDENTIALS',
  );
  const nutTls = parseBoolean(env['NUT_TLS'], false, 'NUT_TLS');
  const credentialsEncryptionKey = nonEmpty(env['CREDENTIALS_ENCRYPTION_KEY']) ?? null;
  if ((nutUsername && !nutPassword) || (!nutUsername && nutPassword)) {
    throw new Error('NUT_USERNAME and NUT_PASSWORD must be configured together');
  }
  if (clearNutCredentials && (nutUsername || nutPassword)) {
    throw new Error('CLEAR_NUT_CREDENTIALS cannot be combined with NUT_USERNAME or NUT_PASSWORD');
  }
  if (
    credentialsEncryptionKey &&
    !/^(?:[A-Fa-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/.test(credentialsEncryptionKey)
  ) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must encode exactly 32 bytes as hex or base64');
  }

  const dataDir = resolveFromProject(nonEmpty(env['DATA_DIR']) ?? '.data');
  const databasePath = resolveFromProject(
    nonEmpty(env['DATABASE_PATH']) ?? `${dataDir}/volt.sqlite`,
  );
  const webOrigins = new Set(
    (nonEmpty(env['WEB_ORIGINS']) ?? 'http://localhost:4200,http://127.0.0.1:4200')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const authEmail = nonEmpty(env['AUTH_EMAIL'])?.toLowerCase() ?? null;
  const authPassword =
    env['AUTH_PASSWORD'] && env['AUTH_PASSWORD'].length > 0 ? env['AUTH_PASSWORD'] : null;
  const oidcIssuer = nonEmpty(env['OIDC_ISSUER']) ?? null;
  const oidcClientId = nonEmpty(env['OIDC_CLIENT_ID']) ?? null;
  const oidcClientSecret = nonEmpty(env['OIDC_CLIENT_SECRET']) ?? null;
  const oidcRedirectUri = nonEmpty(env['OIDC_REDIRECT_URI']) ?? null;
  const oidcClientAuthMethod = nonEmpty(env['OIDC_CLIENT_AUTH_METHOD']) ?? null;
  const oidcValues = [oidcIssuer, oidcClientId, oidcClientSecret, oidcRedirectUri];
  const oidcConfigured = oidcValues.some(Boolean) || Boolean(oidcClientAuthMethod);

  if (authPassword && !authEmail) {
    throw new Error('AUTH_EMAIL is required when AUTH_PASSWORD is configured');
  }
  if (oidcConfigured && oidcValues.some((value) => !value)) {
    throw new Error(
      'OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI are required together',
    );
  }
  if (
    oidcClientAuthMethod &&
    oidcClientAuthMethod !== 'client_secret_basic' &&
    oidcClientAuthMethod !== 'client_secret_post'
  ) {
    throw new Error('OIDC_CLIENT_AUTH_METHOD must be client_secret_basic or client_secret_post');
  }
  if ((authPassword || oidcConfigured) && !authEmail) {
    throw new Error('AUTH_EMAIL is required when authentication is configured');
  }
  if (authEmail && !authPassword && !oidcConfigured) {
    throw new Error('AUTH_PASSWORD or OIDC settings are required when AUTH_EMAIL is set');
  }
  if (authEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail)) {
    throw new Error('AUTH_EMAIL must be a valid email address');
  }

  let oidc: AppConfig['auth']['oidc'] = null;
  if (oidcIssuer && oidcClientId && oidcClientSecret && oidcRedirectUri) {
    const issuerUrl = parseUrl(oidcIssuer, 'OIDC_ISSUER');
    const redirectUrl = parseUrl(oidcRedirectUri, 'OIDC_REDIRECT_URI');
    if (
      issuerUrl.protocol !== 'https:' &&
      !(issuerUrl.protocol === 'http:' && isLoopback(issuerUrl.hostname))
    ) {
      throw new Error('OIDC_ISSUER must use HTTPS (HTTP is allowed for localhost development)');
    }
    if (
      redirectUrl.protocol !== 'https:' &&
      !(redirectUrl.protocol === 'http:' && isLoopback(redirectUrl.hostname))
    ) {
      throw new Error(
        'OIDC_REDIRECT_URI must use HTTPS (HTTP is allowed for localhost development)',
      );
    }
    if (redirectUrl.pathname !== '/api/auth/oidc/callback') {
      throw new Error('OIDC_REDIRECT_URI must end with /api/auth/oidc/callback');
    }
    oidc = {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      clientAuthMethod:
        oidcClientAuthMethod === 'client_secret_post'
          ? 'client_secret_post'
          : 'client_secret_basic',
      redirectUri: redirectUrl.href,
    };
  }
  const cookieSecure = parseBoolean(
    env['AUTH_COOKIE_SECURE'],
    env['NODE_ENV'] === 'production' || (oidc?.redirectUri.startsWith('https://') ?? false),
    'AUTH_COOKIE_SECURE',
  );

  return {
    host: nonEmpty(env['HOST']) ?? '0.0.0.0',
    port: parseInteger(env['PORT'], 8080, 1, 65535, 'PORT'),
    demoMode,
    nutHost: nutHost ?? null,
    nutName: nonEmpty(env['NUT_NAME']) ?? null,
    nutPort: parseInteger(env['NUT_PORT'], 3493, 1, 65535, 'NUT_PORT'),
    nutTls,
    nutUsername: nutUsername ?? null,
    nutPassword: nutPassword ?? null,
    clearNutCredentials,
    credentialsEncryptionKey,
    pollIntervalMs:
      parseInteger(env['POLL_INTERVAL_SECONDS'], 5, 1, 300, 'POLL_INTERVAL_SECONDS') * 1000,
    discoveryIntervalMs:
      parseInteger(env['DISCOVERY_INTERVAL_SECONDS'], 60, 5, 3600, 'DISCOVERY_INTERVAL_SECONDS') *
      1000,
    requestTimeoutMs: parseInteger(env['NUT_TIMEOUT_MS'], 5000, 100, 60000, 'NUT_TIMEOUT_MS'),
    sampleIntervalMs:
      parseInteger(env['SAMPLE_INTERVAL_SECONDS'], 30, 5, 3600, 'SAMPLE_INTERVAL_SECONDS') * 1000,
    sampleRetentionDays: parseInteger(
      env['HISTORY_RETENTION_DAYS'],
      30,
      1,
      3650,
      'HISTORY_RETENTION_DAYS',
    ),
    eventRetentionDays: parseInteger(
      env['EVENT_RETENTION_DAYS'],
      90,
      1,
      3650,
      'EVENT_RETENTION_DAYS',
    ),
    databasePath,
    webDistDir: resolveFromProject(nonEmpty(env['WEB_DIST_DIR']) ?? 'dist/volt/browser'),
    webOrigins,
    auth: {
      enabled: Boolean(authEmail && (authPassword || oidc)),
      email: authEmail,
      password: authPassword,
      cookieSecure,
      oidc,
    },
  };
}

function parseUrl(value: string, name: string): URL {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) throw new Error('Invalid URL');
    return url;
  } catch {
    throw new Error(`${name} must be an absolute URL without credentials, query or fragment`);
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function resolveFromProject(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
