import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { NexiaClient } from './nexia/client';
import type { Feature, Thermostat, Zone, ZoneMode } from './nexia/types';
import { planSetpoints, type SetpointPlan } from './nexia/setpoints';
import {
  describeZone,
  finiteOrNull,
  modeCandidates,
  resolveActivity,
  resolveScale,
  resolveSetpoints,
  resolveZoneMode,
} from './nexia/zoneState';
import type { TraneNexiaPlatform } from './platform';

const fToC = (f: number): number => Math.round(((f - 32) * (5 / 9)) * 10) / 10;
const cToF = (c: number): number => Math.round(c * (9 / 5) + 32);

export class ThermostatAccessory {
  private service: Service;
  private humidityCharRegistered = false;
  private thermostat: Thermostat;
  private zone: Zone;
  // The last good reading of each value. When a poll carries nothing usable for one of them, the Home app
  // keeps showing what we last knew (or "No Response" if we never knew): never a made-up "Off", 20 °C or 0 %.
  private lastMode: ZoneMode | undefined;
  private lastTargetC: number | undefined;
  private lastCurrentC: number | undefined;
  private lastHumidity: number | undefined;
  private warnedModeKey: string | undefined; // undefined until the first warning, so an empty payload still warns
  private warnedScale = false;
  private lastSummary = '';
  // When our last write finished. A poll that started before then is stale and must not undo the write.
  private lastWriteAt = 0;

  constructor(
    private readonly platform: TraneNexiaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly nexia: NexiaClient,
    thermostat: Thermostat,
    zone: Zone,
  ) {
    this.thermostat = thermostat;
    this.zone = zone;
    const { Service, Characteristic } = this.platform;

    const advanced = this.advancedInfo();
    const model = advanced.Model ?? thermostat.type ?? 'Nexia Thermostat';
    const firmware = advanced['Firmware Version'] ?? '0';
    const serial = advanced.AUID ?? `${thermostat.id}-${zone.id}`;

    const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, String(thermostat.manufacturer ?? 'Trane'))
      .setCharacteristic(Characteristic.Model, String(model))
      .setCharacteristic(Characteristic.SerialNumber, String(serial))
      .setCharacteristic(Characteristic.FirmwareRevision, String(firmware));

