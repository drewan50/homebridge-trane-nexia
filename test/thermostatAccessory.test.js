'use strict';
// Behavior of ThermostatAccessory against a minimal stand-in for Homebridge's Service/Characteristic
// API (test/helpers.js; no homebridge import, so this runs on every Node major).
const test = require('node:test');
const assert = require('node:assert/strict');
const { ThermostatAccessory } = require('../dist/thermostatAccessory');
const { Characteristic, Service, HapStatusError, HAPStatus, isCommFailure, makeAccessory, makeLog } = require('./helpers');

const clone = o => JSON.parse(JSON.stringify(o));
const xl824 = () => clone(require('./fixtures/xl824-cool.json'));
const ux360 = () => clone(require('./fixtures/ux360-zoned-cool.json'));

function build({ thermostat, zone, debug = false } = {}) {
  const { logs, log } = makeLog();
  const clock = { t: 1_000 };
  const platform = { Service, Characteristic, log, debugEnabled: debug, now: () => clock.t, api: { hap: { HapStatusError, HAPStatus } } };
  const accessory = makeAccessory();
  const calls = [];
  const nexia = {
    setZoneMode: async (z, mode) => { calls.push(['mode', mode]); },
    setSetpoints: async (z, payload) => { calls.push(['setpoints', payload]); },
  };
  const t = thermostat ?? xl824();
  const z = zone ?? t.zones[0];
  const acc = new ThermostatAccessory(platform, accessory, nexia, t, z);
  const svc = accessory.services.get(Service.Thermostat);
  return {
    acc, svc, logs, calls, nexia, t, z, clock,
    target: svc.char(Characteristic.TargetHeatingCoolingState),
    current: svc.char(Characteristic.CurrentHeatingCoolingState),
    temp: svc.char(Characteristic.TargetTemperature),
  };
}

test('issue #1: a UX360-style zone shows its real mode and activity, not Off', () => {
  const t = ux360();
  const living = build({ thermostat: t, zone: t.zones[0] });
  assert.equal(living.target.getter(), Characteristic.TargetHeatingCoolingState.COOL);
  assert.equal(living.current.getter(), Characteristic.CurrentHeatingCoolingState.COOL);
  assert.equal(living.logs.warn.length, 0);

  const bedroom = build({ thermostat: t, zone: t.zones[1] });
  assert.equal(bedroom.target.getter(), Characteristic.TargetHeatingCoolingState.COOL);
  assert.equal(bedroom.current.getter(), Characteristic.CurrentHeatingCoolingState.OFF, 'idle zone');
});

test('XL824 behavior is unchanged', () => {
  const h = build();
  assert.equal(h.target.getter(), Characteristic.TargetHeatingCoolingState.COOL);
  assert.equal(h.current.getter(), Characteristic.CurrentHeatingCoolingState.OFF, 'System Idle');
  assert.equal(h.temp.getter(), 23.9, '75 F cooling setpoint is 23.9 C');
});

test('a poll with an unreadable mode keeps the last known mode and warns once', () => {
  const h = build();
  const t2 = xl824();
  t2.zones[0].current_zone_mode = 'WEIRD';

  h.acc.update(t2, t2.zones[0]);
  assert.equal(h.target.getter(), Characteristic.TargetHeatingCoolingState.COOL, 'last known, not OFF');
  assert.equal(h.logs.warn.length, 1);
  assert.match(h.logs.warn[0], /Could not read the thermostat mode/);
  assert.match(h.logs.warn[0], /"WEIRD"/);
  assert.match(h.logs.warn[0], /Keeping the last known mode \(COOL\)/);
  assert.ok(!h.svc.updates.some(([c, v]) => c === Characteristic.TargetHeatingCoolingState && v === 0), 'never pushed OFF');

  h.acc.update(clone(t2), clone(t2).zones[0]);
  assert.equal(h.logs.warn.length, 1, 'same unreadable payload does not warn again');

  const t3 = xl824();
  t3.zones[0].current_zone_mode = 'HEAT';
  h.acc.update(t3, t3.zones[0]);
  assert.equal(h.target.getter(), Characteristic.TargetHeatingCoolingState.HEAT, 'recovers when readable again');
});

