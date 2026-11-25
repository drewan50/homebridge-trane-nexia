'use strict';
// Platform behavior: poll interval sanitizing and accessory lifecycle, against the stand-ins in helpers.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TraneNexiaPlatform } = require('../dist/platform');
const settings = require('../dist/settings');
const { Characteristic, Service, HapStatusError, HAPStatus, makeAccessory, makeLog } = require('./helpers');

const clone = o => JSON.parse(JSON.stringify(o));
const xl824 = () => clone(require('./fixtures/xl824-cool.json'));
const ux360 = () => clone(require('./fixtures/ux360-zoned-cool.json'));
const MIN = 60 * 1000;

test('M2: a bad pollInterval can never make the plugin poll in a tight loop', () => {
  const n = settings.normalizePollSeconds;
  assert.equal(n(undefined), 30);
  assert.equal(n(null), 30);
  assert.equal(n(''), 30);
  assert.equal(n('30s'), 30, 'not a number: default, not NaN (setTimeout(NaN) fires after 1 ms)');
  assert.equal(n(NaN), 30);
  assert.equal(n(Infinity), 600);
  assert.equal(n(5), 10);
  assert.equal(n(0), 10);
  assert.equal(n(-20), 10);
  assert.equal(n('45'), 45);
  assert.equal(n(45.7), 45.7);
  assert.equal(n(3000000), 600, 'above 2^31-1 ms would also fire after 1 ms');
});

function buildPlatform(config = {}) {
  const { logs, log } = makeLog();
  const registered = [];
  const unregistered = [];
  const api = {
    hap: { Service, Characteristic, HapStatusError, HAPStatus, uuid: { generate: s => `uuid(${s})` } },
    on() {},
    platformAccessory: function (name, uuid) { return makeAccessory(name, uuid); },
    registerPlatformAccessories: (p, n, a) => registered.push(...a),
    unregisterPlatformAccessories: (p, n, a) => unregistered.push(...a),
  };
  const platform = new TraneNexiaPlatform(log, { brand: 'trane', mobileId: 'm', apiKey: 'k', ...config }, api);
  let house;
  let clock = 1_000_000;
  platform.nexia = { options: { mobileId: 'm', apiKey: 'k' }, baseUrl: 'http://127.0.0.1/', getHouse: async () => house };
  platform.now = () => clock;
  return {
    platform, logs, registered, unregistered,
    setHouse: h => { house = h; },
    advance: ms => { clock += ms; },
    poll: () => platform.refresh(),
  };
}
const fullHouse = () => ({ id: 777, items: [xl824(), ux360()] });
const removedNames = h => h.unregistered.map(a => a.displayName);

test('M3: a poll that returns no thermostats never removes accessories', async () => {
  const h = buildPlatform();
  h.setHouse(fullHouse());
  await h.poll();
  assert.equal(h.registered.length, 4, 'xl824 zone + two ux360 zones + outdoor sensor');

  h.setHouse({ id: 777, items: [] });
  for (let i = 0; i < 6; i++) { h.advance(10 * MIN); await h.poll(); }
  assert.deepEqual(removedNames(h), []);
  assert.equal(h.logs.warn.filter(l => /no thermostats/i.test(l)).length, 1, 'said once, not every poll');
});

test('M3: a thermostat that is missing briefly is kept; one that is really gone is removed', async () => {
  const h = buildPlatform();
  h.setHouse(fullHouse());
  await h.poll();

  const without = fullHouse();
  without.items = without.items.filter(t => t.id !== 3001); // the UX360 drops out
  h.setHouse(without);

  await h.poll();                               // miss 1
  h.advance(30 * 1000); await h.poll();         // miss 2
  assert.deepEqual(removedNames(h), [], 'two quick misses are not enough');

  h.advance(6 * MIN); await h.poll();           // miss 3, and more than 5 minutes since the first
  assert.deepEqual(removedNames(h).sort(), ['Bedroom', 'Living Room']);
});

test('M3: many polls are not enough without enough time, and enough time is not enough without enough polls', async () => {
  const quickMisses = buildPlatform();
  quickMisses.setHouse(fullHouse());
  await quickMisses.poll();
  const without = fullHouse();
  without.items = [without.items[0]];
  quickMisses.setHouse(without);
  for (let i = 0; i < 10; i++) { quickMisses.advance(10 * 1000); await quickMisses.poll(); } // 10 polls in 100 s
  assert.deepEqual(removedNames(quickMisses), []);

  const fewMisses = buildPlatform();
  fewMisses.setHouse(fullHouse());
  await fewMisses.poll();
  fewMisses.setHouse(without);
  await fewMisses.poll();
  fewMisses.advance(10 * MIN); await fewMisses.poll(); // only 2 misses, 10 minutes apart
  assert.deepEqual(removedNames(fewMisses), []);
});

test('M3: an accessory that comes back resets its miss count', async () => {
  const h = buildPlatform();
  h.setHouse(fullHouse());
  await h.poll();
  const without = fullHouse();
  without.items = [without.items[0]];

  h.setHouse(without); await h.poll(); h.advance(MIN); await h.poll();   // 2 misses
  h.setHouse(fullHouse()); h.advance(MIN); await h.poll();               // back
  h.setHouse(without); h.advance(MIN); await h.poll();                   // 1 miss again
  h.advance(10 * MIN); await h.poll();                                   // 2nd miss of the new streak
  assert.deepEqual(removedNames(h), []);
});

