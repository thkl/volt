export const HOME_ASSISTANT_NUMERIC_FIELDS = [
  'batteryCharge',
  'runtimeSeconds',
  'loadPercent',
  'realPower',
  'inputVoltage',
  'outputVoltage',
  'inputFrequency',
  'outputFrequency',
  'batteryVoltage',
  'temperature',
] as const;

export type HomeAssistantNumericField = (typeof HOME_ASSISTANT_NUMERIC_FIELDS)[number];

export interface HomeAssistantNumericMapping {
  entityId: string;
  scale: number;
}

export interface HomeAssistantEntityMappings {
  statusEntityId: string | null;
  onBatteryEntityId: string | null;
  chargingEntityId: string | null;
  lowBatteryEntityId: string | null;
  metrics: Record<HomeAssistantNumericField, HomeAssistantNumericMapping | null>;
}

export interface HomeAssistantEndpointConfig {
  url: string;
  entities: HomeAssistantEntityMappings;
}

export interface HomeAssistantHostInput extends HomeAssistantEndpointConfig {
  name: string;
  accessToken: string;
}
