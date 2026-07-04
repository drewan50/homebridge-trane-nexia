#!/usr/bin/env node
/* End-to-end check: NexiaClient.getHouse() against the live account, then
   apply the same per-zone computations the HomeKit accessory does, and
   print what each accessory will look like in Apple Home. No HAP / no
   plugin lifecycle — just the data path. */
'use strict';

const fs = require('fs');
const path = require('path');
const { NexiaClient } = require('../dist/nexia/client');

const fToC = f => (Number.isFinite(Number(f)) ? Math.round(((Number(f) - 32) * (5 / 9)) * 10) / 10 : null);
const cToF = c => Math.round(Number(c) * (9 / 5) + 32);

function advanced(thermostat) {
  const adv = (thermostat.features || []).find(f => f.name === 'advanced_info');
  const out = {};
  for (const item of (adv && adv.items) || []) {
    if (item && item.label) out[item.label] = item.value;
  }
  return out;
}

function thermostatFeature(zone) {
  return (zone.features || []).find(f => f.name === 'thermostat');
}

function displayName(thermostat, zone) {
  const t = (thermostat.name || '').trim();
  const z = (zone.name || '').trim();
  const generic = !z || z.toLowerCase() === 'nativezone' || z === t;
  if (t && generic) return t;
  if (t && z) return `${t} ${z}`;
  return z || t || `Thermostat ${thermostat.id}-${zone.id}`;
}

function targetTempC(zone, scale) {
  const conv = v => (scale === 'f' ? fToC(v) : (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null));
  const heat = zone.heating_setpoint;
  const cool = zone.cooling_setpoint;
  switch (zone.current_zone_mode) {
    case 'HEAT': return conv(heat != null ? heat : cool);
    case 'COOL': return conv(cool != null ? cool : heat);
    case 'AUTO':
      if (heat != null && cool != null) return conv((heat + cool) / 2);
      return conv(cool != null ? cool : heat);
    default: return conv(cool != null ? cool : heat);
  }
}

function currentHcState(thermostat, zone) {
  const status = String(thermostat.system_status || (thermostatFeature(zone) || {}).system_status || '').toLowerCase();
  if (status.includes('heat')) return 'HEAT (1)';
  if (status.includes('cool')) return 'COOL (2)';
  if (status) return `OFF (0) — system_status="${thermostat.system_status}"`;
  return 'OFF (0) — no system_status';
}

function targetTempProps(scale, feature) {
  const fmin = (feature && (feature.setpoint_heat_min != null ? feature.setpoint_heat_min : feature.setpoint_cool_min));
  const fmax = (feature && (feature.setpoint_cool_max != null ? feature.setpoint_cool_max : feature.setpoint_heat_max));
  const inc = feature && feature.setpoint_increment;
  if (scale === 'f') {
    return {
      minC: fmin != null ? fToC(fmin) : 10,
      maxC: fmax != null ? fToC(fmax) : 38,
      stepC: inc ? Math.max(0.5, Math.round(((inc * 5) / 9) * 10) / 10) : 0.5,
      nativeMin: fmin, nativeMax: fmax, nativeInc: inc,
    };
  }
  return { minC: fmin != null ? fmin : 10, maxC: fmax != null ? fmax : 38, stepC: inc != null ? inc : 0.5, nativeMin: fmin, nativeMax: fmax, nativeInc: inc };
}

async function main() {
  const credsPath = path.resolve(__dirname, '..', 'nexia-credentials.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const client = new NexiaClient({
    brand: creds.brand || 'trane',
    mobileId: String(creds.mobileId),
    apiKey: creds.apiKey,
    houseId: creds.houseId ? String(creds.houseId) : undefined,
    debug: false,
  });
  console.log(`brand=${creds.brand}  base=${client.baseUrl}`);

  const house = await client.getHouse();
  console.log(`houseId=${house.id}  thermostats=${house.items.length}\n`);

  for (const t of house.items) {
    const adv = advanced(t);
    console.log(`==== ACCESSORY ====`);
    for (const z of t.zones || []) {
      const f = thermostatFeature(z);
      const scale = (f && f.scale) || 'f';
      const props = targetTempProps(scale, f);
      const tC = scale === 'f' ? fToC(z.temperature) : Math.round(Number(z.temperature) * 10) / 10;
      console.log(`  displayName       : "${displayName(t, z)}"`);
      console.log(`  HomeKit AccessoryInformation:`);
      console.log(`    Manufacturer    : ${t.manufacturer || 'Trane'}`);
      console.log(`    Model           : ${adv.Model}`);
      console.log(`    SerialNumber    : ${adv.AUID}`);
      console.log(`    FirmwareRevision: ${adv['Firmware Version']}`);
      console.log(`  HomeKit Thermostat characteristics:`);
      console.log(`    CurrentTemp     : ${tC}°C  (native ${z.temperature}°${scale.toUpperCase()})`);
      console.log(`    TargetTemp      : ${targetTempC(z, scale)}°C`);
      console.log(`    DisplayUnits    : ${scale === 'f' ? 'FAHRENHEIT' : 'CELSIUS'}`);
      console.log(`    CurrentHCState  : ${currentHcState(t, z)}`);
      console.log(`    TargetHCState   : ${z.current_zone_mode}`);
      console.log(`    Setpoint range  : ${props.minC}°C..${props.maxC}°C  step ${props.stepC}°C  (native ${props.nativeMin}°${scale.toUpperCase()}..${props.nativeMax}°${scale.toUpperCase()} step ${props.nativeInc}°${scale.toUpperCase()})`);
      console.log(`    Setpoint delta  : ${f && f.setpoint_delta != null ? f.setpoint_delta : t.delta}°${scale.toUpperCase()}`);
      const hum = t.indoor_humidity;
      const humN = hum != null && hum !== '' ? Number(hum) : null;
      console.log(`    Humidity        : ${t.has_indoor_humidity ? (humN != null ? `${humN}%` : '—') : '(not advertised)'}`);
      console.log(`  raw zone state:`);
      console.log(`    current_zone_mode=${z.current_zone_mode}  heating_setpoint=${z.heating_setpoint}  cooling_setpoint=${z.cooling_setpoint}`);
      console.log(`    thermostat.system_status=${JSON.stringify(t.system_status)}`);
      console.log(`    available actions: thermostat=[${Object.keys((f && f.actions) || {}).join(', ')}]`);
      const tm = (z.features || []).find(x => x.name === 'thermostat_mode');
      console.log(`                       thermostat_mode=[${Object.keys((tm && tm.actions) || {}).join(', ')}]`);
    }
    console.log();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
