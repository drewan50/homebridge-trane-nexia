import type { PlatformAccessory, Service } from 'homebridge';
import type { Thermostat } from './nexia/types';
import { finiteOrNull, resolveScale } from './nexia/zoneState';
import type { TraneNexiaPlatform } from './platform';

const fToC = (f: number): number => Math.round(((f - 32) * (5 / 9)) * 10) / 10;

export class OutdoorSensorAccessory {
  private service: Service;
  private thermostat: Thermostat;
  private lastKnownC: number | undefined;

  constructor(
    private readonly platform: TraneNexiaPlatform,
    private readonly accessory: PlatformAccessory,
    thermostat: Thermostat,
  ) {
    this.thermostat = thermostat;
    const { Service, Characteristic } = this.platform;

    const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Trane')
      .setCharacteristic(Characteristic.Model, 'Outdoor Temperature')
      .setCharacteristic(Characteristic.SerialNumber, `outdoor-${thermostat.id}`);

    this.service = accessory.getService(Service.TemperatureSensor) || accessory.addService(Service.TemperatureSensor);
    this.service.setCharacteristic(Characteristic.Name, 'Outdoor Temperature');

    // Outdoor readings regularly go below HAP's default 0°C floor in winter. Move HAP's default value
    // inside the new range first, so setProps doesn't warn about it.
    const temperature = this.service.getCharacteristic(Characteristic.CurrentTemperature);
    if (typeof temperature.value === 'number') temperature.value = Math.min(60, Math.max(-50, temperature.value));
    temperature
      .setProps({ minValue: -50, maxValue: 60, minStep: 0.1 })
      .onGet(() => this.currentTempC());

    this.lastKnownC = this.parseTempC() ?? undefined;
  }

  update(thermostat: Thermostat): void {
    this.thermostat = thermostat;
    const c = this.parseTempC();
    if (c === null) return;
    this.lastKnownC = c;
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, c);
  }

  private parseTempC(): number | null {
    const n = finiteOrNull(this.thermostat.outdoor_temperature); // Nexia sends "--" when it has no reading
    if (n === null) return null;
    // The scale is a thermostat-level fact; read it from the same places the thermostat accessory does.
    return (resolveScale(this.thermostat) ?? 'f') === 'f' ? fToC(n) : Math.round(n * 10) / 10;
  }

  private currentTempC(): number {
    const c = this.parseTempC() ?? this.lastKnownC;
    if (c === undefined) {
      // No reading and none ever seen: "No Response", not a made-up 20 °C.
      const { HapStatusError, HAPStatus } = this.platform.api.hap;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.lastKnownC = c;
    return c;
  }
}
