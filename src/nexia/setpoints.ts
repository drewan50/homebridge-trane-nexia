// Pure planning of a setpoint write. No Homebridge imports, so it can be tested directly.
//
// Mirrors the reference implementation (github.com/bdraco/nexia, zone.set_heat_cool_temp): the heat and
// cool setpoints must stay at least the thermostat's deadband apart, and when the user moves one the
// other is moved out of the way. Unlike the reference we only send the key(s) that actually change, which
// keeps the single-key writes the XL824/XL850 have always received (the XL reports a null cool setpoint in
// HEAT mode, and a null counterpart is never touched).

export interface SetpointPlanInput {
  mode: 'HEAT' | 'COOL' | 'AUTO';
  /** The wanted temperature in the thermostat's own scale, already rounded. */
  target: number;
  /** Current setpoints in the same scale; null where the thermostat reports none. */
  heat: number | null;
  cool: number | null;
  /** Minimum gap between heat and cool (the thermostat's `setpoint_delta`). */
  deadband: number;
  /** The thermostat's limits, or null when it reports none. */
  min: number | null;
  max: number | null;
}

export interface SetpointPlan {
  heat?: number;
  cool?: number;
}

/** What to send, or `{}` when nothing would change. Throws a RangeError when no valid pair exists inside
 *  the limits (the caller must refuse the write rather than send something invalid). */
export function planSetpoints(input: SetpointPlanInput): SetpointPlan {
  const { mode, heat, cool } = input;
  const deadband = Number.isFinite(input.deadband) && input.deadband > 0 ? input.deadband : 0;
  const lo = input.min ?? -Infinity;
  const hi = input.max ?? Infinity;
  const target = Math.min(hi, Math.max(lo, input.target));

  let newHeat: number | null = heat;
  let newCool: number | null = cool;

  if (mode === 'HEAT') {
    newHeat = target;
    if (newCool !== null && newCool < newHeat + deadband) newCool = newHeat + deadband;
    if (newCool !== null && newCool > hi) {
      newCool = hi;
      newHeat = Math.min(newHeat, newCool - deadband);
    }
  } else if (mode === 'COOL') {
    newCool = target;
    if (newHeat !== null && newHeat > newCool - deadband) newHeat = newCool - deadband;
    if (newHeat !== null && newHeat < lo) {
      newHeat = lo;
      newCool = Math.max(newCool, newHeat + deadband);
    }
  } else {
    // AUTO: keep the user's current spread exactly (never narrower than the deadband), split around the target.
    const spread = Math.max(deadband, heat !== null && cool !== null ? cool - heat : deadband);
    const below = Math.floor(spread / 2);
    newHeat = target - below;
    newCool = target + (spread - below);
    if (newHeat < lo) {
      const shift = lo - newHeat;
      newHeat += shift;
      newCool += shift;
    }
    if (newCool > hi) {
      const shift = newCool - hi;
      newHeat -= shift;
      newCool -= shift;
    }
  }

  if (newHeat !== null && newHeat < lo) throw new RangeError(`heat setpoint ${newHeat} is below the thermostat minimum ${lo}`);
  if (newCool !== null && newCool > hi) throw new RangeError(`cool setpoint ${newCool} is above the thermostat maximum ${hi}`);
  if (newHeat !== null && newCool !== null && newCool - newHeat < deadband) {
    throw new RangeError(`no valid heat/cool pair for target ${input.target} with a deadband of ${deadband} inside ${lo}..${hi}`);
  }

  const plan: SetpointPlan = {};
  if (newHeat !== null && newHeat !== heat) plan.heat = newHeat;
  if (newCool !== null && newCool !== cool) plan.cool = newCool;
  return plan;
}
