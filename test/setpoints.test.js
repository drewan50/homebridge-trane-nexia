'use strict';
// planSetpoints: what to send for a temperature change (review S3 and S4).
const test = require('node:test');
const assert = require('node:assert/strict');
const { planSetpoints } = require('../dist/nexia/setpoints');

const limits = { deadband: 3, min: 55, max: 99 }; // what the real XL824/XL850 report, in °F
const plan = (o) => planSetpoints({ ...limits, ...o });

test('HEAT on the real XL shape (null cool setpoint): a single heat key, as the plugin always sent', () => {
  assert.deepEqual(plan({ mode: 'HEAT', target: 72, heat: 70, cool: null }), { heat: 72 });
  assert.deepEqual(plan({ mode: 'HEAT', target: 70, heat: 70, cool: null }), {}, 'unchanged: nothing to send');
});

test('HEAT: leaves the cool setpoint alone unless the deadband needs it moved', () => {
  assert.deepEqual(plan({ mode: 'HEAT', target: 72, heat: 68, cool: 78 }), { heat: 72 });
  assert.deepEqual(plan({ mode: 'HEAT', target: 77, heat: 70, cool: 75 }), { heat: 77, cool: 80 });
});

test('S3 COOL: a cooling target inside the deadband of the heat setpoint pulls heat down with it', () => {
  assert.deepEqual(plan({ mode: 'COOL', target: 70, heat: 68, cool: 75 }), { cool: 70, heat: 67 });
  assert.deepEqual(plan({ mode: 'COOL', target: 74, heat: 68, cool: 75 }), { cool: 74 });
  assert.deepEqual(plan({ mode: 'COOL', target: 74, heat: null, cool: 75 }), { cool: 74 }, 'no heat setpoint to move');
});

test('S4 AUTO: the user\'s spread is kept exactly, and re-setting the displayed target changes nothing', () => {
  // 68/75 is a spread of 7 and shows as 71.5 F, which the Home app can only send back as 71 F.
  assert.deepEqual(plan({ mode: 'AUTO', target: 71, heat: 68, cool: 75 }), {}, 'no drift');
  assert.deepEqual(plan({ mode: 'AUTO', target: 73, heat: 68, cool: 75 }), { heat: 70, cool: 77 });

  let state = { heat: 68, cool: 75 };
  for (const target of [72, 73, 74, 75, 76]) {
    state = { ...state, ...plan({ mode: 'AUTO', target, ...state }) };
    assert.equal(state.cool - state.heat, 7, `spread after ${target}`);
  }
});

test('AUTO: a spread narrower than the deadband is widened to it', () => {
  assert.deepEqual(plan({ mode: 'AUTO', target: 70, heat: 70, cool: 71 }), { heat: 69, cool: 72 });
});

test('limits: targets are clamped, and the pair is shifted to stay inside them', () => {
  assert.deepEqual(plan({ mode: 'HEAT', target: 120, heat: 70, cool: null }), { heat: 99 });
  assert.deepEqual(plan({ mode: 'COOL', target: 50, heat: 68, cool: 75 }), { cool: 58, heat: 55 });
  assert.deepEqual(plan({ mode: 'AUTO', target: 56, heat: 68, cool: 75 }), { heat: 55, cool: 62 });
  assert.deepEqual(plan({ mode: 'AUTO', target: 98, heat: 68, cool: 75 }), { heat: 92, cool: 99 });
});

test('no limits reported: nothing is clamped', () => {
  assert.deepEqual(planSetpoints({ mode: 'COOL', target: 20, heat: 19, cool: 24, deadband: 1.5, min: null, max: null }), { cool: 20, heat: 18.5 });
});

test('when no valid pair fits inside the limits it throws instead of sending something invalid', () => {
  assert.throws(() => planSetpoints({ mode: 'AUTO', target: 70, heat: 70, cool: 71, deadband: 3, min: 70, max: 71 }), RangeError);
});
