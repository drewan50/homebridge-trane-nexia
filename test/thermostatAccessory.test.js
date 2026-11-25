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
  const timers = []; // what the accessory scheduled: { fn, ms, cancelled, fired }
  const polls = { soon: 0 };
  const platform = {
    Service, Characteristic, log, debugEnabled: debug, now: () => clock.t,
    schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false, fired: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    requestPollSoon: () => { polls.soon += 1; },
    api: { hap: { HapStatusError, HAPStatus } },
  };
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
  // Writes are queued and sent in the background. settle() plays out time: fire the timers the accessory asked for and let the sends finish.
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      for (const timer of timers) if (!timer.cancelled && !timer.fired) { timer.fired = true; timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
      if (!timers.some(timer => !timer.cancelled && !timer.fired) && !acc.writesPending()) return;
    }
    throw new Error('writes never settled');
  };
  const target = svc.char(Characteristic.TargetHeatingCoolingState);
  const temp = svc.char(Characteristic.TargetTemperature);
  const raw = { target: target.setter, temp: temp.setter }; // what HomeKit calls: must return at once
  target.setter = async v => { raw.target(v); await settle(); }; // convenience: set, then let it be sent
  temp.setter = async v => { raw.temp(v); await settle(); };
  return {
    acc, svc, logs, calls, nexia, t, z, clock, timers, polls, settle, raw,
    target, temp,
    current: svc.char(Characteristic.CurrentHeatingCoolingState),
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

test('setting the mode: success updates the cache; a failed write rolls back, logs, and asks for a poll', async () => {
  const ok = build();
  await ok.target.setter(Characteristic.TargetHeatingCoolingState.HEAT);
  assert.deepEqual(ok.calls, [['mode', 'HEAT']]);
  assert.equal(ok.target.getter(), Characteristic.TargetHeatingCoolingState.HEAT);

  const bad = build();
  bad.nexia.setZoneMode = async () => { throw new Error('HTTP 500'); };
  await bad.target.setter(Characteristic.TargetHeatingCoolingState.HEAT); // HomeKit was answered; the failure comes later
  assert.equal(bad.logs.error.length, 1);
  assert.match(bad.logs.error[0], /failed to set mode -> HEAT: HTTP 500/);
  assert.equal(bad.target.getter(), Characteristic.TargetHeatingCoolingState.COOL, 'back to what Nexia last confirmed');
  assert.equal(bad.polls.soon, 1, 'and a poll is requested to show the real state');
});

test('setting the temperature: moves the right setpoint, ignores OFF, rolls back on a failed write', async () => {
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
  await bad.temp.setter(23);
  assert.equal(bad.logs.error.length, 1);
  assert.equal(bad.temp.getter(), 23.9, 'back to the 75 F Nexia last confirmed');
  assert.equal(bad.polls.soon, 1);
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

// --- 1.1.4: write handlers answer HomeKit at once; the change is sent in the background ---
const tick = () => new Promise(resolve => setImmediate(resolve));
const HEAT = Characteristic.TargetHeatingCoolingState.HEAT;
const COOL = Characteristic.TargetHeatingCoolingState.COOL;

test('1.1.4: a write handler returns at once; nothing is sent until the queue runs, and the Home app already shows the change', async () => {
  const h = build();
  const returned = h.raw.temp(23); // what HomeKit calls
  assert.equal(returned, undefined, 'nothing for HAP to wait on: no promise, no slow-write warning');
  assert.equal(h.calls.length, 0, 'nothing sent yet');
  assert.deepEqual(h.timers.map(t => t.ms), [700], 'a short pause so a slider drag can finish');
  assert.equal(h.temp.getter(), 22.8, '23 C is 73 F: the value that will be sent');
  await h.settle();
  assert.deepEqual(h.calls, [['setpoints', { cool: 73 }]]);
  assert.equal(h.temp.getter(), 22.8);
});

test('1.1.4: a mode change is not held back by the pause', () => {
  const h = build();
  h.raw.target(HEAT);
  assert.deepEqual(h.timers.map(t => t.ms), [0]);
  assert.equal(h.target.getter(), HEAT, 'shown at once');
  assert.equal(h.calls.length, 0);
});

test('1.1.4: a slider drag is merged: only the last value is sent, once', async () => {
  const h = build();
  for (const c of [21, 22, 23]) h.raw.temp(c);
  assert.equal(h.timers.filter(t => !t.cancelled).length, 1, 'each change restarts the pause');
  await h.settle();
  assert.deepEqual(h.calls, [['setpoints', { cool: 73 }]]);
});

test('1.1.4: one request at a time; changes made while one is in flight are merged and sent after it', async () => {
  const h = build();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  h.nexia.setSetpoints = async (z, payload) => { sent.push({ ...payload }); if (sent.length === 1) await gate; };

  h.raw.temp(23);
  h.timers[0].fired = true; h.timers[0].fn(); // the pause ends: the first request starts and hangs
  await tick();
  assert.deepEqual(sent, [{ cool: 73 }]);

  h.raw.temp(24); h.raw.temp(25);            // more changes while it is in flight
  for (const t of h.timers) if (!t.cancelled && !t.fired) { t.fired = true; t.fn(); }
  await tick();
  assert.equal(sent.length, 1, 'the second request waits for the first');
  assert.equal(h.temp.getter(), 25, 'but the Home app shows the latest');

  release();
  await h.settle();
  assert.deepEqual(sent, [{ cool: 73 }, { cool: 77 }], '24 was merged into 25');
});

test('1.1.4: changes are sent in the order they were made, and a temperature keeps the mode it was made under', async () => {
  const h = build(); // COOL, heat 68, cool 75
  h.raw.temp(23);    // a cooling target
  h.raw.target(HEAT); // then the user switches to heat before it is sent
  await h.settle();
  assert.deepEqual(h.calls, [['setpoints', { cool: 73 }], ['mode', 'HEAT']]);
  assert.equal(h.z.heating_setpoint, 68, 'the cooling target never touched the heat setpoint');
});

test('1.1.4: a mode change takes effect locally at once, so a temperature made right after sees the new mode', async () => {
  const h = build({ thermostat: withZone((t, z) => { z.current_zone_mode = 'OFF'; }) });
  h.raw.target(HEAT);
  h.raw.temp(22); // would be ignored if the thermostat still looked Off
  await h.settle();
  assert.deepEqual(h.calls, [['mode', 'HEAT'], ['setpoints', { heat: 72 }]]);
});

test('1.1.4: a poll that arrives while a change is waiting or in flight is ignored, so the tile does not flicker', async () => {
  const h = build();
  h.clock.t = 5_000;
  h.raw.temp(23);
  const stale = xl824(); // still says cool 75
  h.acc.update(stale, stale.zones[0], 6_000); // started after the change, before it was sent
  assert.equal(h.temp.getter(), 22.8);
  assert.ok(h.logs.debug.some(l => /ignoring a poll while a change is being sent/.test(l)));
  await h.settle();

  const fresh = xl824();
  fresh.zones[0].cooling_setpoint = 72; // someone changed it on the wall meanwhile: a value different from the local 73
  h.clock.t = 7_000;
  h.acc.update(fresh, fresh.zones[0], 7_001);
  assert.equal(h.temp.getter(), 22.2, 'polls are applied again once nothing is pending');
});

test('1.1.4: a failed write drops what was queued behind it, puts the tile back, logs once and asks for a poll', async () => {
  const h = build();
  h.nexia.setZoneMode = async () => { throw new Error('HTTP 502'); };
  h.raw.target(HEAT);
  h.raw.temp(22);
  await h.settle();
  assert.deepEqual(h.calls, [], 'the temperature queued behind the failed mode change was not sent');
  assert.equal(h.target.getter(), COOL);
  assert.equal(h.temp.getter(), 23.9, '75 F, as Nexia last confirmed');
  assert.equal(h.logs.error.length, 1);
  assert.equal(h.polls.soon, 1);

  h.nexia.setZoneMode = async (z, mode) => { h.calls.push(['mode', mode]); };
  await h.target.setter(HEAT);
  assert.deepEqual(h.calls, [['mode', 'HEAT']], 'the queue works again after a failure');
});

test('1.1.4: if the temperature fails after the mode went through, the mode stays and only the temperature rolls back', async () => {
  const h = build();
  h.nexia.setSetpoints = async () => { throw new Error('HTTP 500'); };
  h.raw.target(HEAT);
  h.raw.temp(22);
  await h.settle();
  assert.deepEqual(h.calls, [['mode', 'HEAT']]);
  assert.equal(h.target.getter(), HEAT, 'the confirmed mode is kept');
  assert.equal(h.temp.getter(), 20, 'the 68 F heat setpoint, not the 22 C that was asked for');
  assert.equal(h.logs.error.length, 1);
  assert.equal(h.polls.soon, 1);
});

test('1.1.4: a change that can never work still fails in the handler itself, immediately', () => {
  const t = xl824();
  delete t.zones[0].current_zone_mode;
  const unknownMode = build({ thermostat: t });
  assert.throws(() => unknownMode.raw.temp(22), isCommFailure, 'unknown mode');

  const none = xl824();
  none.zones[0].heating_setpoint = null; none.zones[0].cooling_setpoint = null; delete none.zones[0].setpoints;
  const noSetpoints = build({ thermostat: none });
  assert.throws(() => noSetpoints.raw.temp(22), isCommFailure, 'no readable setpoint');

  const limits = withZone((t2, z) => { z.features[0].setpoint_heat_min = 70; z.features[0].setpoint_cool_max = 71; z.current_zone_mode = 'AUTO'; });
  const noPair = build({ thermostat: limits });
  assert.throws(() => noPair.raw.temp(21), isCommFailure, 'no valid heat/cool pair inside the limits');

  for (const h of [unknownMode, noSetpoints, noPair]) assert.equal(h.timers.length, 0, 'and nothing was queued');
});

// --- Added after the lead-engineer review of PR #5 ---
const fire = timer => { timer.fired = true; timer.fn(); };
const updatesOf = (h, characteristic) => h.svc.updates.filter(([c]) => c === characteristic).map(([, v]) => v);
const deferred = () => { let release; const gate = new Promise(resolve => { release = resolve; }); return { gate, release }; };

test('review M1: a failed mode change rolls back even when the previous batch ended while another change was still pausing', async () => {
  const h = build();
  const { gate, release } = deferred();
  let sends = 0;
  h.nexia.setSetpoints = async () => { sends += 1; if (sends === 1) await gate; };
  h.nexia.setZoneMode = async () => { throw new Error('HTTP 502'); };

  h.raw.temp(23);
  fire(h.timers[0]); await tick(); // the first request is in flight
  h.raw.temp(24);                  // queued behind it, its pause still running
  release(); await tick(); await tick();
  h.raw.target(HEAT);              // the user now switches to heat, and that write fails
  await h.settle();

  assert.equal(h.target.getter(), COOL, 'the thermostat is still in COOL, so the tile must say COOL');
  assert.equal(updatesOf(h, Characteristic.TargetHeatingCoolingState).at(-1), COOL, 'and the Home app was told');
  assert.equal(h.polls.soon, 1);
});

test('review S1: changes made while a request is in flight keep their pause, so a drag sends only its first and last values', async () => {
  const h = build();
  const first = deferred();
  const second = deferred();
  const sent = [];
  h.nexia.setSetpoints = async (z, payload) => {
    sent.push({ ...payload });
    if (sent.length === 1) await first.gate;
    if (sent.length === 2) await second.gate;
  };

  h.raw.temp(21);
  fire(h.timers[0]); await tick();     // request 1 is in flight
  h.raw.temp(22);                      // queued behind it, its pause running
  first.release(); await tick(); await tick(); // request 1 ends while 22 is still pausing
  for (const c of [23, 24]) h.raw.temp(c);     // the drag carries on
  second.release();
  await h.settle();
  assert.deepEqual(sent, [{ cool: 70, heat: 67 }, { cool: 75 }], 'the first value and the last; 22 and 23 were never sent');
});

const AUTO = Characteristic.TargetHeatingCoolingState.AUTO;

test('review S2: a rollback tells the Home app which mode and which target it went back to', async () => {
  const h = build(); // COOL, 75 F (23.9 C)
  h.nexia.setZoneMode = async () => { throw new Error('HTTP 500'); };
  h.raw.target(HEAT);
  await h.settle();
  assert.equal(updatesOf(h, Characteristic.TargetHeatingCoolingState).at(-1), COOL, 'the mode the tile must show again');
  assert.equal(updatesOf(h, Characteristic.TargetTemperature).at(-1), 23.9, 'and the target');
});

test('review S2: after a poll shows a change made on the wall, a failed write rolls back to what that poll showed', async () => {
  const h = build();
  await h.target.setter(HEAT); // batch 1 succeeds: Nexia confirmed HEAT
  const wall = xl824();
  wall.zones[0].current_zone_mode = 'AUTO'; // someone sets AUTO on the thermostat; the next poll shows it
  h.clock.t = 9_000;
  h.acc.update(wall, wall.zones[0], 9_001);
  assert.equal(h.target.getter(), AUTO);

  h.nexia.setZoneMode = async () => { throw new Error('HTTP 500'); };
  h.raw.target(COOL);
  await h.settle();
  assert.equal(h.target.getter(), AUTO, 'back to AUTO, not to the HEAT confirmed before the poll');
});

test('review S2: while more changes are queued the tile shows the latest request, never an intermediate state', async () => {
  const h = build(); // COOL: heat 68, cool 75
  h.raw.temp(23);      // A: a cooling target
  h.raw.target(HEAT);  // B
  h.raw.temp(22);      // C: a heating target
  await h.settle();
  assert.deepEqual(h.calls, [['setpoints', { cool: 73 }], ['mode', 'HEAT'], ['setpoints', { heat: 72, cool: 75 }]]);
  const shown = updatesOf(h, Characteristic.TargetTemperature);
  assert.ok(shown.length >= 3);
  assert.deepEqual([...new Set(shown)], [22.2], 'every push showed the latest request (72 F); none flickered to a value in between');
});

test('review N1: on shutdown a change that is still pausing is sent at once', async () => {
  const h = build();
  h.raw.temp(23);
  assert.equal(h.calls.length, 0);
  await h.acc.flushPendingWrites();
  assert.deepEqual(h.calls, [['setpoints', { cool: 73 }]]);
  assert.equal(h.timers[0].cancelled, true, 'its pause was cancelled, not left to fire later');
});

test('review N2: if sending a change throws something unexpected, the queue is not left stuck ignoring every poll', async () => {
  const h = build();
  const original = h.svc.updateCharacteristic.bind(h.svc);
  let fail = true;
  h.svc.updateCharacteristic = (c, v) => { if (fail) { fail = false; throw new Error('boom'); } return original(c, v); };
  h.raw.target(HEAT);
  await h.settle();
  assert.ok(h.logs.error.some(l => /unexpected error while sending a change: boom/.test(l)));
  assert.equal(h.acc.writesPending(), false, 'not stuck');

  const fresh = xl824();
  fresh.zones[0].cooling_setpoint = 72;
  h.clock.t = 9_000;
  h.acc.update(fresh, fresh.zones[0], 9_001);
  assert.equal(h.temp.getter(), 22.2, 'polls are applied again');
});

test('review M1 (the state that is left): a rollback leaves a pause timer running; a mode change inside that window still rolls back', async () => {
  const h = build();
  const { gate, release } = deferred();
  const rejectFirst = new Error('HTTP 500');
  let sends = 0;
  h.nexia.setSetpoints = async () => { sends += 1; if (sends === 1) { await gate; throw rejectFirst; } };
  h.nexia.setZoneMode = async () => { throw new Error('HTTP 502'); };

  h.raw.temp(23);
  fire(h.timers[0]); await tick();   // request 1 is in flight, and will fail
  h.raw.temp(24);                    // queued behind it with its pause running
  release(); await tick(); await tick(); // request 1 fails: rollBack drops the queue, but the pause timer is still running
  assert.equal(h.acc.writesPending(), true, 'the stale pause timer is still pending, as the scenario needs');

  h.raw.target(HEAT);                // inside that window
  await h.settle();                  // the mode change fails too
  assert.equal(h.target.getter(), COOL, 'rolled back to the confirmed COOL');
  assert.equal(updatesOf(h, Characteristic.TargetHeatingCoolingState).at(-1), COOL, 'and the Home app was told');
});

test('review N2 (a change still queued behind the one that throws): the queue is not left stuck ignoring every poll', async () => {
  const h = build();
  const original = h.svc.updateCharacteristic.bind(h.svc);
  let fail = true;
  h.svc.updateCharacteristic = (c, v) => { if (fail) { fail = false; throw new Error('boom'); } return original(c, v); };
  h.raw.temp(23);       // sent first; its bookkeeping throws something nothing anticipated
  h.raw.target(HEAT);   // still queued behind it
  await h.settle();

  assert.ok(h.logs.error.some(l => /unexpected error while sending a change: boom/.test(l)));
  assert.equal(h.acc.writesPending(), false, 'the change queued behind it was dropped, not left to block every poll');
  assert.deepEqual(h.calls, [['setpoints', { cool: 73 }]], 'the dropped mode change was never sent');
  assert.equal(h.target.getter(), COOL, 'and the tile shows the mode Nexia is really in');

  const fresh = xl824();
  fresh.zones[0].cooling_setpoint = 72;
  h.clock.t = 9_000;
  h.acc.update(fresh, fresh.zones[0], 9_001);
  assert.equal(h.temp.getter(), 22.2, 'polls are applied again');
});
