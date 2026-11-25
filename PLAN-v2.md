# PLAN-v2: Confirm the UX360 fix, prove the write path, next improvements

Status: **DRAFT. Not approved for implementation, except B6**, which the owner approved on 2026-11-25 (to be released as 1.1.4). Agents must not start any other item until the owner approves it here.

Carried over from [PLAN-v1](docs/plans/archive/PLAN-v1.md), which is archived (released as v1.1.3).

## Open items

- [ ] B1 — **Confirm the UX360 fix with the reporter** (issue #1, which was closed when the fix merged). Wait for their `[debug]` line. Then replace `test/fixtures/ux360-zoned-cool.json` (currently synthetic, built from the reference implementation's keys) with a sanitized real payload, and fix anything it contradicts: setpoint keys, write actions (`set_setpoints` / `self` / PUT), zone ids. Reopen the issue if the tile still shows Off.
- [ ] B2 — **Exercise the write path on a real thermostat, with the owner's yes for each write.** The deadband handling in COOL/HEAT, the AUTO spread, and single-key writes were tested against fakes and mirror the reference implementation, but no write has been sent to a real thermostat by this code.
- [ ] B3 — **Decide about dropping Node 18 and 20 in the next major** (`engines.node` `^22.12.0 || ^24.0.0 || ^26.0.0`, `engines.homebridge` `^1.8.0 || ^2.0.0`). Both are end-of-life; the owner chose to keep them in 1.1.3.
- [ ] B4 — **Optional feature (minor release): Heating and Cooling threshold characteristics for AUTO mode**, instead of one target with a preserved spread.
- [ ] B5 — **Owner's hardening choices**: npm "Require two-factor authentication and disallow tokens" (no re-release needed); optionally a GitHub environment with a required reviewer for publishing.

- [x] B6 — **Quick-return writes and a DNS retry** (approved by the owner 2026-11-25, release 1.1.4). Evidence: Homebridge logged "This plugin slows down Homebridge ... write handler for 'Target Temperature' ... was slow to respond" (the write finished within the 9 s limit; no failure was logged), and a DNS failure (`EAI_AGAIN`) hit the NAS 29 s later. Reads from the cloud measured 0.2 to 0.6 s from the developer's Mac, so the slow part is the cloud write path or the NAS's DNS; either way a write handler must not hold HomeKit open. Design: `onSet` validates, applies locally and queues; one request at a time, in the order made, consecutive temperature changes merged; polls ignored while changes are pending; on failure roll back to the last confirmed state, log, and poll soon; one retry after `EAI_AGAIN`/`ENOTFOUND`. Trade-off accepted: no "No Response" for a change that fails after HomeKit was answered. **Verified (2026-11-25):** with real HAP-NodeJS and a fake Nexia that takes 4 s per write, 1.1.3 holds HomeKit's write open for 4005 ms and HAP logs `slow-write @3025ms: The write handler for the characteristic 'Target Temperature' on the accessory 'NativeZone' was slow to respond!` (the owner's line, word for word); the fix answers in 1 ms with no warning and the same `{"cool":73}` reaches Nexia. 102 tests pass on Node 22 and 24; six deliberate breakages of the compiled code (polls not ignored, drag not merged, queue not dropped on failure, temperature re-aimed at the current mode, DNS retry off, second poll chain) were each caught by the intended test. Final code run read-only against the owner's real XL824/XL850 payloads (getters only) and loaded in real Homebridge 2.5.0 and 1.11.4. **Still unproven:** how long a real write takes (never write to a real thermostat without the owner's yes), and the failure/rollback path against a real Nexia failure.

## Notes

- Every item needs a Product and a Technical section before it can be approved (see `CLAUDE.md`, "Agent pipeline").
- Version policy: patch for fixes, minor for a new option or accessory, major for anything that changes accessory identity or drops a Node/Homebridge major.
