# PLAN-v1: Modernize, fix issue #1, review

Status: Iteration A approved for implementation 2026-11-25 (owner request in chat: update dependencies, review and fix GitHub issue #1, run a lead-engineer review). Lead-engineer review 2026-11-25: returned with 3 Must-fix items; applied in A3 (a re-review before release is recommended). Owner decisions 2026-11-25: fix everything from the review (A4); keep Node 18/20; publish from GitHub Actions (A5); version 1.1.3; reply on issue #1 (posted). Release not yet approved.

Owner-directed scope; items are small and ordered. The lead-engineer reviews the whole iteration after A2 (item A3 is filled from that review). The release itself follows [docs/ops/RELEASE.md](docs/ops/RELEASE.md) and needs the owner's yes.

## Product

**Problem.** [Issue #1](https://github.com/drewan50/homebridge-trane-nexia/issues/1): a user with an American Standard **UX360** sees the thermostat as "Off" in Apple Home although it is set to Cool. They also could not turn on debug logging: the README says to put `"debug": true` in config, they typed it in the Homebridge terminal.

**Findings that shape the product work**
1. The plugin's `debug: true` does nothing on a normal install. It calls `log.debug`, which Homebridge drops unless Homebridge itself runs in debug mode (`node_modules/homebridge` `Logger.debugEnabled`, default false). Reproduced: 0 `[nexia]` lines with `debug: true` and no `-D`; the lines appear with `-D`.
2. The plugin reads the zone mode only from `zone.current_zone_mode` (true for the owner's XL824/XL850) and maps anything else, including a missing value, to OFF. The reference implementation (`bdraco/nexia`, used by Home Assistant) reads the mode from `zone.settings[type=zone_mode].current_value`, then the `thermostat_mode` feature, then thermostat-level settings, and handles UX360 specially (`zone_status`, `thermostat_run_mode`, non-unique zone ids). **Not yet verified against a real UX360 payload**; this is the leading hypothesis, not a confirmed cause.
3. For current state the plugin uses the thermostat-wide `system_status`; on zoned systems the reference uses per-zone `zone_status`.

**Behavior we want.** A mode the plugin cannot read never shows as Off: the tile keeps the last known value, or shows "No Response" if there never was one, and the log says once, in plain words, which fields it saw. `debug: true` works without touching Homebridge's own setting. The README tells users where to set it and what to paste into an issue.

## Technical plan

Verified against: `node_modules/homebridge` (v2.5.0) `Logger.log` drops debug unless `debugEnabled`; Homebridge 1.11.4 and 2.5.0 both export `HAPStatus` at runtime; `bdraco/nexia` `zone.py` / `thermostat.py` / `const.py` (v2.13.0) for the lookup order above; npm registry and nodejs.org dist index (2026-11-25) for versions; Homebridge 2.5.0 `engines.node` = `^22.12.0 || ^24 || ^26`.

### Decisions

- **2026-11-25 — TypeScript 7.0.2.** `moduleResolution: node10` is removed in 7; `module: node16` fails because Homebridge 2.x is an ESM package and we `import type` from a CommonJS file (TS1541). Use `module: commonjs` + `moduleResolution: bundler`. Output is byte-identical to TS 5.9 except that `HAPStatus` is now referenced at runtime instead of inlined; verified present at runtime in Homebridge 1.11.4 and 2.5.0. Rejected: converting the plugin to ESM (breaking, owner decision), `resolution-mode` attributes in five files (noise).
- **2026-11-25 — Homebridge devDependency 2.5.0.** Types compile against 2.x, which also proves we use no API removed in 2.0. `engines.homebridge` stays `>=1.8.0` (covers 1.x and 2.x); runtime load verified in real Homebridge 1.11.4 (Node 22) and 2.5.0 (Node 22, 24).
- **2026-11-25 — Remove `rimraf`.** Only used by `clean`; Node's `fs.rmSync` does it. Clears all four audit findings (all came from rimraf → glob → minimatch → brace-expansion) and keeps the dependency list minimal.
- **2026-11-25 — `@types/node` stays on the 22.x line (22.20.7).** Types should match the oldest runtime we actually build against; Homebridge 2 requires Node ≥ 22.12 and the owner's NAS runs 22. 26.x would silently allow APIs missing on 22. Open: see the Node 18/20 decision below.
- **2026-11-25 — CI builds once on Node 24, then smoke-loads the compiled plugin on each runtime major (18, 20, 22, 24, 26).** The new devDependencies need Node ≥ 22.12, so building the toolchain on 18/20 no longer proves anything; what users run is `dist/`. Actions bumped to v7; `permissions: contents: read`.
- **2026-11-25 — Keep Node 18 and 20 in `engines` (owner decision; `>=18.0.0` unchanged).** The lead-engineer's evidence: Homebridge Verified requires only the supported LTS versions (22, 24, 26, wiki updated 2026-11-01), so 18/20 are optional; Homebridge 1.11.x still lists them and the plugin runs there; Homebridge 2.5 needs ≥ 22.12. CI keeps testing 18 and 20. Revisit in a future major with `engines.node` `^22.12.0 || ^24.0.0 || ^26.0.0`, `engines.homebridge` `^1.8.0 || ^2.0.0`.
- **2026-11-25 — Version for the next release: 1.1.3 (patch), approved by the owner.** A3/A4 add no option and don't change `engines`: everything in `[Unreleased]` is a fix, diagnostics or tooling, with no accessory identity change. "No Response" instead of a false "Off" is a bug fix, not a breaking change. 1.2.0 if an option or accessory is added; 2.0.0 if Node 18/20 are dropped.
- **2026-11-25 — Setpoints.** Read `heating_setpoint` / `cooling_setpoint` first (what the real XL824/XL850 use; verified with a keys-only read-only probe, which also showed a legitimately `null` `cooling_setpoint` in HEAT mode and an empty `zone_status` on the NativeZone), then fall back to `zone.setpoints.heat/cool` (what the reference reads for every model, and which the XL zones also carry). Unreadable setpoints are never turned into a number; a write is refused when no setpoint is readable.
- **2026-11-25 — Accessory removal needs ≥ 3 consecutive misses over ≥ 5 minutes, and never happens on an empty thermostat list.** Unregistering costs users their Home rooms, scenes and automations and re-adding does not restore them (review M3).
- **2026-11-25 — Tests: Node's built-in `node:test`, plain-JS test files in `test/` (already excluded from `tsc`) against the compiled `dist/`, fixtures in `test/fixtures/`.** No dev dependency, nothing ships (`files` allowlist). Fixtures are synthetic, modeled on the owner's XL824 shape and on the reference implementation's UX360 keys; the UX360 fixture is labeled unverified until the reporter supplies a sanitized payload.
- **2026-11-25 — Unknown input policy.** An unrecognized or missing zone mode never becomes OFF: keep the last known good value; with none, answer `onGet` with `SERVICE_COMMUNICATION_FAILURE` ("No Response"); warn once per distinct raw value.

### Iteration A

- [x] A0 — Port the agents and working style from the maintenance site
  - `.claude/agents/{product-designer,lead-engineer,senior-engineer}.md` rewritten for TypeScript / Homebridge / Nexia; `CLAUDE.md`; `.gitignore` shares `.claude/agents/`; this plan; `docs/ops/RELEASE.md`.

- [x] A1 — Update dependencies, tsconfig and CI
  - **Goal:** current toolchain, zero audit findings, no behavior change for users.
  - **Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `.github/workflows/build.yml`.
  - **Acceptance:** `npm ci` + `npm run build` clean on Node 24; `npm audit` 0; `npm pack --dry-run` ships only the allowlist; compiled output equivalent to the TS 5.9 build; plugin loads, registers, polls and creates accessories inside real Homebridge 1.11.4 and 2.5.0.
  - **Verified:** all of the above locally (Node 22.23.5 and 24.22.3). **Left for CI:** Node 18, 20 and 26 smoke legs; the owner's NAS install.

- [x] A2 — Fix issue #1: resolve zone mode and activity from every known payload location; make `debug` work
  - **Verified:** 19 `node:test` cases pass on Node 22.23.5 and 24.22.3 (CI runs them on 18, 20, 22, 24, 26). The tests caught a real bug in my first cut (an empty payload never warned). In real Homebridge 2.5.0 and 1.11.4 (no `-D`), a UX360-shaped payload resolves `mode=COOL`, per-zone activity cooling/idle, and `[nexia]`/`[debug]` lines appear. **Not verified:** against a real UX360 payload (none available), on the owner's NAS, or how the Home app renders "No Response". The fixture shape is derived from the reference implementation, not captured.
  - **Goal:** a UX360 (and any model whose mode lives outside `current_zone_mode`) shows the right mode, and the log can say why when it cannot.
  - **Files:** `src/nexia/types.ts`, new `src/nexia/zoneState.ts` (pure functions), `src/thermostatAccessory.ts`, `src/nexia/client.ts`, `config.schema.json`, `README.md`, `CHANGELOG.md`, `test/`.
  - **Depends on:** A1.
  - **Acceptance:**
    1. Mode resolution order: `current_zone_mode` (unchanged for XL824/XL850), then `settings[zone_mode].current_value`, then `thermostat_mode` feature `value`, then thermostat `settings[system_mode|mode].current_value`; case-insensitive; only OFF/HEAT/COOL/AUTO accepted.
    2. Unrecognized/missing mode: last known good kept, else "No Response"; one warning naming the raw values. Setting a temperature with an unknown mode fails visibly instead of being silently ignored.
    3. Activity (CurrentHeatingCoolingState) prefers per-zone `zone_status` when present, then `system_status`, then the existing mode/setpoint inference; existing XL behavior unchanged.
    4. With `debug: true`, request lines and a per-zone state summary are logged at info level (visible without Homebridge `-D`); no credentials in any log line.
    5. README troubleshooting says where `debug` goes (Homebridge UI plugin settings or the platform block in `config.json`, not the terminal) and what to paste into an issue.
  - **Tests:** `node:test` cases for mode and activity resolution (XL824-shaped, UX360-shaped, lowercase, unknown, missing); run in CI on every Node major.
  - **Notes/risks:** fix is evidence-based but unverified against a real UX360. Ask the reporter for the `[debug]` log lines (draft reply in the chat summary; posting needs the owner's yes).

- [x] A3 — Fixes from the lead-engineer review (Must-fix, plus the two cheap items that protect A2's claims)
  - **M1 (A2 exposure):** in AUTO mode, setpoints reported only under `zone.setpoints` became 20 °C on read and a `{"heat":null,"cool":null}` write. Now `resolveSetpoints` (finite numbers only), "No Response" or the last known target when none is readable, and a write is refused when no setpoint is readable or the payload isn't finite.
  - **M2:** `pollInterval` of `"30s"` or a huge number made `setTimeout` fire after 1 ms (a tight polling loop against the vendor). Now `normalizePollSeconds` (10 to 600, default 30) with a warning.
  - **M3:** one empty or partial poll unregistered accessories (cost: Home rooms, scenes, automations). Now: never on an empty thermostat list; otherwise only after ≥ 3 consecutive misses over ≥ 5 minutes; the outdoor sensor stays while the thermostat still advertises one.
  - **S6 (cheap, protects A2's "XL unchanged" claim):** a NativeZone ignores `zone_status`, as the reference does. The real XL824/XL850 report `zone_status: ""`, so it was not occurring.
  - **S7:** `prepublishOnly` is now `clean && test`, so a stale `dist/` file can't ship.
  - Also: the `[debug]` line shows the model from `advanced_info` (the real XL824/XL850 report `type: "xxl_thermostat"`).
  - **Verified:** each fix has a regression test that failed before it and passes after (13 new tests; 34 total, Node 22 and 24); real Homebridge 2.5.0 (Node 24) and 1.11.4 (Node 22) with XL-shaped and UX360-shaped payloads. **Not verified:** a real UX360, the owner's NAS, CI on Node 18/20/26.

- [x] A4 — Everything else from the review (the owner asked for all of it)
  - **S1** `AbortSignal.timeout(15 s)` on every request and on `activate`; timeouts and network causes (`ENOTFOUND`, ...) named in the error.
  - **S2** `pollOnce()` backs off 2x per failure up to 10 minutes (a rejected key goes straight there), logs the first failure at error, the same one again only every 10th time, a changed one when it changes, recovery once, and a 401/403 says to run `nexia-activate` again.
  - **S3** `planSetpoints` (new, pure): COOL/HEAT move the other setpoint out of the way by the deadband, targets clamped to the thermostat limits, impossible pairs refused. Single-key writes stay single-key when nothing conflicts (the real XL: `set_heat_setpoint`, deadband 3, limits 55..99, null cool in HEAT mode).
  - **S4** AUTO keeps the user's spread exactly (floor/ceil split), widens only to the deadband, and sends nothing when the result equals what is set. Exposing Heating/Cooling threshold characteristics is a feature (a minor release) and is deliberately not included.
  - **S5** Missing current temperature, humidity and outdoor reading: last known value, else "No Response" (never 20 C or 0 %).
  - **S8** `findAction`: XL actions first, then `set_setpoints`, then `self`; the action's `method` (POST/PUT) is honored, any other is refused; with no action the conventional `xxl_zones/<id>/<endpoint>` URL, qualified `<thermostat>_<zone>` for small zone ids (UX360), as the reference does. **Unverified on a real UX360.**
  - **Nice** (all done): HAP default value moved inside the range before `setProps`; one scale lookup for thermostat and outdoor sensor (zone feature, thermostat feature, thermostat `scale` setting); mode-source order follows the reference's zoned/non-zoned rule (zoned = non-empty `zone.settings`); warning re-armed after a recovery; `url()` always rebuilds on the configured origin (http-same-host, `apiUrl` prefix and root-relative links fixed); a poll that started before a write is ignored; Off zone is idle; mode change refreshes the target; Off-mode ignore logged at info; source maps no longer shipped; CI builds once and tests per Node.
  - **Verified:** 87 tests (34 before A3/A4) pass on Node 22 and 24 with none cancelled (running Node 22 caught a test that hung because `AbortSignal.timeout`'s timer is unref'd; fixed in the test), each new behavior with a test; 8 of the 9 new client tests fail against the old client (the ninth is the control). The final accessory code was run **read-only against your real XL824/XL850 payloads** (getters only): mode HEAT/HEAT, real temperatures and humidity, no warnings, no HAP range warning, and the same activity as the old rule. **Not verified:** writes on a real thermostat (we never write without the owner's yes: the deadband/AUTO write logic is tested against fakes and mirrors the reference), a real UX360, the NAS, CI on Node 18/20/26.

- [ ] A5 — Publish from GitHub Actions (code done; the rest is the owner's)
  - **Built:** `.github/workflows/release.yml` (tag `vX.Y.Z` push, or manual *Run workflow* with *publish*; manual without publish is a rehearsal), reusing the CI gate (`build.yml` as a reusable workflow, Node 18/20/22/24/26) and `scripts/release.js` (`prepare`, `check`, `notes`, tested). npm trusted publishing (OIDC, provenance), GitHub release created from the changelog, idempotent on re-run, refuses commits not on `main`, a tag on another commit, a lockfile out of sync, a non-empty `[Unreleased]`. Runbook: `docs/ops/RELEASE.md`.
  - **Owner steps (cannot be done by an agent):** merge to `main`; rehearse; create the npm Trusted Publisher entry (owner `drewan50`, repo `homebridge-trane-nexia`, workflow `release.yml`, publishing allowed) **within 2 days of the first publish**; run the first release; then optionally "disallow tokens" on npm, a `v*` tag ruleset, and a required-reviewer environment.
  - **Not verifiable here:** the workflow has never run (GitHub only runs it from `main`), and OIDC publishing can only be proven by the first real run. YAML validated, every pinned action tag checked to exist, the helper scripts and the version-bump preview tested locally.
  - **Release prepared?** No, deliberately: `[Unreleased]` is still open and the version is 1.1.2. After the pipeline PR merges, `node scripts/release.js prepare 1.1.3` goes in its own small `release-1.1.3` PR, on the owner's go-ahead (docs/ops/RELEASE.md, "First release").

### Discovered

- Pre-existing HAP warning on every start, on Homebridge 1.x and 2.x, **visible only with Homebridge `-D`** (confirmed: absent without it): `Characteristic 'Target Temperature': … number 10 exceeded minimum of 12.8` (`thermostatAccessory.ts:53`: `setProps` while the characteristic still holds HAP's default of 10). Low severity; for the review to rank.
- UX360 setpoints (resolved in A3, see Decisions): the plugin read only the top-level keys while the reference reads `zone.setpoints` for every model. Real XL zones carry both. Still to confirm with the reporter's payload that a UX360 carries at least one.
