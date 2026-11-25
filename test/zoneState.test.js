'use strict';
// Tests for the pure payload -> mode/activity functions, run against the compiled output.
// Run with `npm test` (builds first). Fixtures are synthetic; see test/fixtures/*.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMode, resolveZoneMode, resolveActivity, describeZone } = require('../dist/nexia/zoneState');

const clone = o => JSON.parse(JSON.stringify(o));
const xl824 = () => clone(require('./fixtures/xl824-cool.json'));
const ux360 = () => clone(require('./fixtures/ux360-zoned-cool.json'));

test('parseMode accepts only the four HomeKit modes, case-insensitively', () => {
  assert.equal(parseMode('cool'), 'COOL');
  assert.equal(parseMode(' Heat '), 'HEAT');
  assert.equal(parseMode('AUTO'), 'AUTO');
  assert.equal(parseMode('off'), 'OFF');
  for (const bad of ['EMERGENCY', '', 'on', null, undefined, 3, {}]) assert.equal(parseMode(bad), undefined, String(bad));
});

test('XL824: mode comes from zone.current_zone_mode (unchanged behavior)', () => {
  const t = xl824();
  assert.equal(resolveZoneMode(t, t.zones[0]), 'COOL');
});

test('issue #1: a UX360-style zone with no current_zone_mode resolves from zone.settings', () => {
  const t = ux360();
  assert.equal(t.zones[0].current_zone_mode, undefined);
  assert.equal(resolveZoneMode(t, t.zones[0]), 'COOL');
});

test('mode falls back in order: zone.settings, thermostat_mode feature, thermostat settings', () => {
  const t = ux360();
  const z = t.zones[0];
  delete z.settings;
  assert.equal(resolveZoneMode(t, z), 'COOL', 'thermostat_mode feature');

  z.features = z.features.filter(f => f.name !== 'thermostat_mode');
  assert.equal(resolveZoneMode(t, z), undefined, 'nothing left to read');

  t.settings = [{ type: 'system_mode', current_value: 'heat' }];
  assert.equal(resolveZoneMode(t, z), 'HEAT', 'thermostat system_mode, lowercase');

  t.settings = [{ type: 'mode', current_value: 'AUTO' }];
  assert.equal(resolveZoneMode(t, z), 'AUTO', 'thermostat mode');
});

test('current_zone_mode keeps priority when sources disagree', () => {
  const t = ux360();
  const z = t.zones[0];
  z.current_zone_mode = 'HEAT';
  assert.equal(resolveZoneMode(t, z), 'HEAT');
});

test('an unrecognized mode is never turned into OFF: it is skipped, or unknown', () => {
  const t = xl824();
  const z = t.zones[0];
  z.current_zone_mode = 'EMERGENCY_HEAT';
  assert.equal(resolveZoneMode(t, z), undefined);

  z.settings = [{ type: 'zone_mode', current_value: 'cool' }];
  assert.equal(resolveZoneMode(t, z), 'COOL', 'falls through to the next valid source');
});

test('a payload with no mode anywhere resolves to undefined, not OFF', () => {
  const t = xl824();
  delete t.zones[0].current_zone_mode;
  assert.equal(resolveZoneMode(t, t.zones[0]), undefined);
  t.zones[0].current_zone_mode = null;
  assert.equal(resolveZoneMode(t, t.zones[0]), undefined);
});

test('activity: XL824 uses thermostat system_status', () => {
  const t = xl824();
  assert.equal(resolveActivity(t, t.zones[0]), 'idle');
  t.system_status = 'Cooling';
  assert.equal(resolveActivity(t, t.zones[0]), 'cooling');
  t.system_status = 'Heating';
  assert.equal(resolveActivity(t, t.zones[0]), 'heating');
  t.system_status = 'Waiting...';
  assert.equal(resolveActivity(t, t.zones[0]), 'idle');
});

test('activity: per-zone zone_status wins over the thermostat-wide status on zoned systems', () => {
  const t = ux360();
  assert.equal(t.system_status, 'Cooling');
  assert.equal(resolveActivity(t, t.zones[0]), 'cooling');
  assert.equal(resolveActivity(t, t.zones[1]), 'idle', 'the other zone is idle although the system is cooling');
});

test('activity: an unrecognized zone_status falls through to system_status', () => {
  const t = ux360();
  t.zones[1].zone_status = 'Damper Closed';
  assert.equal(resolveActivity(t, t.zones[1]), 'cooling');
});

test('activity: with no status at all it is inferred from mode and setpoints', () => {
  const t = xl824();
  const z = t.zones[0];
  delete t.system_status;
  z.current_zone_mode = 'HEAT';
  assert.equal(resolveActivity(t, z), 'heating');
  z.current_zone_mode = 'COOL';
  assert.equal(resolveActivity(t, z), 'cooling');
  z.current_zone_mode = 'AUTO';
  z.temperature = 70;
  assert.equal(resolveActivity(t, z), 'idle', 'inside the band');
  z.temperature = 60;
  assert.equal(resolveActivity(t, z), 'heating', 'below the heat setpoint');
  z.temperature = 80;
  assert.equal(resolveActivity(t, z), 'cooling', 'above the cool setpoint');
  z.current_zone_mode = 'OFF';
  assert.equal(resolveActivity(t, z), 'idle');
});

