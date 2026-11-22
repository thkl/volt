import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, } from 'node:crypto';
import express from 'express';
const SESSION_COOKIE = 'volt_session';
const OIDC_STATE_COOKIE = 'volt_oidc_state';
const SESSION_TTL_MS = 8 * 60 * 60_000;
const OIDC_TTL_MS = 10 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const CLOCK_TOLERANCE_SECONDS = 60;
const anonEndpoints = ['/api/health'];
class OidcHttpError extends Error {
    operation;
    status;
    providerError;
    providerErrorDescription;
    constructor(operation, status, providerError, providerErrorDescription) {
        super(`OIDC ${operation} endpoint returned HTTP ${status}`);
        this.operation = operation;
        this.status = status;
        this.providerError = providerError;
        this.providerErrorDescription = providerErrorDescription;
        this.name = 'OidcHttpError';
    }
}
class OidcClaimsError extends Error {
    failedClaims;
    constructor(failedClaims) {
        super('OIDC ID token claims are invalid');
        this.failedClaims = failedClaims;
        this.name = 'OidcClaimsError';
    }
}
export class AuthManager {
    config;
    sessions = new Map();
    oidcTransactions = new Map();
    loginBuckets = new Map();
    passwordDigestKey = randomBytes(32);
    oidcMetadataPromise = null;
    oidcKeysPromise = null;
    constructor(config) {
        this.config = config;
    }
    get enabled() {
        return this.config.auth.enabled;
    }
    sessionTokenFromHeader(cookieHeader) {
        const pair = cookieHeader
            ?.split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
        if (!pair)
            return undefined;
        try {
            return decodeURIComponent(pair.slice(SESSION_COOKIE.length + 1));
        }
        catch {
            return undefined;
        }
    }
    hasValidSessionToken(token) {
        if (!token)
            return false;
        const session = this.sessions.get(token);
        if (!session)
            return false;
        if (session.expiresAt <= Date.now()) {
            this.sessions.delete(token);
            return false;
        }
        return true;
    }
    middleware = (request, response, next) => {
        if (!this.config.auth.enabled ||
            this.sessionFor(request) ||
            anonEndpoints.includes(request.originalUrl)) {
            next();
            return;
        }
        response.status(401).json({
            error: { code: 'authentication_required', message: 'Sign in to continue' },
        });
    };
    csrfGuard = (request, response, next) => {
        if (!this.config.auth.enabled || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
            next();
            return;
        }
        if (this.hasAllowedOrigin(request)) {
            next();
            return;
        }
        response
            .status(403)
            .json({ error: { code: 'origin_not_allowed', message: 'Origin is not allowed' } });
    };
    router() {
        const router = express.Router();
        router.get('/session', (request, response) => {
            response.json(this.status(request));
        });
        router.post('/login', this.csrfGuard, (request, response) => {
            this.login(request, response);
        });
        router.post('/logout', this.csrfGuard, (request, response) => {
            const token = this.cookieValue(request, SESSION_COOKIE);
            if (token)
                this.sessions.delete(token);
            this.clearCookie(response, SESSION_COOKIE);
            response.json({ data: { signedOut: true } });
        });
        router.get('/oidc/start', async (request, response) => {
            await this.startOidc(request, response);
        });
        router.get('/oidc/callback', async (request, response) => {
            await this.finishOidc(request, response);
        });
        return router;
    }
    status(request) {
        const methods = {
            password: Boolean(this.config.auth.password),
            oidc: Boolean(this.config.auth.oidc),
        };
        if (!this.config.auth.enabled)
            return { authEnabled: false, authenticated: false, methods };
        const session = this.sessionFor(request);
        return {
            authEnabled: true,
            authenticated: Boolean(session),
            ...(session ? { email: session.email } : {}),
            methods,
        };
    }
    login(request, response) {
        const ip = request.ip || request.socket.remoteAddress || 'unknown';
        const now = Date.now();
        for (const [address, attempt] of this.loginBuckets) {
            if (attempt.resetAt <= now)
                this.loginBuckets.delete(address);
        }
        const bucket = this.loginBuckets.get(ip);
        if (bucket && bucket.resetAt > now && bucket.attempts >= MAX_LOGIN_ATTEMPTS) {
            response.status(429).json({
                error: { code: 'login_limited', message: 'Too many sign-in attempts. Try again later.' },
            });
            return;
        }
        const body = request.body;
        const email = isRecord(body) && typeof body['email'] === 'string' ? body['email'].trim() : '';
        const password = isRecord(body) && typeof body['password'] === 'string' ? body['password'] : '';
        if (email.length > 254 || password.length > 1024 || !this.passwordMatches(email, password)) {
            const nextBucket = bucket && bucket.resetAt > now ? bucket : { attempts: 0, resetAt: now + LOGIN_WINDOW_MS };
            nextBucket.attempts += 1;
            if (!bucket && this.loginBuckets.size >= 10_000) {
                const oldest = this.loginBuckets.keys().next().value;
                if (oldest)
                    this.loginBuckets.delete(oldest);
            }
            this.loginBuckets.set(ip, nextBucket);
            response.status(401).json({
                error: { code: 'invalid_credentials', message: 'Email or password is incorrect' },
            });
            return;
        }
        this.loginBuckets.delete(ip);
        this.setSessionCookie(response, this.createSession(this.config.auth.email ?? ''));
        response.json({ data: { authenticated: true } });
    }
    passwordMatches(email, password) {
        const configuredEmail = this.config.auth.email ?? '';
        const configuredPassword = this.config.auth.password ?? '';
        const emailDigest = this.digest(email.trim().toLowerCase());
        const expectedEmailDigest = this.digest(configuredEmail);
        const passwordDigest = this.digest(password);
        const expectedPasswordDigest = this.digest(configuredPassword);
        const emailMatches = timingSafeEqual(emailDigest, expectedEmailDigest);
        const passwordMatches = timingSafeEqual(passwordDigest, expectedPasswordDigest);
        return emailMatches && passwordMatches && Boolean(configuredPassword);
    }
    digest(value) {
        return createHmac('sha256', this.passwordDigestKey).update(value).digest();
    }
    async startOidc(_request, response) {
        const oidc = this.config.auth.oidc;
        if (!oidc) {
            response.status(404).send('OIDC sign-in is not configured');
            return;
        }
        let step = 'discovery';
        try {
            const metadata = await this.getOidcMetadata();
            step = 'authorization_request';
            const verifier = randomBytes(32).toString('base64url');
            const pkceChallenge = createHash('sha256').update(verifier).digest('base64url');
            const state = randomBytes(32).toString('base64url');
            const nonce = randomBytes(32).toString('base64url');
            this.pruneOidcTransactions();
            this.oidcTransactions.set(state, { verifier, nonce, createdAt: Date.now() });
            if (this.oidcTransactions.size > 5000) {
                const oldest = this.oidcTransactions.keys().next().value;
                if (oldest)
                    this.oidcTransactions.delete(oldest);
            }
            this.setOidcStateCookie(response, state);
            const authorizationUrl = new URL(metadata.authorization_endpoint);
            authorizationUrl.searchParams.set('client_id', oidc.clientId);
            authorizationUrl.searchParams.set('redirect_uri', oidc.redirectUri);
            authorizationUrl.searchParams.set('response_type', 'code');
            authorizationUrl.searchParams.set('scope', 'openid email');
            authorizationUrl.searchParams.set('state', state);
            authorizationUrl.searchParams.set('nonce', nonce);
            authorizationUrl.searchParams.set('code_challenge', pkceChallenge);
            authorizationUrl.searchParams.set('code_challenge_method', 'S256');
            response.redirect(302, authorizationUrl.href);
        }
        catch (error) {
            logOidcFailure('start', step, error);
            this.redirectWithOidcError(response);
        }
    }
    async finishOidc(request, response) {
        const oidc = this.config.auth.oidc;
        if (!oidc) {
            response.status(404).send('OIDC sign-in is not configured');
            return;
        }
        const state = queryValue(request.query['state']);
        const cookieState = this.cookieValue(request, OIDC_STATE_COOKIE);
        const cookieMatchesState = Boolean(state && cookieState === state);
        const transaction = cookieMatchesState && state ? this.oidcTransactions.get(state) : undefined;
        const transactionExpired = Boolean(transaction && Date.now() - transaction.createdAt > OIDC_TTL_MS);
        this.clearCookie(response, OIDC_STATE_COOKIE);
        if (!state || !transaction || transactionExpired) {
            logOidcFailure('callback', 'state_validation', new Error('OIDC state validation failed'), {
                statePresent: Boolean(state),
                stateCookiePresent: Boolean(cookieState),
                cookieMatchesState,
                transactionFound: Boolean(transaction),
                transactionExpired,
            });
            this.redirectWithOidcError(response);
            return;
        }
        this.oidcTransactions.delete(state);
        let step = 'authorization_response';
        try {
            const providerError = queryValue(request.query['error']);
            if (providerError) {
                logOidcFailure('callback', 'provider_authorization', new Error('OIDC provider denied authorization'), {
                    providerError: safeLogText(providerError),
                    providerErrorDescription: safeLogText(queryValue(request.query['error_description'])),
                });
                this.redirectWithOidcError(response);
                return;
            }
            const code = queryValue(request.query['code']);
            if (!code || code.length > 4096)
                throw new Error('OIDC authorization response is invalid');
            step = 'discovery';
            const metadata = await this.getOidcMetadata();
            step = 'token_exchange';
            const tokens = await this.exchangeCode(code, transaction.verifier, metadata);
            step = 'id_token_validation';
            const claims = await this.verifyIdToken(tokens.id_token, transaction.nonce, metadata);
            const email = typeof claims['email'] === 'string' ? claims['email'].trim().toLowerCase() : '';
            const emailMatchesConfigured = Boolean(email && email === this.config.auth.email);
            const emailVerified = claims['email_verified'] === true;
            if (!emailMatchesConfigured || !emailVerified) {
                logOidcFailure('callback', 'identity_validation', new Error('OIDC identity was rejected'), {
                    emailClaimPresent: Boolean(email),
                    emailMatchesConfigured,
                    emailVerified,
                });
                this.redirectWithOidcError(response);
                return;
            }
            this.setSessionCookie(response, this.createSession(email));
            response.redirect(303, new URL('/', oidc.redirectUri).href);
        }
        catch (error) {
            logOidcFailure('callback', step, error);
            this.redirectWithOidcError(response);
        }
    }
    async getOidcMetadata() {
        const oidc = this.config.auth.oidc;
        if (!oidc)
            throw new Error('OIDC is disabled');
        if (!this.oidcMetadataPromise) {
            const issuer = oidc.issuer;
            const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
            this.oidcMetadataPromise = fetchJson(discoveryUrl, 'discovery')
                .then((value) => {
                const metadata = value;
                if (metadata.issuer !== issuer ||
                    typeof metadata.authorization_endpoint !== 'string' ||
                    typeof metadata.token_endpoint !== 'string' ||
                    typeof metadata.jwks_uri !== 'string') {
                    throw new Error('OIDC discovery metadata is invalid');
                }
                for (const endpoint of [
                    metadata.authorization_endpoint,
                    metadata.token_endpoint,
                    metadata.jwks_uri,
                ]) {
                    requireSecureEndpoint(endpoint, issuer);
                }
                return metadata;
            })
                .catch((error) => {
                this.oidcMetadataPromise = null;
                throw error;
            });
        }
        return this.oidcMetadataPromise;
    }
    async exchangeCode(code, verifier, metadata) {
        const oidc = this.config.auth.oidc;
        if (!oidc)
            throw new Error('OIDC is disabled');
        const form = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: oidc.redirectUri,
            code_verifier: verifier,
        });
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        };
        if (oidc.clientAuthMethod === 'client_secret_basic') {
            const authorization = Buffer.from(`${formEncode(oidc.clientId)}:${formEncode(oidc.clientSecret)}`).toString('base64');
            headers['Authorization'] = `Basic ${authorization}`;
        }
        else {
            form.set('client_id', oidc.clientId);
            form.set('client_secret', oidc.clientSecret);
        }
        const response = await fetch(metadata.token_endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
            headers,
            body: form,
        });
        if (!response.ok) {
            const details = parseOidcErrorDetails(await response.text().catch(() => ''));
            throw new OidcHttpError('token_exchange', response.status, details.providerError, details.providerErrorDescription);
        }
        const tokenResponse = await response.text();
        if (tokenResponse.length > 65_536)
            throw new Error('OIDC token response is too large');
        const tokens = JSON.parse(tokenResponse);
        if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 32_768) {
            throw new Error('OIDC token response is invalid');
        }
        return { id_token: tokens.id_token };
    }
    async verifyIdToken(token, expectedNonce, metadata) {
        const parts = token.split('.');
        if (parts.length !== 3)
            throw new Error('OIDC ID token is invalid');
        const [encodedHeader, encodedClaims, encodedSignature] = parts;
        if (!encodedHeader || !encodedClaims || !encodedSignature)
            throw new Error('OIDC ID token is invalid');
        const header = decodeJson(encodedHeader);
        const claims = decodeJson(encodedClaims);
        if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') {
            throw new Error('OIDC ID token uses an unsupported signature');
        }
        let keys = await this.getOidcKeys(metadata);
        let jwk = keys.find((key) => key.kid === header['kid'] &&
            key.kty === 'RSA' &&
            (!key.use || key.use === 'sig') &&
            (!key.alg || key.alg === 'RS256'));
        if (!jwk) {
            this.oidcKeysPromise = null;
            keys = await this.getOidcKeys(metadata);
            jwk = keys.find((key) => key.kid === header['kid'] &&
                key.kty === 'RSA' &&
                (!key.use || key.use === 'sig') &&
                (!key.alg || key.alg === 'RS256'));
        }
        if (!jwk)
            throw new Error('OIDC signing key was not found');
        const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
        const signedContent = Buffer.from(`${encodedHeader}.${encodedClaims}`);
        const signature = Buffer.from(encodedSignature, 'base64url');
        if (!verify('RSA-SHA256', signedContent, publicKey, signature)) {
            throw new Error('OIDC ID token signature is invalid');
        }
        const oidc = this.config.auth.oidc;
        if (!oidc)
            throw new Error('OIDC is disabled');
        const now = Math.floor(Date.now() / 1000);
        const audience = claims['aud'];
        const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
        const invalidClaims = [
            ...(claims['iss'] !== metadata.issuer ? ['issuer'] : []),
            ...(!audiences.includes(oidc.clientId) ? ['audience'] : []),
            ...(audiences.length > 1 && claims['azp'] !== oidc.clientId ? ['authorized_party'] : []),
            ...(typeof claims['exp'] !== 'number' || claims['exp'] < now - CLOCK_TOLERANCE_SECONDS
                ? ['expiration']
                : []),
            ...(typeof claims['iat'] !== 'number' || claims['iat'] > now + CLOCK_TOLERANCE_SECONDS
                ? ['issued_at']
                : []),
            ...(typeof claims['nbf'] === 'number' && claims['nbf'] > now + CLOCK_TOLERANCE_SECONDS
                ? ['not_before']
                : []),
            ...(claims['nonce'] !== expectedNonce ? ['nonce'] : []),
            ...(typeof claims['sub'] !== 'string' || claims['sub'].length === 0 ? ['subject'] : []),
        ];
        if (invalidClaims.length > 0)
            throw new OidcClaimsError(invalidClaims);
        return claims;
    }
    async getOidcKeys(metadata) {
        if (!this.oidcKeysPromise) {
            this.oidcKeysPromise = fetchJson(metadata.jwks_uri, 'jwks')
                .then((value) => {
                const keys = isRecord(value) && Array.isArray(value['keys']) ? value['keys'] : null;
                if (!keys || !keys.every(isRecord))
                    throw new Error('OIDC key set is invalid');
                return keys;
            })
                .catch((error) => {
                this.oidcKeysPromise = null;
                throw error;
            });
        }
        return this.oidcKeysPromise;
    }
    createSession(email) {
        this.pruneSessions();
        if (this.sessions.size >= 5000) {
            const oldest = this.sessions.keys().next().value;
            if (oldest)
                this.sessions.delete(oldest);
        }
        const token = randomBytes(32).toString('base64url');
        this.sessions.set(token, { email, expiresAt: Date.now() + SESSION_TTL_MS });
        return token;
    }
    sessionFor(request) {
        const token = this.sessionTokenFromHeader(request.headers.cookie);
        if (!token)
            return undefined;
        const session = this.sessions.get(token);
        if (!session)
            return undefined;
        if (session.expiresAt <= Date.now()) {
            this.sessions.delete(token);
            return undefined;
        }
        return session;
    }
    setSessionCookie(response, token) {
        response.append('Set-Cookie', this.cookie(SESSION_COOKIE, token, SESSION_TTL_MS));
    }
    setOidcStateCookie(response, state) {
        response.append('Set-Cookie', this.cookie(OIDC_STATE_COOKIE, state, OIDC_TTL_MS));
    }
    clearCookie(response, name) {
        response.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.auth.cookieSecure ? '; Secure' : ''}`);
    }
    cookie(name, value, maxAgeMs) {
        return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${this.config.auth.cookieSecure ? '; Secure' : ''}`;
    }
    cookieValue(request, name) {
        const pair = request.headers.cookie
            ?.split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${name}=`));
        if (!pair)
            return undefined;
        try {
            return decodeURIComponent(pair.slice(name.length + 1));
        }
        catch {
            return undefined;
        }
    }
    hasAllowedOrigin(request) {
        const origin = request.header('origin');
        if (!origin)
            return false;
        if (this.config.webOrigins.has(origin))
            return true;
        try {
            return new URL(origin).host === request.get('host');
        }
        catch {
            return false;
        }
    }
    pruneSessions() {
        const now = Date.now();
        for (const [token, session] of this.sessions) {
            if (session.expiresAt <= now)
                this.sessions.delete(token);
        }
    }
    pruneOidcTransactions() {
        const now = Date.now();
        for (const [state, transaction] of this.oidcTransactions) {
            if (now - transaction.createdAt > OIDC_TTL_MS)
                this.oidcTransactions.delete(state);
        }
    }
    redirectWithOidcError(response) {
        const redirect = this.config.auth.oidc?.redirectUri;
        response.redirect(303, redirect ? `${new URL('/', redirect).href}?auth_error=oidc` : '/?auth_error=oidc');
    }
}
async function fetchJson(url, operation) {
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        const details = parseOidcErrorDetails(await response.text().catch(() => ''));
        throw new OidcHttpError(operation, response.status, details.providerError, details.providerErrorDescription);
    }
    const text = await response.text();
    if (text.length > 1_000_000)
        throw new Error('OIDC endpoint response is too large');
    return JSON.parse(text);
}
function requireSecureEndpoint(endpoint, issuer) {
    const parsed = new URL(endpoint);
    const issuerUrl = new URL(issuer);
    const localIssuer = ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname);
    if ((parsed.protocol !== 'https:' && !(localIssuer && parsed.protocol === 'http:')) ||
        parsed.username ||
        parsed.password ||
        parsed.hash) {
        throw new Error('OIDC endpoints must use HTTPS');
    }
}
function decodeJson(segment) {
    try {
        const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
        if (!isRecord(value))
            throw new Error('Invalid JSON object');
        return value;
    }
    catch {
        throw new Error('OIDC ID token is invalid');
    }
}
function formEncode(value) {
    return new URLSearchParams({ value }).toString().slice('value='.length);
}
function queryValue(value) {
    return typeof value === 'string' ? value : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseOidcErrorDetails(body) {
    try {
        const value = JSON.parse(body.slice(0, 8192));
        if (!isRecord(value))
            return {};
        const providerError = safeLogText(typeof value['error'] === 'string' ? value['error'] : undefined);
        const providerErrorDescription = safeLogText(typeof value['error_description'] === 'string' ? value['error_description'] : undefined);
        return {
            ...(providerError === undefined ? {} : { providerError }),
            ...(providerErrorDescription === undefined ? {} : { providerErrorDescription }),
        };
    }
    catch {
        return {};
    }
}
function safeLogText(value) {
    return value
        ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}
function logOidcFailure(flow, step, error, details = {}) {
    const failure = {
        level: 'error',
        message: 'OIDC sign-in failed',
        flow,
        step,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        reason: safeLogText(error instanceof Error ? error.message : 'Unknown error'),
    };
    if (error instanceof OidcHttpError) {
        failure['operation'] = error.operation;
        failure['httpStatus'] = error.status;
        if (error.providerError)
            failure['providerError'] = error.providerError;
        if (error.providerErrorDescription) {
            failure['providerErrorDescription'] = error.providerErrorDescription;
        }
    }
    if (error instanceof OidcClaimsError)
        failure['invalidClaims'] = error.failedClaims;
    if (error instanceof Error && error.cause instanceof Error) {
        failure['causeType'] = error.cause.name;
        failure['causeReason'] = safeLogText(error.cause.message);
        if (isRecord(error.cause)) {
            const code = error.cause['code'];
            if (typeof code === 'string')
                failure['causeCode'] = safeLogText(code);
        }
    }
    console.error(JSON.stringify({ ...failure, ...details }));
}
