import { dirname, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolveFileBackedSecrets } from './secret-env.js';

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
  trustedProxyCidrs: readonly string[];
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
  env = resolveFileBackedSecrets(env);
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
  const trustedProxyCidrs = parseTrustedProxyCidrs(env['TRUSTED_PROXY_CIDRS']);
  let authEmail = nonEmpty(env['AUTH_EMAIL'])?.toLowerCase() ?? null;
  let authPassword =
    env['AUTH_PASSWORD'] && env['AUTH_PASSWORD'].length > 0 ? env['AUTH_PASSWORD'] : null;
  const oidcIssuer = nonEmpty(env['OIDC_ISSUER']) ?? null;
  const oidcClientId = nonEmpty(env['OIDC_CLIENT_ID']) ?? null;
  const oidcClientSecret = nonEmpty(env['OIDC_CLIENT_SECRET']) ?? null;
  const oidcRedirectUri = nonEmpty(env['OIDC_REDIRECT_URI']) ?? null;
  const oidcClientAuthMethod = nonEmpty(env['OIDC_CLIENT_AUTH_METHOD']) ?? null;
  const oidcValues = [oidcIssuer, oidcClientId, oidcClientSecret, oidcRedirectUri];
  const oidcRequested = oidcValues.some(Boolean);

  if (authEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail)) {
    logAuthWarning('AUTH_EMAIL is invalid; disabling authentication settings that use it');
    authEmail = null;
  }
  if (authPassword && !authEmail) {
    logAuthWarning(
      'Password sign-in is incomplete; AUTH_EMAIL is unavailable, skipping password sign-in',
    );
    authPassword = null;
  }

  let oidc: AppConfig['auth']['oidc'] = null;
  if (oidcRequested) {
    const missing = [
      ['OIDC_ISSUER', oidcIssuer],
      ['OIDC_CLIENT_ID', oidcClientId],
      ['OIDC_CLIENT_SECRET', oidcClientSecret],
      ['OIDC_REDIRECT_URI', oidcRedirectUri],
      ['AUTH_EMAIL', authEmail],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      logAuthWarning('OIDC settings are incomplete; skipping OIDC sign-in', { missing });
    } else {
      try {
        const issuerUrl = parseUrl(oidcIssuer!, 'OIDC_ISSUER');
        const redirectUrl = parseUrl(oidcRedirectUri!, 'OIDC_REDIRECT_URI');
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
        if (
          oidcClientAuthMethod &&
          oidcClientAuthMethod !== 'client_secret_basic' &&
          oidcClientAuthMethod !== 'client_secret_post'
        ) {
          logAuthWarning('OIDC_CLIENT_AUTH_METHOD is invalid; using client_secret_basic');
        }
        oidc = {
          issuer: oidcIssuer!,
          clientId: oidcClientId!,
          clientSecret: oidcClientSecret!,
          clientAuthMethod:
            oidcClientAuthMethod === 'client_secret_post'
              ? 'client_secret_post'
              : 'client_secret_basic',
          redirectUri: redirectUrl.href,
        };
      } catch (error) {
        logAuthWarning('OIDC settings are invalid; skipping OIDC sign-in', {
          reason: error instanceof Error ? error.message : 'invalid settings',
        });
      }
    }
  } else if (oidcClientAuthMethod) {
    logAuthWarning('OIDC_CLIENT_AUTH_METHOD has no OIDC credentials or endpoints; ignoring it');
  }

  if (!authPassword && !oidc) {
    logAuthWarning('No complete sign-in method is configured; authentication is disabled');
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
    trustedProxyCidrs,
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

function logAuthWarning(message: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: 'warn', message, ...fields }));
}

function parseTrustedProxyCidrs(value: string | undefined): string[] {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [address, prefix, ...extra] = entry.split('/');
    const ipVersion = address ? isIP(address) : 0;
    const maxPrefix = ipVersion === 4 ? 32 : 128;
    if (
      ipVersion === 0 ||
      extra.length > 0 ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) === 0 || Number(prefix) > maxPrefix))
    ) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain valid IP addresses or CIDRs');
    }
  }

  return [...new Set(entries)];
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