    this.service = accessory.getService(Service.Thermostat) || accessory.addService(Service.Thermostat);
    this.service.setCharacteristic(Characteristic.Name, this.displayName());

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.computeCurrentState());

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.targetState())
      .onSet((v) => this.setTargetState(v));

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.currentTempC());

    const { minC, maxC, stepC } = this.targetTempProps();
    const target = this.service.getCharacteristic(Characteristic.TargetTemperature);
    // HAP starts this characteristic at 10 °C. Keep that default inside the new range first, so setProps
    // doesn't warn about it; onGet answers "No Response" until a real setpoint is known.
    const start = typeof target.value === 'number' ? target.value : minC;
    target.value = Math.min(maxC, Math.max(minC, start));
    target
      .setProps({ minValue: minC, maxValue: maxC, minStep: stepC })
      .onGet(() => this.targetTempC())
      .onSet((v) => this.setTargetTemp(v));

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.displayUnits())
      .onSet(() => { /* HomeKit-only display preference; Nexia controls the thermostat's display */ });

    if (this.hasHumidity()) {
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).onGet(() => this.humidity());
      this.humidityCharRegistered = true;
    }

    this.currentMode();
    this.logSummary();
  }

  /** Apply a fresh poll. `polledAt` is when that poll started; one that began before our last write
   *  finished is skipped, since it carries the value from before the write. */
  update(thermostat: Thermostat, zone: Zone, polledAt?: number): void {
    if (polledAt !== undefined && polledAt < this.lastWriteAt) {
      this.platform.log.debug(`[${this.displayName()}] ignoring a poll that started before the last change was applied`);
      return;
    }
    this.thermostat = thermostat;
    this.zone = zone;
    const { Characteristic } = this.platform;
    const s = this.service;
    s.updateCharacteristic(Characteristic.Name, this.displayName());
    s.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.computeCurrentState());
    // Only push values we know. With none, leave the last value in place rather than invent one.
    const mode = this.currentMode();
    if (mode) s.updateCharacteristic(Characteristic.TargetHeatingCoolingState, this.hapTargetState(mode));
    this.logSummary();
    const currentC = this.currentTempOrUndefined();
    if (currentC !== undefined) s.updateCharacteristic(Characteristic.CurrentTemperature, currentC);
    const targetC = this.targetTempOrUndefined();
    if (targetC !== undefined) s.updateCharacteristic(Characteristic.TargetTemperature, targetC);
    s.updateCharacteristic(Characteristic.TemperatureDisplayUnits, this.displayUnits());
    if (this.hasHumidity()) {
      if (!this.humidityCharRegistered) {
        this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).onGet(() => this.humidity());
        this.humidityCharRegistered = true;
      }
      const h = this.currentHumidity();
      if (h !== null) {
        this.lastHumidity = h;
        s.updateCharacteristic(Characteristic.CurrentRelativeHumidity, h);
      }
    }
  }

  private displayName(): string {
    const t = this.thermostat.name?.trim();
    const z = this.zone.name?.trim();
    const generic = !z || z.toLowerCase() === 'nativezone' || z === t;
    if (t && generic) return t;
    if (t && z) return `${t} ${z}`;
    return z || t || `Thermostat ${this.thermostat.id}-${this.zone.id}`;
  }

  private advancedInfo(): Record<string, string> {
    const out: Record<string, string> = {};
    const adv = this.thermostat.features?.find(f => f.name === 'advanced_info');
    for (const item of adv?.items ?? []) {
      if (item.label && item.value !== undefined && item.value !== null) {
        out[item.label] = String(item.value);
      }
    }
    return out;
  }

  private thermostatFeature(): Feature | undefined {
    return this.zone.features?.find(f => f.name === 'thermostat');
  }

  private nativeScale(): 'f' | 'c' {
    const scale = resolveScale(this.thermostat, this.zone);
    if (scale) return scale;
    if (!this.warnedScale) {
      this.warnedScale = true;
      this.platform.log.warn(`[${this.displayName()}] Nexia did not say whether this thermostat uses °F or °C; assuming °F. If the temperatures look wrong, please report it with the "[debug]" line.`);
    }
    return 'f';
  }

  private toCelsius(raw: number): number {
    return this.nativeScale() === 'f' ? fToC(raw) : Math.round(raw * 10) / 10;
  }

  private fromCelsius(c: number): number {
    return this.nativeScale() === 'f' ? cToF(c) : Math.round(c * 10) / 10;
  }

  /** The room temperature in °C, or undefined when the thermostat gave none and we never had one. */
  private currentTempOrUndefined(): number | undefined {
    const raw = finiteOrNull(this.zone.temperature);
    if (raw === null) return this.lastCurrentC;
    this.lastCurrentC = this.toCelsius(raw);
    return this.lastCurrentC;
  }

  private currentTempC(): number {
    const c = this.currentTempOrUndefined();
    if (c === undefined) throw this.commFailure();
    return c;
  }

  /** The zone's mode as far as we can tell: the freshly resolved one, else the last one we knew.
   *  Warns once per distinct unreadable payload so the log says what to report. */
  private currentMode(): ZoneMode | undefined {
    const mode = resolveZoneMode(this.thermostat, this.zone);
    if (mode) {
      this.lastMode = mode;
      this.warnedModeKey = undefined; // readable again: a later unreadable payload deserves a fresh warning
      return mode;
    }
    const seen = modeCandidates(this.thermostat, this.zone)
      .filter(c => c.raw !== undefined)
      .map(c => `${c.source}=${JSON.stringify(c.raw)}`)
      .join(', ');
    if (seen !== this.warnedModeKey) {
      this.warnedModeKey = seen;
      this.platform.log.warn(
        `[${this.displayName()}] Could not read the thermostat mode (${seen || 'no mode field in the Nexia response'}). ` +
        `${this.lastMode ? `Keeping the last known mode (${this.lastMode}).` : 'The Home app will show "No Response" for this thermostat until a mode is readable.'} ` +
        'Please report this: set "debug": true in the plugin settings and paste the "[debug]" line from the Homebridge log into a GitHub issue.',
      );
    }
    return this.lastMode;
  }

  /** `debug: true` only: one line per zone, logged when it changes. Info level on purpose:
   *  Homebridge drops log.debug unless it runs in debug mode itself. */
  private logSummary(): void {
    if (!this.platform.debugEnabled) return;
    const line = describeZone(this.thermostat, this.zone);
    if (line === this.lastSummary) return;
    this.lastSummary = line;
    this.platform.log.info(`[debug] [${this.displayName()}] ${line}`);
  }

  private commFailure(): Error {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private hapTargetState(mode: ZoneMode): CharacteristicValue {
    const { Characteristic } = this.platform;
    switch (mode) {
      case 'HEAT': return Characteristic.TargetHeatingCoolingState.HEAT;
      case 'COOL': return Characteristic.TargetHeatingCoolingState.COOL;
      case 'AUTO': return Characteristic.TargetHeatingCoolingState.AUTO;
      case 'OFF': return Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private targetState(): CharacteristicValue {
    const mode = this.currentMode();
    if (!mode) throw this.commFailure(); // "No Response" beats a wrong "Off"
    return this.hapTargetState(mode);
  }

  private computeCurrentState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    switch (resolveActivity(this.thermostat, this.zone)) {
      case 'heating': return Characteristic.CurrentHeatingCoolingState.HEAT;
      case 'cooling': return Characteristic.CurrentHeatingCoolingState.COOL;
      case 'idle': return Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  /** The temperature the Home app should show as the target, in °C, or undefined when the thermostat
   *  gave us no usable setpoint and we never had one (never a made-up number). */
  private targetTempOrUndefined(): number | undefined {
    const { heat, cool } = resolveSetpoints(this.zone);
    let raw: number | null;
    switch (this.currentMode()) {
      case 'HEAT': raw = heat ?? cool; break;
      case 'COOL': raw = cool ?? heat; break;
      case 'AUTO': raw = heat !== null && cool !== null ? (heat + cool) / 2 : (cool ?? heat); break;
      default: raw = cool ?? heat;
    }
    if (raw === null) return this.lastTargetC;
    this.lastTargetC = this.toCelsius(raw);
    return this.lastTargetC;
  }

  private targetTempC(): number {
    const c = this.targetTempOrUndefined();
    if (c === undefined) throw this.commFailure(); // "No Response" beats a wrong 20 °C
    return c;
  }

  private targetTempProps(): { minC: number; maxC: number; stepC: number } {
    const f = this.thermostatFeature();
    const fmin = finiteOrNull(f?.setpoint_heat_min ?? f?.setpoint_cool_min);
    const fmax = finiteOrNull(f?.setpoint_cool_max ?? f?.setpoint_heat_max);
    const increment = finiteOrNull(f?.setpoint_increment);
    if (this.nativeScale() === 'f') {
      const minC = fmin !== null ? fToC(fmin) : 10;
      const maxC = fmax !== null ? fToC(fmax) : 38;
      // HAP default granularity. The Home app's °F picker steps 1°F on its own;
      // any coarser °C step misaligns with the integer-°F grid (e.g. 0.6°C reads
      // as unrepresentable and falls back to 1°C ≈ 2°F jumps).
      return { minC, maxC, stepC: 0.1 };
    }
    return {
      minC: fmin ?? 10,
      maxC: fmax ?? 38,
      stepC: increment ?? 0.5,
    };
  }

  private displayUnits(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.nativeScale() === 'c'
      ? Characteristic.TemperatureDisplayUnits.CELSIUS
      : Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }

  private hasHumidity(): boolean {
    return this.thermostat.has_indoor_humidity === true || this.currentHumidity() !== null;
  }

  private currentHumidity(): number | null {
    const n = finiteOrNull(this.thermostat.indoor_humidity); // Nexia sends "--" when it has no reading
    return n === null ? null : Math.min(100, Math.max(0, Math.round(n)));
  }

  private humidity(): number {
    const h = this.currentHumidity() ?? this.lastHumidity;
    if (h === undefined) throw this.commFailure(); // not 0 %
    this.lastHumidity = h;
    return h;
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    let mode: ZoneMode = 'OFF';
    if (value === Characteristic.TargetHeatingCoolingState.HEAT) mode = 'HEAT';
    else if (value === Characteristic.TargetHeatingCoolingState.COOL) mode = 'COOL';
    else if (value === Characteristic.TargetHeatingCoolingState.AUTO) mode = 'AUTO';
    this.platform.log.info(`[${this.displayName()}] set mode -> ${mode}`);
    try {
      await this.nexia.setZoneMode(this.zone, mode, this.thermostat.id);
      this.zone.current_zone_mode = mode;
      this.lastMode = mode;
      this.lastWriteAt = this.platform.now();
    } catch (e) {
      this.platform.log.error(`[${this.displayName()}] failed to set mode -> ${mode}:`, (e as Error).message);
      throw this.commFailure();
    }
    // The setpoint the Home app should show depends on the mode (heat in HEAT, cool in COOL): don't wait for the next poll.
    const shown = this.targetTempOrUndefined();
    if (shown !== undefined) this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, shown);
  }

  private async setTargetTemp(value: CharacteristicValue): Promise<void> {
    const mode = this.currentMode();
    if (mode === 'OFF') {
      this.platform.log.info(`[${this.displayName()}] ignoring a temperature change: the thermostat is Off`);
      return;
    }
    if (!mode) {
      // Don't guess which setpoint to move: say it failed rather than silently doing nothing.
      this.platform.log.error(`[${this.displayName()}] cannot change the temperature: the thermostat mode is unknown (see the earlier warning).`);
      throw this.commFailure();
    }
    const { heat, cool } = resolveSetpoints(this.zone);
    if (heat === null && cool === null) {
      // We can't read any setpoint, so we don't know this zone's data model: writing would be a guess.
      this.platform.log.error(`[${this.displayName()}] cannot change the temperature: the thermostat reported no readable setpoints (see the [debug] line).`);
      throw this.commFailure();
    }
    const native = this.fromCelsius(Number(value));
    const f = this.thermostatFeature();
    let payload: SetpointPlan;
    try {
      if (!Number.isFinite(native)) throw new RangeError(`the requested temperature ${String(value)} is not a number`);
      payload = planSetpoints({
        mode,
        target: native,
        heat,
        cool,
        deadband: finiteOrNull(f?.setpoint_delta) ?? finiteOrNull(this.thermostat.delta) ?? 2,
        min: finiteOrNull(f?.setpoint_heat_min),
        max: finiteOrNull(f?.setpoint_cool_max),
      });
    } catch (e) {
      this.platform.log.error(`[${this.displayName()}] refusing to send a temperature change: ${(e as Error).message}`);
      throw this.commFailure();
    }
    if (payload.heat === undefined && payload.cool === undefined) {
      this.platform.log.info(`[${this.displayName()}] already set to that temperature; nothing to send`);
      return;
    }
    this.platform.log.info(`[${this.displayName()}] set setpoints ${JSON.stringify(payload)} (native ${this.nativeScale()})`);
    try {
      await this.nexia.setSetpoints(this.zone, payload, this.thermostat.id);
    } catch (e) {
      this.platform.log.error(`[${this.displayName()}] failed to set setpoints ${JSON.stringify(payload)}:`, (e as Error).message);
      throw this.commFailure();
    }
    if (payload.heat !== undefined) this.zone.heating_setpoint = payload.heat;
    if (payload.cool !== undefined) this.zone.cooling_setpoint = payload.cool;
    this.lastWriteAt = this.platform.now();
    const shown = this.targetTempOrUndefined();
    if (shown !== undefined) this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, shown);
  }
}
