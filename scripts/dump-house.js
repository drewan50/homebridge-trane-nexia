#!/usr/bin/env node
/* Dry-run: fetches /session and /houses/{id} with the saved credentials,
   tries each brand host until one accepts the auth, and dumps everything
   to local JSON files for offline inspection. */
'use strict';

const fs = require('fs');
const path = require('path');

const BASES = {
  trane: 'https://www.tranehome.com/mobile/',
  nexia: 'https://www.mynexia.com/mobile/',
  asair: 'https://asairhome.com/mobile/',
};

function mask(s, keep = 4) {
  if (!s) return s;
  const str = String(s);
  if (str.length <= keep + 2) return '***';
  return str.slice(0, keep) + '…' + str.slice(-2);
}

async function tryGet(base, p, headers) {
  const url = base + p;
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { url, status: res.status, ok: res.ok, text };
}

async function main() {
  const credsPath = path.resolve(__dirname, '..', 'nexia-credentials.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const headers = {
    'X-MobileId': String(creds.mobileId),
    'X-ApiKey': String(creds.apiKey),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  console.log(`Using mobileId=${mask(creds.mobileId)} apiKey=${mask(creds.apiKey, 6)}`);

  // Determine which brand host accepts the credentials by trying /session.
  const orderedBrands = creds.brand && BASES[creds.brand]
    ? [creds.brand, ...Object.keys(BASES).filter(b => b !== creds.brand)]
    : Object.keys(BASES);

  let workingBrand = null;
  let workingBase = null;
  let sessionJson = null;
  for (const b of orderedBrands) {
    const base = BASES[b];
    process.stdout.write(`probe ${b.padEnd(5)} ${base}session ... `);
    try {
      const r = await tryGet(base, 'session', headers);
      console.log(`HTTP ${r.status}`);
      if (r.ok) {
        try { sessionJson = JSON.parse(r.text); } catch (_) { sessionJson = null; }
        if (sessionJson) {
          workingBrand = b;
          workingBase = base;
          break;
        } else {
          console.log('  (response was OK but not JSON — first 300 chars):');
          console.log('  ' + r.text.slice(0, 300));
        }
      } else if (r.status >= 400 && r.status < 500) {
        console.log('  body excerpt: ' + r.text.slice(0, 200));
      }
    } catch (e) {
      console.log('  network error: ' + e.message);
    }
  }
  if (!workingBrand) {
    console.error('\nNo brand host accepted the credentials. Check mobileId/apiKey or try a different brand.');
    process.exit(2);
  }
  console.log(`\nAUTH OK on brand=${workingBrand} (${workingBase})`);

  // Save session
  const outSession = path.resolve(__dirname, '..', 'session-dump.json');
  fs.writeFileSync(outSession, JSON.stringify(sessionJson, null, 2));
  console.log(`Wrote ${outSession}`);

  // Resolve house id
  const sessHouseId = sessionJson?.result?._links?.child?.[0]?.data?.id;
  const houseId = creds.houseId || sessHouseId;
  console.log(`houseId from session=${sessHouseId}  configured=${creds.houseId}  using=${houseId}`);
  if (!houseId) {
    console.error('No houseId available. Aborting.');
    process.exit(2);
  }

  // Fetch the house
  const houseR = await tryGet(workingBase, `houses/${houseId}`, headers);
  console.log(`GET houses/${houseId} -> HTTP ${houseR.status}`);
  if (!houseR.ok) {
    console.error('Body:', houseR.text.slice(0, 500));
    process.exit(3);
  }
  let houseJson;
  try { houseJson = JSON.parse(houseR.text); } catch (e) {
    console.error('House response not JSON:', houseR.text.slice(0, 500));
    process.exit(3);
  }
  const outHouse = path.resolve(__dirname, '..', 'house-dump.json');
  fs.writeFileSync(outHouse, JSON.stringify(houseJson, null, 2));
  console.log(`Wrote ${outHouse}`);

  // Summarize
  const items = houseJson?.result?._links?.child?.[0]?.data?.items;
  if (!Array.isArray(items)) {
    console.error('Unexpected shape: result._links.child[0].data.items is not an array.');
    console.error('Top-level keys:', Object.keys(houseJson?.result || {}));
    process.exit(4);
  }
  console.log(`\nThermostats: ${items.length}`);
  for (const t of items) {
    console.log(`  - id=${t.id} name=${JSON.stringify(t.name)} model=${JSON.stringify(t.model)} firmware=${JSON.stringify(t.firmware)} type=${JSON.stringify(t.type)}`);
    const zones = t.zones || [];
    console.log(`    zones: ${zones.length}`);
    for (const z of zones) {
      console.log(`      * zone id=${z.id} name=${JSON.stringify(z.name)} type=${JSON.stringify(z.type)}`);
      console.log(`        mode=${z.current_zone_mode}  temp=${z.temperature}  heat_sp=${z.heating_setpoint}  cool_sp=${z.cooling_setpoint}`);
      const features = (z.features || []).map(f => f.name);
      console.log(`        features: ${features.join(', ')}`);
      for (const f of z.features || []) {
        const actions = Object.keys(f.actions || {});
        const scale = f.scale ? ` scale=${f.scale}` : '';
        const valueKeys = Object.keys(f).filter(k => !['name', 'actions', 'scale', '_links'].includes(k));
        console.log(`          feature "${f.name}"${scale} actions=[${actions.join(', ')}] keys=[${valueKeys.join(', ')}]`);
      }
    }
  }
  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
