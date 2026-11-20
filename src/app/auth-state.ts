import { Injectable, signal } from '@angular/core';

interface AuthResponse {
  authEnabled: boolean;
  authenticated: boolean;
  email?: string;
  methods: { password: boolean; oidc: boolean };
}

@Injectable({ providedIn: 'root' })
export class AuthState {
  readonly loading = signal(true);
  readonly authEnabled = signal(false);
  readonly authenticated = signal(false);
  readonly email = signal('');
  readonly methods = signal({ password: false, oidc: false });
  readonly error = signal('');
  readonly oidcError = signal(false);
  private refreshTimer: number | undefined;

  async start(): Promise<void> {
    const query = new URLSearchParams(window.location.search);
    if (query.has('auth_error')) {
      this.oidcError.set(true);
      history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    }
    await this.refresh();
    this.refreshTimer = window.setInterval(() => void this.refresh(), 30_000);
  }

  stop(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
  }

  async login(email: string, password: string): Promise<void> {
    this.error.set('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message =
          isRecord(payload) &&
          isRecord(payload['error']) &&
          typeof payload['error']['message'] === 'string'
            ? payload['error']['message']
            : 'Sign-in failed';
        throw new Error(message);
      }
      await this.refresh();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Sign-in failed');
    }
  }

  async logout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // The session may have expired or the backend may be offline.
    } finally {
      this.authenticated.set(false);
      this.email.set('');
      this.error.set('');
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('Authentication status is unavailable');
      const payload = (await response.json()) as AuthResponse;
      this.authEnabled.set(payload.authEnabled === true);
      this.authenticated.set(payload.authenticated === true);
      this.email.set(typeof payload.email === 'string' ? payload.email : '');
      this.methods.set({
        password: payload.methods?.password === true,
        oidc: payload.methods?.oidc === true,
      });
    } catch {
      // Preserve the demo frontend if no backend is running.
      this.authEnabled.set(false);
      this.authenticated.set(false);
      this.email.set('');
      this.methods.set({ password: false, oidc: false });
    } finally {
      this.loading.set(false);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
