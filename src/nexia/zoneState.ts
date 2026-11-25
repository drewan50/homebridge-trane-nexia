// Pure functions that turn a Nexia thermostat/zone payload into the two facts HomeKit needs:
// which mode the zone is in, and what it is doing right now. No Homebridge imports, so they can
// be tested directly.
//
// Payload shapes differ by model. The XL824/XL850 carry `current_zone_mode` on the zone; the
// reference implementation (github.com/bdraco/nexia, used by Home Assistant) also reads the zone
// `settings[]`, the `thermostat_mode` feature and thermostat-level settings, and prefers the
// per-zone `zone_status` on zoned systems such as the UX360.
import type { Feature, Setting, Thermostat, Zone, ZoneMode } from './types';

const MODES: readonly ZoneMode[] = ['OFF', 'HEAT', 'COOL', 'AUTO'];

export type Activity = 'heating' | 'cooling' | 'idle';

export interface ModeCandidate {
  source: string;
  raw: unknown;
}

function settingValue(settings: Setting[] | undefined, type: string): unknown {
  return Array.isArray(settings) ? settings.find(s => s?.type === type)?.current_value : undefined;
}

/** Every place a zone's mode can live, in priority order. `current_zone_mode` stays first so the
 *  models it already works for (XL824/XL850) behave exactly as before. After it we follow the reference
 *  implementation: a zone with its own `settings` is "zoned" and carries `zone_mode` there; a zone with
 *  none (the XL's NativeZone has `settings: []`) takes the thermostat's `system_mode`. Then the
 *  `thermostat_mode` feature and the thermostat's `mode`. */
export function modeCandidates(thermostat: Thermostat, zone: Zone): ModeCandidate[] {
  const zoned = Array.isArray(zone.settings) && zone.settings.length > 0;
  return [
    { source: 'zone.current_zone_mode', raw: zone.current_zone_mode },
    { source: 'zone.settings[zone_mode]', raw: settingValue(zone.settings, 'zone_mode') },
    { source: 'thermostat.settings[system_mode]', raw: zoned ? undefined : settingValue(thermostat.settings, 'system_mode') },
    { source: 'zone.features[thermostat_mode]', raw: zone.features?.find(f => f?.name === 'thermostat_mode')?.value },
    { source: 'thermostat.settings[mode]', raw: settingValue(thermostat.settings, 'mode') },
  ];
}

/** Accepts only the four modes HomeKit can show; anything else is "unknown", never OFF. */
export function parseMode(raw: unknown): ZoneMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const upper = raw.trim().toUpperCase();
  return (MODES as readonly string[]).includes(upper) ? (upper as ZoneMode) : undefined;
}

