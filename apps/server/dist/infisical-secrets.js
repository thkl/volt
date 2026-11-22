import { resolveEnvironmentSecret } from './secret-env.js';
const AUTH_SECRET_NAMES = ['AUTH_EMAIL', 'AUTH_PASSWORD'];
const OIDC_SECRET_NAMES = [
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_ISSUER',
    'OIDC_REDIRECT_URI',
    'OIDC_CLIENT_AUTH_METHOD',
];
const REQUEST_TIMEOUT_MS = 10_000;
export async function loadInfisicalAuthSecrets(env, lookup) {
    const clientIdCredential = firstSecretValue(env, ['INFISICAL_CLIENT_ID', 'INFISICAL_MACHINE_ID']);
    const clientSecretCredential = firstSecretValue(env, [
        'INFISICAL_CLIENT_SECRET',
        'INFISICAL_MACHINE_TOKEN',
    ]);
    const clientId = clientIdCredential?.value;
    const clientSecret = clientSecretCredential?.value;
    const projectId = env['INFISICAL_PROJECT_ID']?.trim() || undefined;
    const requestedGroups = [lookup.auth ? 'auth' : null, lookup.oidc ? 'oidc' : null].filter((group) => group !== null);
    if (requestedGroups.length === 0) {
        logInfisical('info', 'Environment and file settings are complete; skipping Infisical lookup');
        return {};
    }
    const enabled = Boolean(clientId || clientSecret || projectId);
    if (!enabled) {
        logInfisical('info', 'Infisical is not configured; skipping missing optional settings', {
            requestedGroups,
        });
        return {};
    }
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
        logInfisical('warn', 'Infisical configuration is incomplete; skipping Infisical lookup', {
            requestedGroups,
            clientIdPresent: Boolean(clientId),
            clientSecretPresent: Boolean(clientSecret),
            projectIdPresent: Boolean(projectId),
        });
        return {};
    }
    let siteUrl;
    let environment;
    let authSecretPath;
    let oidcSecretPath;
    try {
        siteUrl = normalizeSiteUrl(env['INFISICAL_SITE_URL']?.trim() || 'https://us.infisical.com');
        environment = env['INFISICAL_ENVIRONMENT']?.trim() || 'prod';
        const defaultSecretPath = normalizeSecretPath(env['INFISICAL_SECRET_PATH']?.trim() || '/');
        authSecretPath = lookup.auth
            ? normalizeSecretPath(env['INFISICAL_AUTH_SECRET_PATH']?.trim() || defaultSecretPath)
            : defaultSecretPath;
        oidcSecretPath = lookup.oidc
            ? normalizeSecretPath(env['INFISICAL_OIDC_SECRET_PATH']?.trim() || defaultSecretPath)
            : defaultSecretPath;
    }
    catch (error) {
        logInfisical('warn', 'Infisical settings are invalid; skipping Infisical lookup', {
            reason: error instanceof Error ? error.message : 'invalid settings',
        });
        return {};
    }
    logInfisical('info', 'Infisical secret loading started', {
        site: new URL(siteUrl).origin,
        environment,
        requestedGroups,
        authSecretPath,
        oidcSecretPath,
    });
    const secrets = {};
    let accessToken;
    try {
        const loginUrl = apiUrl(siteUrl, '/api/v1/auth/universal-auth/login');
        const loginPayload = await requestJson(loginUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, clientSecret }),
        }, 'Universal Auth login');
        if (!isRecord(loginPayload) ||
            typeof loginPayload['accessToken'] !== 'string' ||
            !loginPayload['accessToken']) {
            throw new InfisicalRequestError('Universal Auth login returned an invalid response');
        }
        accessToken = loginPayload['accessToken'];
    }
    catch (error) {
        logInfisical('warn', 'Infisical login failed; continuing with available settings', {
            reason: error instanceof Error ? error.message : 'unexpected error',
        });
        return {};
    }
    const configuredGroups = [
        ...(lookup.auth ? [[authSecretPath, AUTH_SECRET_NAMES]] : []),
        ...(lookup.oidc ? [[oidcSecretPath, OIDC_SECRET_NAMES]] : []),
    ];
    const secretNamesByPath = new Map();
    for (const [path, names] of configuredGroups) {
        const pathNames = secretNamesByPath.get(path) ?? new Set();
        for (const name of names)
            pathNames.add(name);
        secretNamesByPath.set(path, pathNames);
    }
    for (const [secretPath, names] of secretNamesByPath) {
        try {
            const response = await fetchSecretPath({
                siteUrl,
                accessToken,
                projectId,
                environment,
                secretPath,
            });
            if (!isRecord(response) || !Array.isArray(response['secrets'])) {
                throw new InfisicalRequestError(`secret fetch for ${secretPath} returned an invalid response`);
            }
            for (const value of response['secrets']) {
                if (isRecord(value) &&
                    typeof value['secretKey'] === 'string' &&
                    typeof value['secretValue'] === 'string' &&
                    names.has(value['secretKey'])) {
                    secrets[value['secretKey']] = value['secretValue'];
                }
            }
        }
        catch (error) {
            logInfisical('warn', 'Infisical path lookup failed; skipping values from this path', {
                environment,
                secretPath,
                reason: error instanceof Error ? error.message : 'unexpected error',
            });
        }
    }
    logInfisical('info', 'Infisical secret loading completed', {
        loadedSecretNames: Object.keys(secrets),
    });
    return secrets;
}
async function fetchSecretPath(options) {
    try {
        return await requestSecretsApi(options, 'v4');
    }
    catch (error) {
        if (!(error instanceof InfisicalRequestError) ||
            ![400, 404, 405].includes(error.statusCode ?? 0)) {
            throw error;
        }
        logInfisical('info', 'Infisical v4 secrets endpoint rejected request; retrying v3 endpoint', {
            status: error.statusCode,
            environment: options.environment,
            secretPath: options.secretPath,
        });
        return requestSecretsApi(options, 'v3');
    }
}
function requestSecretsApi(options, version) {
    const endpoint = version === 'v4' ? '/api/v4/secrets' : '/api/v3/secrets/raw';
    const secretsUrl = apiUrl(options.siteUrl, endpoint);
    const query = new URLSearchParams({
        [version === 'v4' ? 'projectId' : 'workspaceId']: options.projectId,
        environment: options.environment,
        secretPath: options.secretPath,
    });
    if (version === 'v3')
        query.set('expandSecretReferences', 'true');
    secretsUrl.search = query.toString();
    return requestJson(secretsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${options.accessToken}` },
    }, `secret fetch for ${options.secretPath} (environment ${options.environment}, API ${version})`);
}
function firstSecretValue(env, names) {
    for (const name of names) {
        const resolved = resolveEnvironmentSecret(env, name);
        if (resolved.value) {
            return { name, source: resolved.source, value: resolved.value };
        }
    }
    return undefined;
}
function describeCredential(credential) {
    return credential
        ? { variable: credential.name, source: credential.source }
        : { configured: false };
}
function previewCredential(credential) {
    if (!credential)
        return { configured: false };
    return {
        variable: credential.name,
        source: credential.source,
        length: credential.value.length,
        firstFour: credential.value.length > 4 ? credential.value.slice(0, 4) : '[redacted]',
    };
}
function isEnabled(value) {
    return ['true', '1', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}
function logInfisical(level, message, fields = {}) {
    const log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    log(JSON.stringify({ level, message, ...fields }));
}
function apiUrl(siteUrl, path) {
    return new URL(path.replace(/^\//, ''), `${siteUrl.replace(/\/$/, '')}/`);
}
async function requestJson(url, init, operation) {
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
        let response;
        try {
            response = await fetch(url, { ...init, signal: controller.signal });
        }
        catch (error) {
            if (controller.signal.aborted) {
                throw new InfisicalRequestError(`${operation} timed out after ${REQUEST_TIMEOUT_MS} ms`);
            }
            const code = getNetworkErrorCode(error);
            throw new InfisicalRequestError(`${operation} network request failed${code ? ` (${code})` : ''}`);
        }
        if (!response.ok) {
            const detail = init.method === 'GET' ? await readApiErrorSummary(response) : null;
            logInfisical('error', 'Infisical API request failed', {
                operation,
                status: response.status,
                durationMs: Date.now() - startedAt,
                detail,
            });
            throw new InfisicalRequestError(`${operation} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
        }
        try {
            const payload = await response.json();
            logInfisical('info', 'Infisical API request completed', {
                operation,
                status: response.status,
                durationMs: Date.now() - startedAt,
            });
            return payload;
        }
        catch {
            if (controller.signal.aborted) {
                throw new InfisicalRequestError(`${operation} timed out after ${REQUEST_TIMEOUT_MS} ms`);
            }
            throw new InfisicalRequestError(`${operation} response was not valid JSON`);
        }
    }
    finally {
        clearTimeout(timeout);
    }
}
async function readApiErrorSummary(response) {
    try {
        const payload = await response.json();
        if (!isRecord(payload))
            return null;
        const details = isRecord(payload['details'])
            ? Object.entries(payload['details'])
                .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
                .map(([key, value]) => `${key}=${String(value)}`)
            : [];
        const parts = [payload['message'], payload['error'], ...details].filter((value) => typeof value === 'string' && value.length > 0);
        const summary = [...new Set(parts)]
            .join('; ')
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return summary ? summary.slice(0, 300) : null;
    }
    catch {
        return null;
    }
}
function getNetworkErrorCode(error) {
    if (typeof error !== 'object' || error === null || !('cause' in error))
        return null;
    const cause = error.cause;
    if (typeof cause !== 'object' || cause === null || !('code' in cause))
        return null;
    return typeof cause.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : null;
}
class InfisicalRequestError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
    }
}
function normalizeSiteUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('INFISICAL_SITE_URL must be a valid absolute URL');
    }
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash) {
        throw new Error('INFISICAL_SITE_URL must use HTTPS and cannot contain credentials or query data');
    }
    return url.href.replace(/\/$/, '');
}
function normalizeSecretPath(value) {
    if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
        throw new Error('INFISICAL_SECRET_PATH must be an absolute secret folder path');
    }
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
