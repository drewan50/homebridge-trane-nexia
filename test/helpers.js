'use strict';
// Minimal stand-ins for Homebridge's Service/Characteristic/PlatformAccessory API, so the compiled
// plugin can be exercised without importing homebridge (2.x is ESM-only; tests run on every Node major).

const mk = (name, statics = {}) => Object.assign(function () {}, { displayName: name }, statics);

const Characteristic = {
  Manufacturer: mk('Manufacturer'), Model: mk('Model'), SerialNumber: mk('SerialNumber'),
  FirmwareRevision: mk('FirmwareRevision'), Name: mk('Name'),
  CurrentHeatingCoolingState: mk('CurrentHeatingCoolingState', { OFF: 0, HEAT: 1, COOL: 2 }),
  TargetHeatingCoolingState: mk('TargetHeatingCoolingState', { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 }),
  CurrentTemperature: mk('CurrentTemperature'), TargetTemperature: mk('TargetTemperature'),
  TemperatureDisplayUnits: mk('TemperatureDisplayUnits', { CELSIUS: 0, FAHRENHEIT: 1 }),
  CurrentRelativeHumidity: mk('CurrentRelativeHumidity'),
};
const Service = {
  AccessoryInformation: mk('AccessoryInformation'), Thermostat: mk('Thermostat'), TemperatureSensor: mk('TemperatureSensor'),
};

class HapStatusError extends Error {
  constructor(status) { super(`HAP status ${status}`); this.hapStatus = status; }
}
const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 };
const isCommFailure = e => e instanceof HapStatusError && e.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE;

// HAP starts these at fixed defaults regardless of the thermostat; setProps warns when the current value is outside the new range.
const HAP_DEFAULTS = new Map([[Characteristic.TargetTemperature, 10], [Characteristic.CurrentTemperature, 0]]);

class FakeService {
  constructor() { this.chars = new Map(); this.updates = []; }
  char(c) {
    if (!this.chars.has(c)) {
      const ch = { value: HAP_DEFAULTS.get(c), warned: false };
      ch.onGet = fn => { ch.getter = fn; return ch; };
      ch.onSet = fn => { ch.setter = fn; return ch; };
      ch.setProps = p => {
        ch.props = p;
        if (typeof ch.value === 'number' && ((p.minValue !== undefined && ch.value < p.minValue) || (p.maxValue !== undefined && ch.value > p.maxValue))) ch.warned = true;
        return ch;
      };
      this.chars.set(c, ch);
    }
    return this.chars.get(c);
  }
  setCharacteristic(c, v) { this.char(c).value = v; return this; }
  getCharacteristic(c) { return this.char(c); }
  updateCharacteristic(c, v) { this.char(c).value = v; this.updates.push([c, v]); return this; }
}

function makeAccessory(displayName = 'accessory', UUID = 'uuid') {
  const services = new Map();
  return {
    displayName, UUID, context: {}, services,
    getService: s => services.get(s),
    addService: s => { const svc = new FakeService(); services.set(s, svc); return svc; },
  };
}

function makeLog() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  const log = Object.fromEntries(Object.keys(logs).map(k => [k, (...a) => logs[k].push(a.join(' '))]));
  return { logs, log };
}

module.exports = { Characteristic, Service, HapStatusError, HAPStatus, isCommFailure, FakeService, makeAccessory, makeLog };
