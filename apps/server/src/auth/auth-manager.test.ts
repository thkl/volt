import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { Request, Response } from 'express';
import { loadConfig } from '../config.js';
import { AuthManager } from './auth-manager.js';

interface AuthInternals {
  login(request: Request, response: Response): void;
  startOidc(request: Request, response: Response): Promise<void>;
  finishOidc(request: Request, response: Response): Promise<void>;
}

describe('AuthManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('authenticates the configured email and password and creates an HttpOnly session', () => {
    const manager = new AuthManager(
      loadConfig({ AUTH_EMAIL: 'volt@example.test', AUTH_PASSWORD: 'correct horse battery' }),
    );
    const request = makeRequest({ email: 'VOLT@example.test', password: 'correct horse battery' });
    const response = makeResponse();

    (manager as unknown as AuthInternals).login(request, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringMatching(/^volt_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800$/),
    );
    expect(response.json).toHaveBeenCalledWith({ data: { authenticated: true } });

    const cookie = response.append.mock.calls[0]?.[1] as string;
    const token = cookie.split(';')[0]?.split('=')[1];
    const authenticatedRequest = makeRequest({}, `volt_session=${token}`);
    expect(manager.status(authenticatedRequest)).toMatchObject({
      authEnabled: true,
      authenticated: true,
      email: 'volt@example.test',
      methods: { password: true, oidc: false },
    });
    expect(manager.hasValidSessionToken(token)).toBe(true);
  });

  it('rejects invalid credentials and rate limits repeated failures by client IP', () => {
    const manager = new AuthManager(
      loadConfig({ AUTH_EMAIL: 'volt@example.test', AUTH_PASSWORD: 'correct-password' }),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = makeResponse();
      (manager as unknown as AuthInternals).login(
        makeRequest({ email: 'volt@example.test', password: 'wrong-password' }),
        response,
      );
      expect(response.status).toHaveBeenCalledWith(401);
    }

    const limited = makeResponse();
    (manager as unknown as AuthInternals).login(
      makeRequest({ email: 'volt@example.test', password: 'correct-password' }),
      limited,
    );

    expect(limited.status).toHaveBeenCalledWith(429);
    expect(limited.json).toHaveBeenCalledWith({
      error: { code: 'login_limited', message: 'Too many sign-in attempts. Try again later.' },
    });
  });

  it('allows health checks without a session but protects other API paths', () => {
    const manager = new AuthManager(
      loadConfig({ AUTH_EMAIL: 'volt@example.test', AUTH_PASSWORD: 'secret' }),
    );
    const health = makeRequest({}, undefined, '/api/health');
    const protectedPath = makeRequest({}, undefined, '/api/devices');
    const healthResponse = makeResponse();
    const protectedResponse = makeResponse();
    const healthNext = vi.fn();
    const protectedNext = vi.fn();

    manager.middleware(health, healthResponse, healthNext);
    manager.middleware(protectedPath, protectedResponse, protectedNext);

    expect(healthNext).toHaveBeenCalledOnce();
    expect(protectedNext).not.toHaveBeenCalled();
    expect(protectedResponse.status).toHaveBeenCalledWith(401);
  });

  it('requires a same-origin header for authenticated state-changing requests', () => {
    const manager = new AuthManager(
      loadConfig({ AUTH_EMAIL: 'volt@example.test', AUTH_PASSWORD: 'secret' }),
    );
    const denied = makeRequest({}, undefined, '/api/hosts', 'POST');
    const allowed = makeRequest({}, undefined, '/api/hosts', 'POST', 'https://volt.example.test');
    const deniedResponse = makeResponse();
    const allowedResponse = makeResponse();
    const deniedNext = vi.fn();
    const allowedNext = vi.fn();

    manager.csrfGuard(denied, deniedResponse, deniedNext);
    manager.csrfGuard(allowed, allowedResponse, allowedNext);

    expect(deniedResponse.status).toHaveBeenCalledWith(403);
    expect(deniedNext).not.toHaveBeenCalled();
    expect(allowedNext).toHaveBeenCalledOnce();
  });

  it('completes OIDC with a verified ID token and the configured email', async () => {
    const manager = createOidcManager();
    const { fetchMock, setNonce } = setupOidcProvider('volt@example.test', true);
    const internals = manager as unknown as AuthInternals;
    const startResponse = makeRedirectResponse();

    await internals.startOidc({} as Request, startResponse.response);

    const authorizationUrl = new URL(startResponse.redirect.mock.calls[0]?.[1] as string);
    const state = authorizationUrl.searchParams.get('state');
    setNonce(authorizationUrl.searchParams.get('nonce') ?? '');
    const stateCookie = startResponse.append.mock.calls[0]?.[1] as string;
    expect(authorizationUrl.searchParams.get('client_id')).toBe('volt-client');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(state).toBeTruthy();

    const callbackResponse = makeRedirectResponse();
    await internals.finishOidc(
      {
        query: { state, code: 'authorization-code' },
        headers: { cookie: stateCookie.split(';')[0] },
      } as unknown as Request,
      callbackResponse.response,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(callbackResponse.redirect).toHaveBeenCalledWith(303, 'https://volt.example.test/');
    expect(
      callbackResponse.append.mock.calls.some(([, value]) =>
        String(value).startsWith('volt_session='),
      ),
    ).toBe(true);
  });

  it('rejects an OIDC identity that does not match the configured email', async () => {
    const manager = createOidcManager();
    const { setNonce } = setupOidcProvider('attacker@example.test', true);
    const internals = manager as unknown as AuthInternals;
    const startResponse = makeRedirectResponse();
    await internals.startOidc({} as Request, startResponse.response);
    const authorizationUrl = new URL(startResponse.redirect.mock.calls[0]?.[1] as string);
    setNonce(authorizationUrl.searchParams.get('nonce') ?? '');
    const stateCookie = startResponse.append.mock.calls[0]?.[1] as string;

    const callbackResponse = makeRedirectResponse();
    await internals.finishOidc(
      {
        query: { state: authorizationUrl.searchParams.get('state'), code: 'authorization-code' },
        headers: { cookie: stateCookie.split(';')[0] },
      } as unknown as Request,
      callbackResponse.response,
    );

    expect(callbackResponse.redirect).toHaveBeenCalledWith(
      303,
      'https://volt.example.test/?auth_error=oidc',
    );
    expect(
      callbackResponse.append.mock.calls.some(([, value]) =>
        String(value).startsWith('volt_session='),
      ),
    ).toBe(false);
  });
});

