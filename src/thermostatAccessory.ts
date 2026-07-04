import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { NexiaClient } from './nexia/client';
import type { Feature, Thermostat, Zone, ZoneMode } from './nexia/types';
import type { TraneNexiaPlatform } from './platform';

const fToC = (f: number): number => Math.round(((f - 32) * (5 / 9)) * 10) / 10;
const cToF = (c: number): number => Math.round(c * (9 / 5) + 32);

export class ThermostatAccessory {
  private service: Service;
  private humidityCharRegistered = false;
  private thermostat: Thermostat;
  private zone: Zone;

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
    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: minC, maxValue: maxC, minStep: stepC })
      .onGet(() => this.targetTempC())
      .onSet((v) => this.setTargetTemp(v));

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.displayUnits())
      .onSet(() => { /* HomeKit-only display preference; Nexia controls the thermostat's display */ });

    if (this.hasHumidity()) {
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.currentHumidity() ?? 0);
      this.humidityCharRegistered = true;
    }
  }

  update(thermostat: Thermostat, zone: Zone): void {
    this.thermostat = thermostat;
    this.zone = zone;
    const { Characteristic } = this.platform;
    const s = this.service;
    s.updateCharacteristic(Characteristic.Name, this.displayName());
    s.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.computeCurrentState());
    s.updateCharacteristic(Characteristic.TargetHeatingCoolingState, this.targetState());
    s.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTempC());
    s.updateCharacteristic(Characteristic.TargetTemperature, this.targetTempC());
    s.updateCharacteristic(Characteristic.TemperatureDisplayUnits, this.displayUnits());
    if (this.hasHumidity()) {
      if (!this.humidityCharRegistered) {
        this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .onGet(() => this.currentHumidity() ?? 0);
        this.humidityCharRegistered = true;
      }
      const h = this.currentHumidity();
      if (h !== null) s.updateCharacteristic(Characteristic.CurrentRelativeHumidity, h);
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
    return this.thermostatFeature()?.scale ?? 'f';
  }

  private toCelsius(raw: number | null | undefined): number {
    if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) return 20;
    const n = Number(raw);
    return this.nativeScale() === 'f' ? fToC(n) : Math.round(n * 10) / 10;
  }

  private fromCelsius(c: number): number {
    return this.nativeScale() === 'f' ? cToF(c) : Math.round(c * 10) / 10;
  }

  private currentTempC(): number {
    return this.toCelsius(this.zone.temperature);
  }

  private targetState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    switch (this.zone.current_zone_mode) {
      case 'OFF': return Characteristic.TargetHeatingCoolingState.OFF;
      case 'HEAT': return Characteristic.TargetHeatingCoolingState.HEAT;
      case 'COOL': return Characteristic.TargetHeatingCoolingState.COOL;
      case 'AUTO': return Characteristic.TargetHeatingCoolingState.AUTO;
      default: return Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private computeCurrentState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    // Prefer explicit system_status from the thermostat ("Heating"/"Cooling"/"System Idle"/"Fan Running"/...).
    const status = String(this.thermostat.system_status ?? this.thermostatFeature()?.system_status ?? '').toLowerCase();
    if (status.includes('heat')) return Characteristic.CurrentHeatingCoolingState.HEAT;
    if (status.includes('cool')) return Characteristic.CurrentHeatingCoolingState.COOL;
    if (status) return Characteristic.CurrentHeatingCoolingState.OFF;
    // Fallback: infer from mode + setpoints (handles older firmware that doesn't report system_status).
    const mode = this.zone.current_zone_mode;
    if (mode === 'HEAT') return Characteristic.CurrentHeatingCoolingState.HEAT;
    if (mode === 'COOL') return Characteristic.CurrentHeatingCoolingState.COOL;
    if (mode === 'AUTO') {
      const t = this.zone.temperature;
      const h = this.zone.heating_setpoint;
      const c = this.zone.cooling_setpoint;
      if (h !== null && t < h) return Characteristic.CurrentHeatingCoolingState.HEAT;
      if (c !== null && t > c) return Characteristic.CurrentHeatingCoolingState.COOL;
    }
    return Characteristic.CurrentHeatingCoolingState.OFF;
  }

  private targetTempC(): number {
    const heat = this.zone.heating_setpoint;
    const cool = this.zone.cooling_setpoint;
    switch (this.zone.current_zone_mode) {
      case 'HEAT': return this.toCelsius(heat ?? cool);
      case 'COOL': return this.toCelsius(cool ?? heat);
      case 'AUTO':
        if (heat !== null && cool !== null) return this.toCelsius((heat + cool) / 2);
        return this.toCelsius(cool ?? heat);
      default: return this.toCelsius(cool ?? heat);
    }
  }

  private targetTempProps(): { minC: number; maxC: number; stepC: number } {
    const f = this.thermostatFeature();
    const fmin = f?.setpoint_heat_min ?? f?.setpoint_cool_min;
    const fmax = f?.setpoint_cool_max ?? f?.setpoint_heat_max;
    const increment = f?.setpoint_increment;
    if (this.nativeScale() === 'f') {
      const minC = fmin !== undefined ? fToC(fmin) : 10;
      const maxC = fmax !== undefined ? fToC(fmax) : 38;
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
    const v = this.thermostat.indoor_humidity;
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.min(100, Math.max(0, Math.round(n)));
    }
    return null;
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    let mode: ZoneMode = 'OFF';
    if (value === Characteristic.TargetHeatingCoolingState.HEAT) mode = 'HEAT';
    else if (value === Characteristic.TargetHeatingCoolingState.COOL) mode = 'COOL';
    else if (value === Characteristic.TargetHeatingCoolingState.AUTO) mode = 'AUTO';
    this.platform.log.info(`[${this.displayName()}] set mode -> ${mode}`);
    await this.nexia.setZoneMode(this.zone, mode);
    this.zone.current_zone_mode = mode;
  }

  private async setTargetTemp(value: CharacteristicValue): Promise<void> {
    if (this.zone.current_zone_mode === 'OFF') {
      this.platform.log.debug(`[${this.displayName()}] ignoring setTargetTemperature in OFF mode`);
      return;
    }
    const targetC = Number(value);
    const native = this.fromCelsius(targetC);
    const f = this.thermostatFeature();
    const delta = f?.setpoint_delta ?? this.thermostat.delta ?? 2;
    const heat = this.zone.heating_setpoint;
    const cool = this.zone.cooling_setpoint;
    const payload: { heat?: number; cool?: number } = {};
    switch (this.zone.current_zone_mode) {
      case 'HEAT':
        payload.heat = native;
        break;
      case 'COOL':
        payload.cool = native;
        break;
      case 'AUTO': {
        const existingSpread = (heat !== null && cool !== null) ? (cool - heat) : delta;
        const spread = Math.max(delta, existingSpread);
        payload.heat = native - Math.round(spread / 2);
        payload.cool = native + Math.round(spread / 2);
        break;
      }
    }
    this.platform.log.info(`[${this.displayName()}] set setpoints ${JSON.stringify(payload)} (native ${this.nativeScale()})`);
    await this.nexia.setSetpoints(this.zone, payload);
    if (payload.heat !== undefined) this.zone.heating_setpoint = payload.heat;
    if (payload.cool !== undefined) this.zone.cooling_setpoint = payload.cool;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.targetTempC());
  }
}
