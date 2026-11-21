import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { HomeAssistantHostForm, HomeAssistantNumericField } from '../../live-updates';

export interface HomeAssistantMetricDescriptor {
  key: HomeAssistantNumericField;
  label: string;
  unit: string;
  exampleScale: string;
}

@Component({
  selector: 'app-homeassistant-connection-form',
  imports: [FormsModule],
  styleUrl: './homeassistant-connection-form.css',
  templateUrl: './homeassistant-connection-form.html',
})
export class HomeAssistantConnectionForm {
  readonly form = input.required<HomeAssistantHostForm>();
  readonly fields = input.required<HomeAssistantMetricDescriptor[]>();
  readonly saving = input(false);
  readonly editing = input(false);
  readonly credentialsConfigured = input(false);
  readonly error = input('');
  readonly submitted = output<void>();
  readonly cancelled = output<void>();
}