test('M3: the outdoor sensor is not removed while the thermostat still reports one, even with no reading', async () => {
  const h = buildPlatform();
  h.setHouse(fullHouse());
  await h.poll();
  assert.ok(h.registered.some(a => a.displayName === 'Outdoor Temperature'));

  const noReading = fullHouse();
  noReading.items[0].outdoor_temperature = null; // has_outdoor_temperature stays true
  h.setHouse(noReading);
  for (let i = 0; i < 6; i++) { h.advance(10 * MIN); await h.poll(); }
  assert.deepEqual(removedNames(h), []);
});

// --- Added with the A4 fixes ---
const { NexiaHttpError } = require('../dist/nexia/client');

test('S2: poll delay doubles per failure up to ten minutes; a rejected key goes straight to the cap', () => {
  const d = settings.nextPollDelayMs;
  assert.equal(d(30000, 0), 30000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(n => d(30000, n)), [60000, 120000, 240000, 480000, 600000, 600000, 600000]);
  assert.equal(d(30000, 1, true), 600000);
  assert.equal(d(900000, 1), 900000, 'never faster than the configured interval');
});

test('S2: a failing poll logs once, reminds every 10th time, backs off, and says when it recovers', async () => {
  const h = buildPlatform();
  h.setHouse(fullHouse());
  assert.equal(await h.platform.pollOnce(), 30000, 'healthy: the normal interval');

  h.platform.nexia.getHouse = async () => { throw new Error('connection reset'); };
  const delays = [];
  for (let i = 0; i < 9; i++) delays.push(await h.platform.pollOnce());
  assert.deepEqual(delays.slice(0, 5), [60000, 120000, 240000, 480000, 600000]);
  assert.equal(h.logs.error.length, 1, 'nine identical failures: one error line');
  assert.match(h.logs.error[0], /Nexia poll failed: connection reset/);

  await h.platform.pollOnce();
  assert.equal(h.logs.error.length, 2);
  assert.match(h.logs.error[1], /still failing after 10 polls/);

  h.platform.nexia.getHouse = async () => fullHouse();
  assert.equal(await h.platform.pollOnce(), 30000, 'recovered: back to normal');
  assert.ok(h.logs.info.some(l => /reachable again after 10 failed polls/.test(l)));
});

test('S2: a different failure is reported when it changes', async () => {
  const h = buildPlatform();
  h.platform.nexia.getHouse = async () => { throw new Error('timeout'); };
  await h.platform.pollOnce();
  await h.platform.pollOnce();
  h.platform.nexia.getHouse = async () => { throw new Error('HTTP 502'); };
  await h.platform.pollOnce();
  assert.equal(h.logs.error.length, 2);
});

test('S2: a rejected Mobile ID / API Key gets an actionable message and the long delay', async () => {
  const h = buildPlatform();
  h.platform.nexia.getHouse = async () => { throw new NexiaHttpError(401, 'Nexia GET ... -> HTTP 401'); };
  assert.equal(await h.platform.pollOnce(), 600000);
  assert.equal(h.logs.error.length, 1);
  assert.match(h.logs.error[0], /rejected the Mobile ID \/ API Key \(HTTP 401\)/);
  assert.match(h.logs.error[0], /nexia-activate/);
  assert.doesNotMatch(h.logs.error[0], /apiKey|mobileId/i);
});

test('race: a thermostat handler is told when its poll started', async () => {
  const h = buildPlatform();
  h.setHouse(fullHouse());
  await h.poll();
  const seen = [];
  const handler = [...h.platform.handlers.values()].find(x => x.constructor.name === 'ThermostatAccessory');
  const original = handler.update.bind(handler);
  handler.update = (t, z, polledAt) => { seen.push(polledAt); return original(t, z, polledAt); };
  h.advance(60_000);
  await h.poll();
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0], 'number');
});

// --- 1.1.4: scheduler and "poll again soon" ---
test('1.1.4: requestPollSoon asks for a poll in about a second; not before the poller starts, while one runs, or after shutdown', () => {
  const h = buildPlatform();
  const delays = [];
  h.platform.scheduleNextPoll = ms => delays.push(ms);

  h.platform.requestPollSoon();
  assert.deepEqual(delays, [], 'poller not started');

  h.platform.pollingEnabled = true;
  h.platform.requestPollSoon();
  assert.deepEqual(delays, [1000]);

  h.platform.polling = true;
  h.platform.requestPollSoon();
  assert.deepEqual(delays, [1000], 'a running poll will schedule the next one itself');

  h.platform.polling = false;
  h.platform.stopping = true;
  h.platform.requestPollSoon();
  assert.deepEqual(delays, [1000], 'shut down');
});

test('1.1.4: there is only ever one poll chain: scheduling again replaces the pending timer', async () => {
  const h = buildPlatform();
  let polls = 0;
  // Each poll ends the chain (stopping), so a broken implementation can't leave long timers running after the assertion.
  h.platform.pollOnce = async () => { polls += 1; h.platform.stopping = true; return 60_000; };
  try {
    h.platform.scheduleNextPoll(5);
    h.platform.scheduleNextPoll(5);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(polls, 1);
  } finally {
    h.platform.stop(); // always: otherwise a failing assertion would leave a poll chain running and hang the test run
  }
});

test('1.1.4: schedule runs a function later and returns a canceller', async () => {
  const h = buildPlatform();
  let ran = [];
  const cancel = h.platform.schedule(() => ran.push('cancelled'), 10);
  h.platform.schedule(() => ran.push('kept'), 10);
  cancel();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(ran, ['kept']);
});
