'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OutdoorSensorAccessory } = require('../dist/outdoorSensorAccessory');
const { Characteristic, Service, HapStatusError, HAPStatus, isCommFailure, makeAccessory, makeLog } = require('./helpers');

const clone = o => JSON.parse(JSON.stringify(o));
const xl824 = () => clone(require('./fixtures/xl824-cool.json'));

function build(thermostat) {
  const { logs, log } = makeLog();
  const platform = { Service, Characteristic, log, api: { hap: { HapStatusError, HAPStatus } } };
  const accessory = makeAccessory('Outdoor Temperature');
  const acc = new OutdoorSensorAccessory(platform, accessory, thermostat ?? xl824());
  const ch = accessory.services.get(Service.TemperatureSensor).char(Characteristic.CurrentTemperature);
  return { acc, ch, accessory };
}

test('outdoor: reads the temperature in the thermostat scale, and allows sub-zero readings', () => {
  const h = build(); // 51 F
  assert.equal(h.ch.getter(), 10.6);
  assert.equal(h.ch.props.minValue, -50);
  assert.equal(h.ch.warned, false);
});

test('S5: no reading and none ever seen is "No Response", not 20 C', () => {
  for (const raw of ['--', null, '', undefined]) {
    const t = xl824();
    t.outdoor_temperature = raw;
    assert.throws(() => build(t).ch.getter(), isCommFailure, String(raw));
  }
});

test('S5: after a restart-like gap the last known reading is kept', () => {
  const h = build();
  assert.equal(h.ch.getter(), 10.6);
  const t2 = xl824();
  t2.outdoor_temperature = '--';
  h.acc.update(t2);
  assert.equal(h.ch.getter(), 10.6);
});

test('scale: a Celsius thermostat is not converted, with the scale found at thermostat level', () => {
  const t = xl824();
  t.features.push({ name: 'thermostat', scale: 'c' });
  t.outdoor_temperature = '-12';
  assert.equal(build(t).ch.getter(), -12);
});
