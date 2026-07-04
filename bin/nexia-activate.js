#!/usr/bin/env node
'use strict';

const BASE_URLS = {
  trane: 'https://www.tranehome.com/mobile/',
  nexia: 'https://www.mynexia.com/mobile/',
  asair: 'https://asairhome.com/mobile/',
};

async function main() {
  const args = process.argv.slice(2);
  let brand = 'trane';
  let code = null;
  let apiUrl = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--brand') brand = args[++i];
    else if (a === '--trane') brand = 'trane';
    else if (a === '--nexia') brand = 'nexia';
    else if (a === '--asair') brand = 'asair';
    else if (a === '--api-url') apiUrl = args[++i];
    else if (a === '-h' || a === '--help') return usage(0);
    else if (!code) code = a;
  }
  if (!code) return usage(1);
  if (!BASE_URLS[brand]) {
    console.error(`Unknown brand "${brand}". Use one of: ${Object.keys(BASE_URLS).join(', ')}.`);
    process.exit(1);
  }
  const baseUrl = apiUrl ? (apiUrl.endsWith('/') ? apiUrl : apiUrl + '/') : BASE_URLS[brand];
  const url = baseUrl + 'activate';
  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ activation_code: code }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`activate failed: HTTP ${res.status} ${res.statusText}`);
    console.error(text);
    process.exit(2);
  }
  let data;
  try { data = JSON.parse(text); }
  catch (e) {
    console.error('activate returned non-JSON body:');
    console.error(text);
    process.exit(2);
  }
  const mobileId = data && data.result && data.result.mobile_id;
  const apiKey = data && data.result && data.result.api_key;
  if (!mobileId || !apiKey) {
    console.error('activate response is missing mobile_id / api_key:');
    console.error(JSON.stringify(data, null, 2));
    process.exit(2);
  }
  console.log('');
  console.log('SUCCESS. Copy these into your Homebridge config:');
  console.log('');
  console.log(`  brand:    ${brand}`);
  console.log(`  mobileId: ${mobileId}`);
  console.log(`  apiKey:   ${apiKey}`);
  console.log('');
  console.log(JSON.stringify({ brand: brand, mobileId: mobileId, apiKey: apiKey }, null, 2));
}

function usage(exit) {
  console.log('Usage: nexia-activate [--brand trane|nexia|asair] [--api-url URL] <activation_code>');
  console.log('');
  console.log('Default brand: trane (https://www.tranehome.com).');
  console.log('Get the 12-digit activation code from your account at:');
  console.log('  https://www.tranehome.com         (Trane Home users)');
  console.log('  https://www.mynexia.com           (legacy Nexia accounts)');
  console.log('  https://asairhome.com             (American Standard accounts)');
  console.log('by adding a new Mobile Device under your house, then "Get Activation Code".');
  process.exit(exit);
}

main().catch(e => { console.error(e); process.exit(2); });