test('with no readable mode ever, reads and writes fail visibly instead of showing Off', async () => {
  const t = xl824();
  delete t.zones[0].current_zone_mode;
  const h = build({ thermostat: t });
  assert.throws(() => h.target.getter(), isCommFailure);
  assert.equal(h.logs.warn.length, 1);
  assert.match(h.logs.warn[0], /"No Response"/);

  await assert.rejects(h.temp.setter(22), isCommFailure);
  assert.equal(h.calls.length, 0, 'no setpoint was sent');
  assert.equal(h.logs.error.length, 1);
});

test('debug: off logs nothing extra; on logs an info-level [debug] line once per change', () => {
  const quiet = build();
  assert.equal(quiet.logs.info.filter(l => l.includes('[debug]')).length, 0);

  const loud = build({ debug: true });
  const lines = () => loud.logs.info.filter(l => l.includes('[debug]'));
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /mode=COOL/);
  assert.equal(loud.logs.debug.length, 0, 'not log.debug: Homebridge would drop it');

  loud.acc.update(clone(loud.t), clone(loud.t).zones[0]);
  assert.equal(lines().length, 1, 'unchanged state is not logged again');

  const t2 = clone(loud.t);
  t2.zones[0].temperature = 71;
  loud.acc.update(t2, t2.zones[0]);
  assert.equal(lines().length, 2);
  assert.doesNotMatch(loud.logs.info.join('\n'), /apiKey|mobileId/i);
});

test('setting the mode: success updates the cache; failure logs and throws a HAP communication failure', async () => {
  const ok = build();
  await ok.target.setter(Characteristic.TargetHeatingCoolingState.HEAT);
  assert.deepEqual(ok.calls, [['mode', 'HEAT']]);
  assert.equal(ok.target.getter(), Characteristic.TargetHeatingCoolingState.HEAT);

  const bad = build();
  bad.nexia.setZoneMode = async () => { throw new Error('HTTP 500'); };
  await assert.rejects(bad.target.setter(Characteristic.TargetHeatingCoolingState.HEAT), isCommFailure);
  assert.equal(bad.logs.error.length, 1);
  assert.equal(bad.target.getter(), Characteristic.TargetHeatingCoolingState.COOL, 'cache not changed by a failed write');
});

test('setting the temperature: moves the right setpoint, ignores OFF, fails visibly on a failed write', async () => {
  const cool = build();
  await cool.temp.setter(24); // 75.2 F = the 75 F it already has
  assert.equal(cool.calls.length, 0, 'nothing changes, nothing is sent');
  await cool.temp.setter(23); // 73.4 F
  assert.deepEqual(cool.calls, [['setpoints', { cool: 73 }]]);

  const t = xl824();
  t.zones[0].current_zone_mode = 'OFF';
  const off = build({ thermostat: t });
  await off.temp.setter(22);
  assert.equal(off.calls.length, 0, 'ignored in OFF mode');

  const bad = build();
  bad.nexia.setSetpoints = async () => { throw new Error('HTTP 500'); };
  await assert.rejects(bad.temp.setter(23), isCommFailure);
});

// --- Added after the lead-engineer review (A3) ---
// Reference-shaped zone: setpoints only under zone.setpoints, no top-level heating/cooling keys.
function nestedAuto() {
  const t = xl824();
  const z = t.zones[0];
  z.current_zone_mode = 'AUTO';
  delete z.heating_setpoint;
  delete z.cooling_setpoint;
  z.setpoints = { heat: 68, cool: 76 };
  return t;
}

test('M1: setpoints are read from zone.setpoints when the top-level keys are absent', () => {
  const h = build({ thermostat: nestedAuto() });
  assert.equal(h.temp.getter(), 22.2, 'midpoint of 68 and 76 F (72 F), not the 20 C fallback');
});

test('M1: an AUTO write with nested setpoints sends finite numbers', async () => {
  const h = build({ thermostat: nestedAuto() });
  await h.temp.setter(23); // 73 F; the 8 F spread is kept exactly
  assert.deepEqual(h.calls, [['setpoints', { heat: 69, cool: 77 }]]);
});

