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
import { DeleteConfirmationDialog } from './components/delete-confirmation-dialog/delete-confirmation-dialog';
import type { DeleteConfirmationTarget } from './components/delete-confirmation-dialog/delete-confirmation-dialog';
import { HomeAssistantConnectionForm } from './components/homeassistant-connection-form/homeassistant-connection-form';
import { DemoState } from './demo-state';
import {
  AlertSettings,
  AlertSettingsForm,
  EnergyImpactSettings,
  InfluxDbSettings,
  InfluxDbSettingsForm,
  HomeAssistantHostForm,
  LiveUpdates,
  NutHostForm,
} from './live-updates';
import { HOME_ASSISTANT_NUMERIC_FIELDS } from './live-updates';
import type { HomeAssistantMetricDescriptor } from './components/homeassistant-connection-form/homeassistant-connection-form';
import type { BackendHost, SourceDiagnostic } from './demo-state';

@Component({
  imports: [
    DeleteConfirmationDialog,
    FormsModule,
    HomeAssistantConnectionForm,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
  ],
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
  readonly demoUpsSaving = signal(false);
  readonly demoUpsError = signal('');
  readonly deleteTarget = signal<DeleteConfirmationTarget | null>(null);
  readonly deleteBusy = signal(false);
  readonly deleteError = signal('');
  readonly editingHostId = signal<string | null>(null);
  readonly hostFormType = signal<'nut' | 'homeassistant'>('nut');
  readonly alertSettings = signal<AlertSettings | null>(null);
  readonly alertLoading = signal(false);
  readonly alertSaving = signal(false);
  readonly alertTesting = signal<'pushover' | 'email' | null>(null);
  readonly alertError = signal('');
  readonly alertNotice = signal('');
  readonly influxSettings = signal<InfluxDbSettings | null>(null);
  readonly influxLoading = signal(false);
  readonly influxSaving = signal(false);
  readonly influxTesting = signal(false);
  readonly influxError = signal('');
  readonly influxNotice = signal('');
  readonly energySettings = signal<EnergyImpactSettings | null>(null);
  readonly energyLoading = signal(false);
  readonly energySaving = signal(false);
  readonly energyError = signal('');
  readonly energyNotice = signal('');
  hostForm: NutHostForm = emptyHostForm();
  homeAssistantForm: HomeAssistantHostForm = emptyHomeAssistantForm();
  readonly homeAssistantMetrics: HomeAssistantMetricDescriptor[] = [
    { key: 'batteryCharge', label: 'Battery charge', unit: '%', exampleScale: 'fraction × 100' },
    { key: 'runtimeSeconds', label: 'Runtime', unit: 'seconds', exampleScale: 'minutes × 60' },
    { key: 'loadPercent', label: 'Load', unit: '%', exampleScale: 'fraction × 100' },
    { key: 'realPower', label: 'Output power', unit: 'W', exampleScale: 'kW × 1000' },
    { key: 'inputVoltage', label: 'Input voltage', unit: 'V', exampleScale: 'V × 1' },
    { key: 'outputVoltage', label: 'Output voltage', unit: 'V', exampleScale: 'V × 1' },
    { key: 'inputFrequency', label: 'Input frequency', unit: 'Hz', exampleScale: 'Hz × 1' },
    { key: 'outputFrequency', label: 'Output frequency', unit: 'Hz', exampleScale: 'Hz × 1' },
    { key: 'batteryVoltage', label: 'Battery voltage', unit: 'V', exampleScale: 'V × 1' },
    { key: 'temperature', label: 'Temperature', unit: '°C', exampleScale: '°C × 1' },
  ];
  alertForm: AlertSettingsForm = emptyAlertForm();
  influxForm: InfluxDbSettingsForm = emptyInfluxForm();
  energyForm: EnergyImpactSettings = emptyEnergySettings();
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
    if (!this.alertSettings() && !this.alertLoading()) void this.loadAlertSettings();
    if (!this.influxLoading()) void this.loadInfluxSettings();
    if (!this.energyLoading()) void this.loadEnergySettings();
  }

  closeSettings(): void {
    this.settingsDialog()?.nativeElement.close();
  }

  async loadAlertSettings(): Promise<void> {
    this.alertLoading.set(true);
    this.alertError.set('');
    try {
      const settings = await this.liveUpdates.getAlertSettings();
      this.alertSettings.set(settings);
      this.alertForm = formFromAlertSettings(settings);
    } catch (error) {
      this.alertError.set(
        error instanceof Error ? error.message : 'Alert settings could not be loaded',
      );
    } finally {
      this.alertLoading.set(false);
    }
  }

  async saveAlertSettings(showNotice = true): Promise<boolean> {
    this.alertSaving.set(true);
    this.alertError.set('');
    this.alertNotice.set('');
    try {
      const settings = await this.liveUpdates.saveAlertSettings(this.alertForm);
      this.alertSettings.set(settings);
      this.alertForm = formFromAlertSettings(settings);
      if (showNotice) this.alertNotice.set('Alert settings saved.');
      return true;
    } catch (error) {
      this.alertError.set(
        error instanceof Error ? error.message : 'Alert settings could not be saved',
      );
      return false;
    } finally {
      this.alertSaving.set(false);
    }
  }

  async loadInfluxSettings(): Promise<void> {
    this.influxLoading.set(true);
    this.influxError.set('');
    try {
      const settings = await this.liveUpdates.getInfluxDbSettings();
      this.influxSettings.set(settings);
      this.influxForm = formFromInfluxSettings(settings);
    } catch (error) {
      this.influxError.set(
        error instanceof Error ? error.message : 'InfluxDB settings could not be loaded',
      );
    } finally {
      this.influxLoading.set(false);
    }
  }

  async saveInfluxSettings(showNotice = true): Promise<boolean> {
    this.influxSaving.set(true);
    this.influxError.set('');
    this.influxNotice.set('');
    try {
      const settings = await this.liveUpdates.saveInfluxDbSettings(this.influxForm);
      this.influxSettings.set(settings);
      this.influxForm = formFromInfluxSettings(settings);
      if (showNotice) this.influxNotice.set('InfluxDB settings saved.');
      return true;
    } catch (error) {
      this.influxError.set(
        error instanceof Error ? error.message : 'InfluxDB settings could not be saved',
      );
      return false;
    } finally {
      this.influxSaving.set(false);
    }
  }

  async testInfluxWrite(): Promise<void> {
    if (!(await this.saveInfluxSettings(false))) return;
    this.influxTesting.set(true);
    this.influxError.set('');
    this.influxNotice.set('');
    try {
      await this.liveUpdates.sendInfluxDbTestWrite();
      this.influxNotice.set('Test point written to InfluxDB.');
      await this.loadInfluxSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The InfluxDB test write failed';
      await this.loadInfluxSettings();
      this.influxError.set(message);
    } finally {
      this.influxTesting.set(false);
    }
  }

  influxStatusLabel(): string {
    const status = this.influxSettings()?.status;
    switch (status) {
      case 'connected':
        return 'Last write succeeded';
      case 'waiting':
        return 'Waiting for first write';
      case 'not-configured':
        return 'Configuration incomplete';
      case 'error':
        return 'Write error';
      default:
        return 'Disabled';
    }
  }

  influxLastWriteLabel(value: string | null): string {
    if (!value) return 'No successful write yet';
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? `Last write ${new Date(timestamp).toLocaleString([], {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}`
      : 'Last write time unavailable';
  }

  async loadEnergySettings(): Promise<void> {
    this.energyLoading.set(true);
    this.energyError.set('');
    try {
      const settings = await this.liveUpdates.getEnergyImpactSettings();
      this.energySettings.set(settings);
      this.energyForm = { ...settings };
    } catch (error) {
      this.energyError.set(
        error instanceof Error ? error.message : 'Energy settings could not be loaded',
      );
    } finally {
      this.energyLoading.set(false);
    }
  }

  async saveEnergySettings(): Promise<void> {
    this.energySaving.set(true);
    this.energyError.set('');
    this.energyNotice.set('');
    try {
      const settings = await this.liveUpdates.saveEnergyImpactSettings(this.energyForm);
      this.energySettings.set(settings);
      this.energyForm = { ...settings };
      this.energyNotice.set('Energy settings saved.');
    } catch (error) {
      this.energyError.set(
        error instanceof Error ? error.message : 'Energy settings could not be saved',
      );
    } finally {
      this.energySaving.set(false);
    }
  }

  async testAlert(channel: 'pushover' | 'email'): Promise<void> {
    if (!(await this.saveAlertSettings(false))) return;
    this.alertTesting.set(channel);
    this.alertError.set('');
    this.alertNotice.set('');
    try {
      await this.liveUpdates.sendAlertTest(channel);
      this.alertNotice.set(`Test ${channel === 'email' ? 'email' : 'Pushover message'} sent.`);
    } catch (error) {
      this.alertError.set(
        error instanceof Error ? error.message : 'The test alert could not be delivered',
      );
    } finally {
      this.alertTesting.set(null);
    }
  }

  editHost(hostId: string): void {
    const host = this.state.hosts().find((item) => item.id === hostId);
    if (!host) return;
    this.hostError.set('');
    this.editingHostId.set(host.id);
    if (host.sourceType === 'nut') {
      this.hostFormType.set('nut');
      this.hostForm = {
        name: host.name,
        host: typeof host.endpointConfig['host'] === 'string' ? host.endpointConfig['host'] : '',
        port: typeof host.endpointConfig['port'] === 'number' ? host.endpointConfig['port'] : 3493,
        tls: host.endpointConfig['tls'] === true,
        username: '',
        password: '',
        clearCredentials: false,
      };
    } else if (host.sourceType === 'homeassistant') {
      this.hostFormType.set('homeassistant');
      this.homeAssistantForm = homeAssistantFormFromHost(host);
    } else {
      this.editingHostId.set(null);
    }
  }

  selectHostFormType(type: 'nut' | 'homeassistant'): void {
    if (this.editingHostId()) return;
    this.hostFormType.set(type);
    this.hostError.set('');
  }

  cancelHostEdit(): void {
    this.editingHostId.set(null);
    this.hostForm = emptyHostForm();
    this.homeAssistantForm = emptyHomeAssistantForm();
    this.hostError.set('');
  }

  async saveHost(): Promise<void> {
    this.hostSaving.set(true);
    this.hostError.set('');
    try {
      const editingId = this.editingHostId();
      if (this.hostFormType() === 'homeassistant') {
        if (editingId) {
          await this.liveUpdates.updateHomeAssistantHost(editingId, this.homeAssistantForm);
        } else {
          await this.liveUpdates.createHomeAssistantHost(this.homeAssistantForm);
        }
      } else if (editingId) {
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

  async addDemoUps(): Promise<void> {
    this.demoUpsSaving.set(true);
    this.demoUpsError.set('');
    try {
      await this.liveUpdates.addDemoUps();
    } catch (error) {
      this.demoUpsError.set(error instanceof Error ? error.message : 'Demo UPS could not be added');
    } finally {
      this.demoUpsSaving.set(false);
    }
  }

  requestHostDeletion(hostId: string): void {
    const host = this.state.hosts().find((item) => item.id === hostId);
    if (!host) return;
    this.deleteError.set('');
    this.deleteTarget.set({
      id: host.id,
      name: host.name,
      scope: this.isDemoFleetHost(host) ? 'ups' : 'source',
      deviceCount: this.state.devices().filter((device) => device.hostId === host.id).length,
    });
  }

  cancelHostDeletion(): void {
    if (this.deleteBusy()) return;
    this.deleteTarget.set(null);
    this.deleteError.set('');
  }

  async confirmHostDeletion(): Promise<void> {
    const target = this.deleteTarget();
    if (!target || this.deleteBusy()) return;
    this.deleteBusy.set(true);
    this.deleteError.set('');
    try {
      await this.liveUpdates.removeHost(target.id);
      this.deleteTarget.set(null);
      if (this.editingHostId() === target.id) this.cancelHostEdit();
    } catch (error) {
      this.deleteError.set(error instanceof Error ? error.message : 'Host could not be deleted');
    } finally {
      this.deleteBusy.set(false);
    }
  }

  isDemoFleetHost(host: BackendHost | undefined): boolean {
    return host?.sourceType === 'demo' && typeof host.endpointConfig['demoUpsId'] === 'string';
  }

  hostAddress(hostId: string): string {
    const host = this.state.hosts().find((item) => item.id === hostId);
    if (!host) return '';
    if (host.sourceType === 'homeassistant') {
      const url = host.endpointConfig['url'];
      return typeof url === 'string' ? url : '';
    }
    if (host.sourceType !== 'nut') {
      return this.isDemoFleetHost(host) ? 'Simulated for UI checks' : 'Built-in simulator';
    }
    const address = host.endpointConfig['host'];
    const port = host.endpointConfig['port'];
    return typeof address === 'string'
      ? `${address}:${typeof port === 'number' ? port : 3493}`
      : '';
  }

  sourceName(host: BackendHost): string {
    if (host.sourceType === 'homeassistant') return 'Home Assistant';
    if (host.sourceType === 'nut') return 'NUT';
    if (this.isDemoFleetHost(host)) return 'Demo UPS';
    return 'Demo simulator';
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

function emptyHomeAssistantForm(): HomeAssistantHostForm {
  const metrics = Object.fromEntries(
    HOME_ASSISTANT_NUMERIC_FIELDS.map((key) => [key, { entityId: '', scale: 1 }]),
  ) as HomeAssistantHostForm['entities']['metrics'];
  return {
    name: '',
    url: '',
    accessToken: '',
    entities: {
      statusEntityId: '',
      onBatteryEntityId: '',
      chargingEntityId: '',
      lowBatteryEntityId: '',
      metrics,
    },
  };
}

function homeAssistantFormFromHost(host: BackendHost): HomeAssistantHostForm {
  const endpointEntities = isRecord(host.endpointConfig['entities'])
    ? host.endpointConfig['entities']
    : {};
  const rawMetrics = isRecord(endpointEntities['metrics']) ? endpointEntities['metrics'] : {};
  const metrics = Object.fromEntries(
    HOME_ASSISTANT_NUMERIC_FIELDS.map((key) => {
      const mapping = isRecord(rawMetrics[key]) ? rawMetrics[key] : {};
      return [
        key,
        {
          entityId: typeof mapping['entityId'] === 'string' ? mapping['entityId'] : '',
          scale: typeof mapping['scale'] === 'number' ? mapping['scale'] : 1,
        },
      ];
    }),
  ) as HomeAssistantHostForm['entities']['metrics'];
  return {
    name: host.name,
    url: typeof host.endpointConfig['url'] === 'string' ? host.endpointConfig['url'] : '',
    accessToken: '',
    entities: {
      statusEntityId:
        typeof endpointEntities['statusEntityId'] === 'string'
          ? endpointEntities['statusEntityId']
          : '',
      onBatteryEntityId:
        typeof endpointEntities['onBatteryEntityId'] === 'string'
          ? endpointEntities['onBatteryEntityId']
          : '',
      chargingEntityId:
        typeof endpointEntities['chargingEntityId'] === 'string'
          ? endpointEntities['chargingEntityId']
          : '',
      lowBatteryEntityId:
        typeof endpointEntities['lowBatteryEntityId'] === 'string'
          ? endpointEntities['lowBatteryEntityId']
          : '',
      metrics,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyAlertForm(): AlertSettingsForm {
  return {
    rules: {
      onBattery: true,
      powerRestored: true,
      lowBattery: true,
      lowBatteryRestored: true,
      lowRuntime: false,
      runtimeThresholdMinutes: 10,
      connectionLost: true,
      connectionRestored: true,
    },
    pushover: { enabled: false, apiToken: '', userKey: '', clearCredentials: false },
    email: {
      enabled: false,
      host: '',
      port: 587,
      secure: false,
      username: '',
      password: '',
      from: '',
      to: '',
      clearCredentials: false,
    },
  };
}

function emptyInfluxForm(): InfluxDbSettingsForm {
  return {
    enabled: false,
    url: '',
    org: '',
    bucket: '',
    measurement: 'volt_ups',
    token: '',
    clearToken: false,
  };
}

function emptyEnergySettings(): EnergyImpactSettings {
  return { pricePerKwh: null, currency: 'EUR', carbonIntensityGramsPerKwh: null };
}

function formFromAlertSettings(settings: AlertSettings): AlertSettingsForm {
  return {
    rules: { ...settings.rules },
    pushover: {
      enabled: settings.pushover.enabled,
      apiToken: '',
      userKey: '',
      clearCredentials: false,
    },
    email: {
      enabled: settings.email.enabled,
      host: settings.email.host,
      port: settings.email.port,
      secure: settings.email.secure,
      username: '',
      password: '',
      from: settings.email.from,
      to: settings.email.to,
      clearCredentials: false,
    },
  };
}

function formFromInfluxSettings(settings: InfluxDbSettings): InfluxDbSettingsForm {
  return {
    enabled: settings.enabled,
    url: settings.url,
    org: settings.org,
    bucket: settings.bucket,
    measurement: settings.measurement,
    token: '',
    clearToken: false,
  };
}