test('describeZone names the mode sources and an unknown mode, and carries no credentials', () => {
  const t = ux360();
  const line = describeZone(t, t.zones[0]);
  assert.match(line, /mode=COOL/);
  assert.match(line, /zone\.settings\[zone_mode\]="COOL"/);
  assert.match(line, /zone_status="Cooling"/);
  assert.match(line, /activity=cooling/);

  const u = xl824();
  u.zones[0].current_zone_mode = 'WEIRD';
  const unknown = describeZone(u, u.zones[0]);
  assert.match(unknown, /mode=UNKNOWN/);
  assert.match(unknown, /zone\.current_zone_mode="WEIRD"/);
  assert.doesNotMatch(unknown, /apiKey|mobileId|X-Api|password/i);
});

// --- Added after the lead-engineer review (A3) ---
const { resolveSetpoints } = require('../dist/nexia/zoneState');

test('setpoints: top-level keys win, zone.setpoints is the fallback, junk becomes null', () => {
  assert.deepEqual(resolveSetpoints({ heating_setpoint: 68, cooling_setpoint: 75, setpoints: { heat: 1, cool: 2 } }), { heat: 68, cool: 75 });
  assert.deepEqual(resolveSetpoints({ setpoints: { heat: 68, cool: 76 } }), { heat: 68, cool: 76 });
  assert.deepEqual(resolveSetpoints({ heating_setpoint: 68, cooling_setpoint: null, setpoints: { heat: 68, cool: null } }), { heat: 68, cool: null }, 'real XL shape in HEAT mode');
  assert.deepEqual(resolveSetpoints({ setpoints: { heat: '21.5', cool: '--' } }), { heat: 21.5, cool: null });
  assert.deepEqual(resolveSetpoints({ heating_setpoint: NaN, cooling_setpoint: undefined }), { heat: null, cool: null });
  assert.deepEqual(resolveSetpoints({}), { heat: null, cool: null });
});

test('activity: a NativeZone ignores zone_status and follows the system status (as the reference does)', () => {
  const t = xl824();
  t.system_status = 'Cooling';
  t.zones[0].zone_status = 'Idle';
  assert.equal(t.zones[0].name, 'NativeZone');
  assert.equal(resolveActivity(t, t.zones[0]), 'cooling');
  t.zones[0].name = 'Living Room';
  assert.equal(resolveActivity(t, t.zones[0]), 'idle', 'a named zone still trusts its own zone_status');
});

test('activity: an empty zone_status (what the real XL824/XL850 report) falls through to system_status', () => {
  const t = xl824();
  t.system_status = 'Heating';
  t.zones[0].zone_status = '';
  assert.equal(resolveActivity(t, t.zones[0]), 'heating');
});

test('describeZone reports the model from advanced_info (the thermostat "type" is just "xxl_thermostat")', () => {
  const t = ux360();
  t.type = 'xxl_thermostat';
  assert.match(describeZone(t, t.zones[0]), /model="UX360"/);
});

// --- Added with the A4 fixes ---
const { resolveScale } = require('../dist/nexia/zoneState');

test('scale: zone feature, then thermostat feature, then the thermostat "scale" setting; unknown stays unknown', () => {
  const t = xl824();
  assert.equal(resolveScale(t, t.zones[0]), 'f');

  t.zones[0].features[0].scale = 'c';
  assert.equal(resolveScale(t, t.zones[0]), 'c', 'zone feature first');

  delete t.zones[0].features[0].scale;
  t.features.push({ name: 'thermostat', scale: 'c' });
  assert.equal(resolveScale(t, t.zones[0]), 'c', 'thermostat-level feature');
  assert.equal(resolveScale(t), 'c', 'no zone needed (the outdoor sensor has none)');

  t.features = t.features.filter(f => f.name !== 'thermostat');
  t.settings = [{ type: 'scale', current_value: 'F' }];
  assert.equal(resolveScale(t, t.zones[0]), 'f', 'the real XL824/XL850 setting, any case');

  t.settings = [];
  assert.equal(resolveScale(t, t.zones[0]), undefined);
});

test('mode order follows the reference: a zone with no settings of its own takes the thermostat system_mode', () => {
  const t = ux360();
  const z = t.zones[0];
  z.settings = [];                                    // the XL's NativeZone looks like this
  t.settings = [{ type: 'system_mode', current_value: 'HEAT' }];
  assert.equal(z.features.find(f => f.name === 'thermostat_mode').value, 'COOL');
  assert.equal(resolveZoneMode(t, z), 'HEAT', 'non-zoned: system_mode before the feature');

  z.settings = [{ type: 'preset_selected', current_value: 1 }]; // zoned, but without a zone_mode entry
  assert.equal(resolveZoneMode(t, z), 'COOL', 'zoned: the thermostat-wide system_mode is not consulted');
});

test('activity: a zone that is Off is idle, whatever a system-wide status still says', () => {
  const t = xl824();
  t.zones[0].current_zone_mode = 'OFF';
  t.system_status = 'Cooling';
  assert.equal(resolveActivity(t, t.zones[0]), 'idle');
});

test('describeZone shows the scale it used', () => {
  const t = xl824();
  assert.match(describeZone(t, t.zones[0]), /temp=74F/);
});