test('M1: with no setpoints at all, reads fail visibly and a write is refused, never sent as null', async () => {
  const t = nestedAuto();
  delete t.zones[0].setpoints;
  const h = build({ thermostat: t });
  assert.throws(() => h.temp.getter(), isCommFailure, 'No Response, not 20 C');
  await assert.rejects(h.temp.setter(22), isCommFailure);
  assert.equal(h.calls.length, 0, 'nothing was sent');
  assert.ok(h.logs.error.length >= 1);
});

test('M1: the last known target survives a poll that carries no setpoints', () => {
  const h = build({ thermostat: nestedAuto() });
  assert.equal(h.temp.getter(), 22.2);
  const t2 = nestedAuto();
  delete t2.zones[0].setpoints;
  h.acc.update(t2, t2.zones[0]);
  assert.equal(h.temp.getter(), 22.2);
});

test('real XL shape: HEAT mode with a null cooling setpoint reads and writes normally', async () => {
  const t = xl824();
  const z = t.zones[0];
  z.current_zone_mode = 'HEAT';
  z.heating_setpoint = 70;
  z.cooling_setpoint = null;
  z.setpoints = { heat: 70, cool: null };
  const h = build({ thermostat: t });
  assert.equal(h.temp.getter(), 21.1, '70 F');
  await h.temp.setter(22); // 71.6 F -> 72
  assert.deepEqual(h.calls, [['setpoints', { heat: 72 }]]);
});

// --- Added with the A4 fixes ---
const withZone = (mutate) => { const t = xl824(); mutate(t, t.zones[0]); return t; };

test('S3: COOL mode moves the heat setpoint out of the way instead of violating the deadband', async () => {
  const h = build(); // COOL, heat 68, cool 75, deadband 3
  await h.temp.setter(21); // 69.8 -> 70 F
  assert.deepEqual(h.calls, [['setpoints', { cool: 70, heat: 67 }]]);
  assert.equal(h.z.heating_setpoint, 67, 'cache follows what was sent');
});

test('S3: HEAT mode moves the cool setpoint up when the new heat target would crowd it', async () => {
  const h = build({ thermostat: withZone((t, z) => { z.current_zone_mode = 'HEAT'; z.heating_setpoint = 70; z.cooling_setpoint = 75; delete z.setpoints; }) });
  await h.temp.setter(25); // 77 F
  assert.deepEqual(h.calls, [['setpoints', { heat: 77, cool: 80 }]]);
});

test('S3: a target outside the thermostat limits is clamped, not sent as asked', async () => {
  const h = build({ thermostat: withZone((t, z) => { z.current_zone_mode = 'HEAT'; z.heating_setpoint = 70; z.cooling_setpoint = null; }) });
  await h.temp.setter(60); // 140 F; the thermostat tops out at 99
  assert.deepEqual(h.calls, [['setpoints', { heat: 99 }]]);
});

test('S4: AUTO re-setting the displayed target sends nothing, and nudges keep the spread', async () => {
  const t = withZone((_, z) => { z.current_zone_mode = 'AUTO'; z.heating_setpoint = 68; z.cooling_setpoint = 75; delete z.setpoints; });
  const h = build({ thermostat: t });
  assert.equal(h.temp.getter(), 21.9, '71.5 F');
  await h.temp.setter(21.9);
  assert.equal(h.calls.length, 0, 'unchanged');
  assert.ok(h.logs.info.some(l => /nothing to send/.test(l)));

  await h.temp.setter(23); // 73 F
  await h.temp.setter(23.5); // 74 F
  assert.deepEqual(h.calls, [['setpoints', { heat: 70, cool: 77 }], ['setpoints', { heat: 71, cool: 78 }]]);
});

test('S5: a missing room temperature is "No Response" or the last known value, never 20 C', () => {
  const never = build({ thermostat: withZone((t, z) => { z.temperature = null; }) });
  assert.throws(() => never.svc.char(Characteristic.CurrentTemperature).getter(), isCommFailure);

  const h = build();
  const cur = h.svc.char(Characteristic.CurrentTemperature);
  assert.equal(cur.getter(), 23.3, '74 F');
  const t2 = xl824();
  t2.zones[0].temperature = '--';
  h.acc.update(t2, t2.zones[0]);
  assert.equal(cur.getter(), 23.3, 'kept');
  assert.ok(!h.svc.updates.some(([c, v]) => c === Characteristic.CurrentTemperature && v === 20), 'never pushed 20');
});

