import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthState } from './auth-state';
import { DemoState } from './demo-state';
import { LiveUpdates, NutHostForm } from './live-updates';
import type { SourceDiagnostic } from './demo-state';

@Component({
  imports: [FormsModule, RouterLink, RouterLinkActive, RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnInit, OnDestroy {
  readonly state = inject(DemoState);
  readonly auth = inject(AuthState);
  private readonly liveUpdates = inject(LiveUpdates);
  private readonly settingsDialog = viewChild<ElementRef<HTMLDialogElement>>('settingsDialog');
  readonly hostSaving = signal(false);
  readonly hostError = signal('');
  readonly editingHostId = signal<string | null>(null);
  hostForm: NutHostForm = emptyHostForm();
  loginEmail = '';
  loginPassword = '';

  private readonly authConnectionEffect = effect(() => {
    if (this.auth.loading()) {
      this.liveUpdates.pause();
    } else if (!this.auth.authEnabled() || this.auth.authenticated()) {
      this.liveUpdates.resume();
    } else {
      this.liveUpdates.pause();
    }
  });

  ngOnInit(): void {
    void this.auth.start();
  }

  ngOnDestroy(): void {
    this.auth.stop();
  }

  async signIn(): Promise<void> {
    await this.auth.login(this.loginEmail, this.loginPassword);
    if (this.auth.authenticated()) this.loginPassword = '';
  }

  selectDevice(event: Event): void {
    this.state.selectDevice((event.target as HTMLSelectElement).value);
  }

  selectScenario(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.state.selectScenario(value);
    void this.liveUpdates.selectScenario(value);
  }

  openSettings(): void {
    this.settingsDialog()?.nativeElement.showModal();
  }

  closeSettings(): void {
    this.settingsDialog()?.nativeElement.close();
  }

  editHost(hostId: string): void {
    const host = this.state.hosts().find((item) => item.id === hostId);
    if (!host || host.sourceType !== 'nut') return;
    this.editingHostId.set(host.id);
    this.hostError.set('');
    this.hostForm = {
      name: host.name,
      host: typeof host.endpointConfig['host'] === 'string' ? host.endpointConfig['host'] : '',
      port: typeof host.endpointConfig['port'] === 'number' ? host.endpointConfig['port'] : 3493,
      tls: host.endpointConfig['tls'] === true,
      username: '',
      password: '',
      clearCredentials: false,
    };
  }

  cancelHostEdit(): void {
    this.editingHostId.set(null);
    this.hostForm = emptyHostForm();
    this.hostError.set('');
  }

  async saveHost(): Promise<void> {
    this.hostSaving.set(true);
    this.hostError.set('');
    try {
      const editingId = this.editingHostId();
      if (editingId) {
        await this.liveUpdates.updateNutHost(editingId, this.hostForm);
      } else {
        await this.liveUpdates.createNutHost(this.hostForm);
      }
      this.cancelHostEdit();
    } catch (error) {
      this.hostError.set(
        error instanceof Error ? error.message : 'Host settings could not be saved',
      );
    } finally {
      this.hostSaving.set(false);
    }
  }

  async removeHost(hostId: string): Promise<void> {
    this.hostError.set('');
    try {
      await this.liveUpdates.removeHost(hostId);
      if (this.editingHostId() === hostId) this.cancelHostEdit();
    } catch (error) {
      this.hostError.set(error instanceof Error ? error.message : 'Host could not be removed');
    }
  }

  hostAddress(hostId: string): string {
    const host = this.state.hosts().find((item) => item.id === hostId);
    if (!host) return '';
    const address = host.endpointConfig['host'];
    const port = host.endpointConfig['port'];
    return typeof address === 'string'
      ? `${address}:${typeof port === 'number' ? port : 3493}`
      : '';
  }

  editingHostHasCredentials(): boolean {
    const editingId = this.editingHostId();
    return this.state.hosts().some((host) => host.id === editingId && host.credentialsConfigured);
  }

  sourceDiagnostic(hostId: string): SourceDiagnostic | undefined {
    return this.state.sourceHealth().find((source) => source.hostId === hostId);
  }

  sourceStatusText(hostId: string): string {
    const diagnostic = this.sourceDiagnostic(hostId);
    if (!diagnostic) return 'Waiting for collector status';
    const connection = diagnostic.connected ? 'Connected' : 'Not connected';
    const unit = diagnostic.discoveredUps === 1 ? 'UPS' : 'UPS devices';
    const count = `${diagnostic.discoveredUps} ${unit} found`;
    if (diagnostic.lastError) {
      const code = diagnostic.lastErrorCode ? ` (${diagnostic.lastErrorCode})` : '';
      return `${connection} · ${count} · ${diagnostic.lastError}${code}`;
    }
    return `${connection} · ${count}`;
  }
}

function emptyHostForm(): NutHostForm {
  return {
    name: '',
    host: '',
    port: 3493,
    tls: false,
    username: '',
    password: '',
    clearCredentials: false,
  };
}
