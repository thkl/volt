import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
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