test('S5: missing humidity is "No Response" or the last known value, never 0 %', () => {
  const never = build({ thermostat: withZone(t => { t.indoor_humidity = '--'; }) });
  assert.throws(() => never.svc.char(Characteristic.CurrentRelativeHumidity).getter(), isCommFailure);

  const h = build();
  const hum = h.svc.char(Characteristic.CurrentRelativeHumidity);
  assert.equal(hum.getter(), 41);
  const t2 = xl824();
  t2.indoor_humidity = '--';
  h.acc.update(t2, t2.zones[0]);
  assert.equal(hum.getter(), 41);
});

test('scale: read from the thermostat when the zone has none; warn once and assume F when nothing says', () => {
  const c = build({ thermostat: withZone((t, z) => { delete z.features[0].scale; t.settings = [{ type: 'scale', current_value: 'c' }]; }) });
  assert.equal(c.svc.char(Characteristic.TemperatureDisplayUnits).getter(), Characteristic.TemperatureDisplayUnits.CELSIUS);
  assert.equal(c.svc.char(Characteristic.CurrentTemperature).getter(), 74, 'already Celsius: no conversion');
  assert.equal(c.logs.warn.length, 0);

  const none = build({ thermostat: withZone((t, z) => { delete z.features[0].scale; }) });
  assert.equal(none.svc.char(Characteristic.TemperatureDisplayUnits).getter(), Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
  none.svc.char(Characteristic.TemperatureDisplayUnits).getter();
  assert.equal(none.logs.warn.filter(l => /°F or °C/.test(l)).length, 1, 'said once');
});

test('startup: HAP\'s default target of 10 C is moved inside the thermostat range before setProps, so HAP has nothing to warn about', () => {
  const h = build(); // limits 55..99 F = 12.8..37.2 C
  assert.equal(h.temp.warned, false);
  assert.equal(h.temp.props.minValue, 12.8);
  assert.ok(h.temp.value >= 12.8 && h.temp.value <= 37.2);
});

test('race: a poll that started before our write finished must not put the old value back', async () => {
  const h = build();
  h.clock.t = 5_000;
  await h.temp.setter(23); // cool 73 F, written at t=5000
  assert.equal(h.temp.getter(), 22.8);

  const stale = xl824(); // still says cool 75, from before the write
  h.acc.update(stale, stale.zones[0], 4_999);
  assert.equal(h.temp.getter(), 22.8, 'poll started before the write: ignored');

  h.acc.update(stale, stale.zones[0], 5_001);
  assert.equal(h.temp.getter(), 23.9, 'a later poll is applied');
});

test('a mode change refreshes the target shown in the Home app straight away', async () => {
  const h = build(); // COOL: shows the 75 F cool setpoint
  await h.target.setter(Characteristic.TargetHeatingCoolingState.HEAT);
  const last = h.svc.updates.filter(([c]) => c === Characteristic.TargetTemperature).pop();
  assert.deepEqual(last && last[1], 20, 'the 68 F heat setpoint');
});

test('the unreadable-mode warning is re-armed once the mode is readable again', () => {
  const h = build();
  const bad = () => { const t = xl824(); t.zones[0].current_zone_mode = 'WEIRD'; h.acc.update(t, t.zones[0]); };
  bad();
  assert.equal(h.logs.warn.length, 1);
  const good = xl824();
  h.acc.update(good, good.zones[0]);
  bad();
  assert.equal(h.logs.warn.length, 2, 'same bad payload after a recovery warns again');
});

test('a temperature change while the thermostat is Off is ignored, and says so at info level', async () => {
  const h = build({ thermostat: withZone((t, z) => { z.current_zone_mode = 'OFF'; }) });
  await h.temp.setter(22);
  assert.equal(h.calls.length, 0);
  assert.ok(h.logs.info.some(l => /ignoring a temperature change/.test(l)), 'Homebridge drops log.debug, so this must be info');
});
