import type { PlatformAccessory, Service } from 'homebridge';
import type { Thermostat } from './nexia/types';
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

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      // Outdoor readings regularly go below HAP's default 0°C floor in winter.
      .setProps({ minValue: -50, maxValue: 60, minStep: 0.1 })
      .onGet(() => this.currentTempC());
  }

  update(thermostat: Thermostat): void {
    this.thermostat = thermostat;
    const c = this.parseTempC();
    if (c === null) return;
    this.lastKnownC = c;
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, c);
  }

  private parseTempC(): number | null {
    const raw = this.thermostat.outdoor_temperature;
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const scale = this.thermostat.features?.find(f => f.name === 'thermostat')?.scale ?? 'f';
    return scale === 'f' ? fToC(n) : Math.round(n * 10) / 10;
  }

  private currentTempC(): number {
    const c = this.parseTempC();
    return c !== null ? c : (this.lastKnownC ?? 20);
  }
}
