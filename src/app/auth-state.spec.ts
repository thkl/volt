import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthState } from './auth-state';

describe('AuthState', () => {
  let auth: AuthState;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [AuthState] });
    auth = TestBed.inject(AuthState);
  });

  afterEach(() => {
    auth.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads the server session and authentication methods', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        authEnabled: true,
        authenticated: true,
        email: 'volt@example.test',
        methods: { password: true, oidc: true },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await auth.start();

    expect(auth.loading()).toBe(false);
    expect(auth.authEnabled()).toBe(true);
    expect(auth.authenticated()).toBe(true);
    expect(auth.email()).toBe('volt@example.test');
    expect(auth.methods()).toEqual({ password: true, oidc: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store' });
  });

  it('keeps the dashboard available when the authentication API is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    await auth.start();

    expect(auth.loading()).toBe(false);
    expect(auth.authEnabled()).toBe(false);
    expect(auth.authenticated()).toBe(false);
    expect(auth.methods()).toEqual({ password: false, oidc: false });
  });

  it('stores login errors and clears a stale error before retrying', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: 'Invalid credentials' } }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await auth.login('volt@example.test', 'wrong-password');
    expect(auth.error()).toBe('Invalid credentials');

    await auth.login('volt@example.test', 'new-password');
    expect(auth.error()).toBe('Invalid credentials');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