export function resolveZoneMode(thermostat: Thermostat, zone: Zone): ZoneMode | undefined {
  for (const candidate of modeCandidates(thermostat, zone)) {
    const mode = parseMode(candidate.raw);
    if (mode) return mode;
  }
  return undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** A finite number, from a number or a numeric string ("--", "", null and NaN are "no value"). */
export function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The zone's heat and cool setpoints in the thermostat's own scale, or null where there is none
 *  (a zone in HEAT mode legitimately reports a null cool setpoint). Top-level keys first, which is
 *  what the XL824/XL850 have always used; `zone.setpoints` is the fallback the reference reads for
 *  every model. Never returns NaN or undefined, so callers can't turn a missing value into a number. */
export function resolveSetpoints(zone: Pick<Zone, 'heating_setpoint' | 'cooling_setpoint' | 'setpoints'>): { heat: number | null; cool: number | null } {
  return {
    heat: finiteOrNull(zone.heating_setpoint) ?? finiteOrNull(zone.setpoints?.heat),
    cool: finiteOrNull(zone.cooling_setpoint) ?? finiteOrNull(zone.setpoints?.cool),
  };
}

/** The thermostat's temperature scale. Zone feature first (what the plugin has always used), then the
 *  thermostat-level feature, then its `scale` setting (the real XL824/XL850 report "f" in all three).
 *  Undefined when none says, so the caller decides rather than silently assuming Fahrenheit here. */
export function resolveScale(thermostat: Thermostat, zone?: Zone): 'f' | 'c' | undefined {
  const fromFeatures = (features: Feature[] | undefined) => features?.find(f => f?.name === 'thermostat')?.scale;
  const candidates: unknown[] = [
    zone ? fromFeatures(zone.features) : undefined,
    fromFeatures(thermostat.features),
    settingValue(thermostat.settings, 'scale'),
  ];
  for (const c of candidates) {
    const v = text(c);
    if (v === 'f' || v === 'c') return v;
  }
  return undefined;
}

function modelName(thermostat: Thermostat): string | null {
  const advanced = thermostat.features?.find(f => f?.name === 'advanced_info');
  const model = advanced?.items?.find(i => i?.label === 'Model')?.value;
  // `type` is a family ("xxl_thermostat" on the XL824/XL850), so it is only a fallback.
  return typeof model === 'string' && model.trim() ? model.trim() : (thermostat.type ?? null);
}

function classify(status: string): Activity | undefined {
  if (status.includes('heat')) return 'heating';
  if (status.includes('cool')) return 'cooling';
  if (status.includes('idle')) return 'idle';
  return undefined;
}

/** What the zone is doing now. Order: per-zone `zone_status` (zoned systems such as the UX360),
 *  the thermostat-wide `system_status`, then an inference from mode and setpoints for firmware
 *  that reports neither. */
export function resolveActivity(thermostat: Thermostat, zone: Zone): Activity {
  // A zone that is switched off is not heating or cooling, whatever a system-wide status still says.
  if (resolveZoneMode(thermostat, zone) === 'OFF') return 'idle';
  // A NativeZone is the thermostat itself, not a damper zone: the reference ignores its zone_status
  // and uses the system status, so we do too. (The real XL824/XL850 report an empty zone_status here.)
  const fromZone = zone.name === 'NativeZone' ? undefined : classify(text(zone.zone_status));
  if (fromZone) return fromZone;

  const feature = zone.features?.find(f => f?.name === 'thermostat');
  const system = text(thermostat.system_status) || text(feature?.system_status);
  if (system) return classify(system) ?? 'idle'; // "Waiting...", "System Off", ... are not active

  const mode = resolveZoneMode(thermostat, zone);
  if (mode === 'HEAT') return 'heating';
  if (mode === 'COOL') return 'cooling';
  if (mode === 'AUTO') {
    const t = finiteOrNull(zone.temperature);
    const { heat, cool } = resolveSetpoints(zone);
    if (t !== null && heat !== null && t < heat) return 'heating';
    if (t !== null && cool !== null && t > cool) return 'cooling';
  }
  return 'idle';
}

/** One log line with the inputs behind the mode and activity, for `debug: true` and bug reports.
 *  Contains no credentials. */
export function describeZone(thermostat: Thermostat, zone: Zone): string {
  const mode = resolveZoneMode(thermostat, zone);
  const seen = modeCandidates(thermostat, zone)
    .filter(c => c.raw !== undefined)
    .map(c => `${c.source}=${JSON.stringify(c.raw)}`);
  const feature = zone.features?.find(f => f?.name === 'thermostat');
  const { heat, cool } = resolveSetpoints(zone);
  return [
    `model=${JSON.stringify(modelName(thermostat))}`,
    `mode=${mode ?? 'UNKNOWN'}`,
    `modeSources=[${seen.join(', ')}]`,
    `zone_status=${JSON.stringify(zone.zone_status ?? null)}`,
    `system_status=${JSON.stringify(thermostat.system_status ?? feature?.system_status ?? null)}`,
    `activity=${resolveActivity(thermostat, zone)}`,
    `temp=${zone.temperature}${(resolveScale(thermostat, zone) ?? '?').toUpperCase()}`,
    `heat=${heat}`,
    `cool=${cool}`,
  ].join(' ');
}
