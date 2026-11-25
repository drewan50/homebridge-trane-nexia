export type Brand = 'trane' | 'nexia' | 'asair';

export type ZoneMode = 'OFF' | 'HEAT' | 'COOL' | 'AUTO';

export interface FeatureAction {
  href: string;
  method?: string;
}

export interface Feature {
  name: string;
  scale?: 'f' | 'c';
  actions?: Record<string, FeatureAction>;
  // Common fields under the "thermostat" feature:
  device_identifier?: string;
  system_status?: string;
  setpoint_delta?: number;
  setpoint_increment?: number;
  setpoint_heat_min?: number;
  setpoint_heat_max?: number;
  setpoint_cool_min?: number;
  setpoint_cool_max?: number;
  // advanced_info uses items[]:
  items?: Array<{ type?: string; label?: string; value?: unknown }>;
  // misc
  [key: string]: unknown;
}

// One entry of a `settings[]` array (zone- or thermostat-level), looked up by `type`.
export interface Setting {
  type?: string;
  current_value?: unknown;
  [key: string]: unknown;
}

export interface Zone {
  id: number;
  type: string;
  name?: string;
  // Present on the XL824/XL850 payloads seen so far. Other models (e.g. UX360) may omit it or
  // carry the mode in `settings[]` / the `thermostat_mode` feature instead: see zoneState.ts.
  // Kept as a plain string because a payload can hold a value we do not recognize.
  current_zone_mode?: string;
  zone_status?: string;
  operating_state?: string;
  settings?: Setting[];
  // The reference implementation reads setpoints from here for every model; the XL824/XL850 also
  // mirror them in the top-level heating_setpoint / cooling_setpoint below (null when not applicable).
  setpoints?: { heat?: unknown; cool?: unknown } | null;
  temperature: number;
  heating_setpoint: number | null;
  cooling_setpoint: number | null;
  features: Feature[];
  [key: string]: unknown;
}

export interface Thermostat {
  id: number;
  name?: string;
  manufacturer?: string;
  type?: string;
  connected?: boolean;
  has_indoor_humidity?: boolean;
  indoor_humidity?: string | number;
  has_outdoor_temperature?: boolean;
  outdoor_temperature?: string | number;
  system_status?: string;
  delta?: number;
  settings?: Setting[];
  features: Feature[];
  zones: Zone[];
  [key: string]: unknown;
}

export interface House {
  id: number;
  items: Thermostat[];
}

export interface SessionResponse {
  result: {
    _links: {
      child: Array<{ data: { id: number } }>;
    };
  };
}

export interface HouseResponse {
  result: {
    _links: {
      child: Array<{ data: { items: Thermostat[] } }>;
    };
  };
}

export interface ActivateResponse {
  result: {
    mobile_id: string;
    api_key: string;
  };
}
