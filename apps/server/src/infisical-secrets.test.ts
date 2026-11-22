import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadInfisicalAuthSecrets } from './infisical-secrets.js';

describe('loadInfisicalAuthSecrets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads auth and OIDC values from their configured v4 secret paths', async () => {
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname.endsWith('/universal-auth/login')) {
        return Response.json({ accessToken: 'access-token' });
      }
      if (url.searchParams.get('secretPath') === '/authentication') {
        return Response.json({
          secrets: [
            { secretKey: 'AUTH_EMAIL', secretValue: 'volt@example.test' },
            { secretKey: 'AUTH_PASSWORD', secretValue: 'password-value' },
          ],
        });
      }
      return Response.json({
        secrets: [
          { secretKey: 'OIDC_CLIENT_ID', secretValue: 'oidc-client' },
          { secretKey: 'OIDC_CLIENT_SECRET', secretValue: 'oidc-secret' },
          { secretKey: 'OIDC_ISSUER', secretValue: 'https://identity.example.test' },
          {
            secretKey: 'OIDC_REDIRECT_URI',
            secretValue: 'https://volt.example.test/api/auth/oidc/callback',
          },
          { secretKey: 'UNRELATED_SECRET', secretValue: 'ignore-me' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    quietLogs();

    const secrets = await loadInfisicalAuthSecrets(
      {
        INFISICAL_CLIENT_ID: 'machine-id',
        INFISICAL_CLIENT_SECRET: 'machine-secret',
        INFISICAL_PROJECT_ID: 'project-id',
        INFISICAL_SITE_URL: 'https://infisical.example.test',
        INFISICAL_ENVIRONMENT: 'prod',
        INFISICAL_AUTH_SECRET_PATH: '/authentication',
        INFISICAL_OIDC_SECRET_PATH: '/oidc',
      },
      { auth: true, oidc: true },
    );

    expect(secrets).toEqual({
      AUTH_EMAIL: 'volt@example.test',
      AUTH_PASSWORD: 'password-value',
      OIDC_CLIENT_ID: 'oidc-client',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      OIDC_ISSUER: 'https://identity.example.test',
      OIDC_REDIRECT_URI: 'https://volt.example.test/api/auth/oidc/callback',
    });
    expect(requests).toHaveLength(3);
    expect(requests[1]?.url.pathname).toBe('/api/v4/secrets');
    expect(requests[1]?.url.searchParams.get('projectId')).toBe('project-id');
    expect(requests[1]?.url.searchParams.get('environment')).toBe('prod');
    expect(requests[1]?.url.searchParams.get('secretPath')).toBe('/authentication');
    expect(requests[2]?.url.searchParams.get('secretPath')).toBe('/oidc');
    expect(requests[1]?.init?.headers).toMatchObject({ Authorization: 'Bearer access-token' });
  });

  it('skips optional lookup when Infisical is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    quietLogs();

    await expect(loadInfisicalAuthSecrets({}, { auth: true, oidc: true })).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues startup without auth secrets when Universal Auth login fails', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ message: 'invalid client' }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    quietLogs();

    await expect(
      loadInfisicalAuthSecrets(
        {
          INFISICAL_CLIENT_ID: 'machine-id',
          INFISICAL_CLIENT_SECRET: 'machine-secret',
          INFISICAL_PROJECT_ID: 'project-id',
        },
        { auth: true, oidc: false },
      ),
    ).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function quietLogs(): void {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}