function makeRequest(
  body: unknown,
  cookie?: string,
  originalUrl = '/api/auth/login',
  method = 'POST',
  origin?: string,
): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return {
    body,
    ip: '192.0.2.10',
    method,
    originalUrl,
    headers,
    socket: { remoteAddress: '192.0.2.10' },
    header: (name: string) => (name.toLowerCase() === 'origin' ? origin : undefined),
    get: (name: string) => (name.toLowerCase() === 'host' ? 'volt.example.test' : undefined),
  } as unknown as Request;
}

function makeResponse() {
  return {
    append: vi.fn(),
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response & {
    append: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
}

function createOidcManager(): AuthManager {
  return new AuthManager(
    loadConfig({
      AUTH_EMAIL: 'volt@example.test',
      OIDC_ISSUER: 'https://identity.example.test',
      OIDC_CLIENT_ID: 'volt-client',
      OIDC_CLIENT_SECRET: 'oidc-client-secret',
      OIDC_REDIRECT_URI: 'https://volt.example.test/api/auth/oidc/callback',
    }),
  );
}

function setupOidcProvider(email: string, emailVerified: boolean) {
  const issuer = 'https://identity.example.test';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'key-1',
    use: 'sig',
    alg: 'RS256',
  };
  let nonce = '';
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url.pathname === '/token') {
      const body = String(init?.body ?? '');
      expect(new URLSearchParams(body).get('code')).toBe('authorization-code');
      const authorizationUrl = new URL(`${issuer}/authorize`);
      authorizationUrl.search = new URLSearchParams({ nonce }).toString();
      const token = makeIdToken(privateKey, {
        iss: issuer,
        aud: 'volt-client',
        exp: Math.floor(Date.now() / 1000) + 600,
        iat: Math.floor(Date.now() / 1000),
        sub: 'subject-1',
        nonce: authorizationUrl.searchParams.get('nonce') ?? '',
        email,
        email_verified: emailVerified,
      });
      return new Response(JSON.stringify({ id_token: token }), { status: 200 });
    }
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, setNonce: (value: string) => (nonce = value) };
}

function makeIdToken(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  claims: object,
) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const content = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
  return `${content}.${signature}`;
}

function makeRedirectResponse() {
  const append = vi.fn();
  const redirect = vi.fn();
  return {
    append,
    redirect,
    response: { append, redirect } as unknown as Response,
  };
}
