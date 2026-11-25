# PLAN-v2: Confirm the UX360 fix, prove the write path, next improvements

Status: **DRAFT. Not approved for implementation.** Agents must not start any item below until the owner approves it here.

Carried over from [PLAN-v1](docs/plans/archive/PLAN-v1.md), which is archived (released as v1.1.3).

## Open items

- [ ] B1 — **Confirm the UX360 fix with the reporter** (issue #1, which was closed when the fix merged). Wait for their `[debug]` line. Then replace `test/fixtures/ux360-zoned-cool.json` (currently synthetic, built from the reference implementation's keys) with a sanitized real payload, and fix anything it contradicts: setpoint keys, write actions (`set_setpoints` / `self` / PUT), zone ids. Reopen the issue if the tile still shows Off.
- [ ] B2 — **Exercise the write path on a real thermostat, with the owner's yes for each write.** The deadband handling in COOL/HEAT, the AUTO spread, and single-key writes were tested against fakes and mirror the reference implementation, but no write has been sent to a real thermostat by this code.
- [ ] B3 — **Decide about dropping Node 18 and 20 in the next major** (`engines.node` `^22.12.0 || ^24.0.0 || ^26.0.0`, `engines.homebridge` `^1.8.0 || ^2.0.0`). Both are end-of-life; the owner chose to keep them in 1.1.3.
- [ ] B4 — **Optional feature (minor release): Heating and Cooling threshold characteristics for AUTO mode**, instead of one target with a preserved spread.
- [ ] B5 — **Owner's hardening choices**: npm "Require two-factor authentication and disallow tokens" (no re-release needed); optionally a GitHub environment with a required reviewer for publishing.

## Notes

- Every item needs a Product and a Technical section before it can be approved (see `CLAUDE.md`, "Agent pipeline").
- Version policy: patch for fixes, minor for a new option or accessory, major for anything that changes accessory identity or drops a Node/Homebridge major.
