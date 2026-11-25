'use strict';
// NexiaClient against a stubbed global fetch. Nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { NexiaClient, NexiaHttpError } = require('../dist/nexia/client');

const BASE = 'https://www.tranehome.com/mobile/';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function withFetch(handler, fn) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = original; });
}
const client = (extra = {}) => new NexiaClient({ brand: 'trane', mobileId: 'mobile-id-123', apiKey: 'secret-key-456', houseId: '777', ...extra });
const zone = (features, extra = {}) => ({ id: 9, type: 'xxl_zone', name: 'Z', features, ...extra });
const act = (href, method) => ({ href, ...(method ? { method } : {}) });

test('S1: every request carries a timeout signal, and a hung connection fails fast with a clear message', async () => {
  await withFetch(() => json({ result: { _links: { child: [{ data: { items: [] } }] } } }), async (calls) => {
    await client().getHouse();
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  // AbortSignal.timeout's timer is deliberately unref'd, so something must keep the event loop alive while the
  // request hangs. In real use that is the open socket; here it is this interval.
  const socket = setInterval(() => {}, 1000);
  try {
    await withFetch(hang, async () => {
      const started = Date.now();
      await assert.rejects(client({ timeoutMs: 40 }).getHouse(), /timed out after 0\.04s/);
      assert.ok(Date.now() - started < 2000);
    });
  } finally {
    clearInterval(socket);
  }
});

test('errors: an HTTP status is kept on the error, network causes are named, credentials are not in messages', async () => {
  await withFetch(() => json({ error: 'nope' }, 401), async () => {
    await assert.rejects(client().getHouse(), e => e instanceof NexiaHttpError && e.status === 401 && !/secret-key-456|mobile-id-123/.test(e.message));
  });
  await withFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, async () => {
    await assert.rejects(client().getHouse(), /ENOTFOUND/);
  });
});

test('URLs: links from Nexia always end up on the configured host, over its scheme', () => {
  const c = client();
  const u = x => c.url(x);
  assert.equal(u('https://www.mynexia.com/mobile/xxl_zones/1/zone_mode'), BASE.replace('/mobile/', '') + '/mobile/xxl_zones/1/zone_mode', 'foreign brand host rewritten');
  assert.equal(u('http://www.tranehome.com/mobile/xxl_zones/1/zone_mode'), 'https://www.tranehome.com/mobile/xxl_zones/1/zone_mode', 'plain http is never used');
  assert.equal(u('https://evil.example/mobile/a?b=1#c'), 'https://www.tranehome.com/mobile/a?b=1#c');
  assert.equal(u('/mobile/xxl_zones/1/setpoints'), 'https://www.tranehome.com/mobile/xxl_zones/1/setpoints', 'root-relative link is not doubled');
  assert.equal(u('houses/777'), BASE + 'houses/777');
  assert.equal(u('/session'), BASE + 'session');
  assert.throws(() => u('https://'), /not a valid URL/);
});

test('URLs: an apiUrl override keeps its path prefix', () => {
  const c = client({ apiUrl: 'http://127.0.0.1:9/proxy/mobile' });
  assert.equal(c.baseUrl, 'http://127.0.0.1:9/proxy/mobile/');
  assert.equal(c.url('https://www.mynexia.com/mobile/xxl_zones/1/setpoints'), 'http://127.0.0.1:9/proxy/mobile/xxl_zones/1/setpoints');
  assert.equal(c.url('http://127.0.0.1:9/proxy/mobile/xxl_zones/1/setpoints'), 'http://127.0.0.1:9/proxy/mobile/xxl_zones/1/setpoints', 'already prefixed: not doubled');
});

test('credentials only ever go to the configured host, even when Nexia hands back a link elsewhere', async () => {
  const z = zone([{ name: 'thermostat', actions: { set_heat_setpoint: act('https://evil.example/mobile/xxl_zones/9/setpoints') } }]);
  await withFetch(() => json({}), async (calls) => {
    await client().setSetpoints(z, { heat: 70 });
    assert.equal(new URL(calls[0].url).host, 'www.tranehome.com');
    assert.equal(calls[0].init.headers['X-ApiKey'], 'secret-key-456');
  });
});

test('S8 setpoints: the XL actions come first (unchanged), then set_setpoints, then self; method is honored', async () => {
  const run = async (actions, thermostatId) => withFetch(() => json({}), async (calls) => {
    await client().setSetpoints(zone([{ name: 'thermostat', actions }]), { heat: 70, cool: 76 }, thermostatId);
    return calls[0];
  });

  const xl = await run({ set_heat_setpoint: act('https://x/mobile/xxl_zones/9/setpoints'), set_setpoints: act('https://x/mobile/other'), self: act('https://x/mobile/self') });
  assert.equal(xl.init.method, 'POST');
  assert.equal(xl.url, BASE + 'xxl_zones/9/setpoints', 'set_heat_setpoint wins, POST by default');
  assert.deepEqual(JSON.parse(xl.init.body), { heat: 70, cool: 76 });

  const cool = await run({ set_cool_setpoint: act('https://x/mobile/xxl_zones/9/setpoints') });
  assert.equal(cool.url, BASE + 'xxl_zones/9/setpoints');

  const named = await run({ set_setpoints: act('https://x/mobile/xxl_zones/9/setpoints', 'PUT'), self: act('https://x/mobile/self') });
  assert.equal(named.init.method, 'PUT');
  assert.equal(named.url, BASE + 'xxl_zones/9/setpoints');

  const self = await run({ self: act('https://x/mobile/xxl_zones/9/thing', 'put') });
  assert.equal(self.init.method, 'PUT', 'method is case-insensitive');
  assert.equal(self.url, BASE + 'xxl_zones/9/thing');
});

test('S8 setpoints: with no action at all it falls back to the conventional URL, qualified for small zone ids', async () => {
  const bare = zone([{ name: 'thermostat' }]);
  await withFetch(() => json({}), async (calls) => {
    await client().setSetpoints(bare, { cool: 74 }, 3001);
    assert.equal(calls[0].url, BASE + 'xxl_zones/3001_9/setpoints', 'zone ids under 256 repeat across thermostats (UX360)');
    await client().setSetpoints({ ...bare, id: 90001 }, { cool: 74 }, 3001);
    assert.equal(calls[1].url, BASE + 'xxl_zones/90001/setpoints');
    await client().setSetpoints(bare, { cool: 74 });
    assert.equal(calls[2].url, BASE + 'xxl_zones/9/setpoints', 'no thermostat id given: plain zone id');
  });
});

test('S8 setpoints: an unsupported method is refused rather than sent as POST', async () => {
  const z = zone([{ name: 'thermostat', actions: { set_setpoints: act('https://x/mobile/xxl_zones/9/setpoints', 'PATCH') } }]);
  await withFetch(() => json({}), async (calls) => {
    await assert.rejects(client().setSetpoints(z, { heat: 70 }), /unsupported method PATCH/);
    assert.equal(calls.length, 0);
  });
});

test('S8 mode: update_thermostat_mode first, then self, then the conventional URL (the XL path is unchanged)', async () => {
  await withFetch(() => json({}), async (calls) => {
    const xl = zone([{ name: 'thermostat_mode', actions: { update_thermostat_mode: act('https://x/mobile/xxl_zones/9/zone_mode', 'POST') } }]);
    await client().setZoneMode(xl, 'HEAT');
    assert.equal(calls[0].url, BASE + 'xxl_zones/9/zone_mode');
    assert.deepEqual(JSON.parse(calls[0].init.body), { value: 'HEAT' });

    await client().setZoneMode(zone([{ name: 'thermostat_mode', actions: { self: act('https://x/mobile/xxl_zones/9/mode') } }]), 'COOL');
    assert.equal(calls[1].url, BASE + 'xxl_zones/9/mode');

    await client().setZoneMode(zone([{ name: 'thermostat_mode' }]), 'AUTO', 3001);
    assert.equal(calls[2].url, BASE + 'xxl_zones/3001_9/zone_mode');
    assert.equal(calls[2].init.method, 'POST');
  });
});

// --- 1.1.4: one retry when the name lookup fails ---
const dnsFailure = (code = 'EAI_AGAIN') => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const emptyHouse = () => json({ result: { _links: { child: [{ data: { items: [] } }] } } });

test('1.1.4: a DNS failure is retried once, for reads and writes alike (nothing was sent the first time)', async () => {
  let n = 0;
  await withFetch(() => { if (n++ === 0) throw dnsFailure(); return emptyHouse(); }, async (calls) => {
    const house = await client({ retryDelayMs: 1 }).getHouse();
    assert.deepEqual(house.items, []);
    assert.equal(calls.length, 2);
  });

  n = 0;
  const z = zone([{ name: 'thermostat', actions: { set_heat_setpoint: act('https://x/mobile/xxl_zones/9/setpoints') } }]);
  await withFetch(() => { if (n++ === 0) throw dnsFailure(); return json({}); }, async (calls) => {
    await client({ retryDelayMs: 1 }).setSetpoints(z, { heat: 70 });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.init.method), ['POST', 'POST']);
    assert.deepEqual(calls.map(c => c.init.body), [JSON.stringify({ heat: 70 }), JSON.stringify({ heat: 70 })]);
  });
});

test('1.1.4: a second DNS failure gives up and says so; other failures are not retried', async () => {
  await withFetch(() => { throw dnsFailure(); }, async (calls) => {
    await assert.rejects(client({ retryDelayMs: 1 }).getHouse(), /EAI_AGAIN\) after one retry/);
    assert.equal(calls.length, 2);
  });
  await withFetch(() => { throw dnsFailure('ENOTFOUND'); }, async (calls) => {
    await assert.rejects(client({ retryDelayMs: 1 }).getHouse(), /ENOTFOUND/);
    assert.equal(calls.length, 2, 'ENOTFOUND is a lookup failure too');
  });
  await withFetch(() => { throw dnsFailure('ECONNRESET'); }, async (calls) => {
    await assert.rejects(client({ retryDelayMs: 1 }).getHouse(), /ECONNRESET/);
    assert.equal(calls.length, 1, 'a reset may have reached the server: never repeat it');
  });
  await withFetch(() => json({ error: 'boom' }, 500), async (calls) => {
    await assert.rejects(client({ retryDelayMs: 1 }).getHouse(), e => e instanceof NexiaHttpError && e.status === 500);
    assert.equal(calls.length, 1, 'an HTTP error is an answer, not a lookup failure');
  });
});
