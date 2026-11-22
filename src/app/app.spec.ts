import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { App } from './app';
import { routes } from './app.routes';
import { AuthState } from './auth-state';
import { LiveUpdates } from './live-updates';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(routes),
        {
          provide: AuthState,
          useValue: {
            loading: signal(false),
            authEnabled: signal(false),
            authenticated: signal(false),
            email: signal(''),
            methods: signal({ password: false, oidc: false }),
            error: signal(''),
            oidcError: signal(false),
            start: vi.fn(async () => undefined),
            stop: vi.fn(),
            logout: vi.fn(async () => undefined),
          },
        },
        {
          provide: LiveUpdates,
          useValue: { pause: vi.fn(), resume: vi.fn() },
        },
      ],
    }).compileComponents();
  });

  it('renders navigation and clearly marks the prototype as demo data', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('nav[aria-label="Main navigation"]')).toBeTruthy();
    expect(page.querySelector('select[aria-label="Change demo state"]')).toBeTruthy();
    expect(page.textContent).toContain('System online');
  });
});
