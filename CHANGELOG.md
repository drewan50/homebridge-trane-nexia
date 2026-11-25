# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Changing the temperature or mode in the Home app no longer makes Homebridge log "This plugin slows down Homebridge ... write handler ... was slow to respond". Writes used to hold the Home app's request open for the whole round trip to the thermostat, which can take several seconds. The Home app is now answered immediately and the change is sent to Nexia in the background. Changes made in quick succession (dragging the slider) are merged so only the last value is sent, one request is in flight at a time, and changes are sent in the order they were made, each temperature change keeping the mode it was made under. Polls that arrive while a change is waiting are ignored, so the tile no longer flickers back and forth. If a change cannot be sent, the tile goes back to what the thermostat last confirmed, the error is logged, and the plugin re-reads the thermostat right away. The trade-off: the Home app can no longer show "No Response" for a change that fails later, because it has already been answered.
- A change that is still waiting out its short pause when Homebridge shuts down is now sent instead of being lost.
- A temporary DNS failure when contacting Nexia (`EAI_AGAIN`, `ENOTFOUND`) is now retried once after a second, for reads and changes alike. Nothing has been sent when a name lookup fails, so repeating it cannot do anything twice.
- Requests to Nexia no longer follow HTTP redirects. Following one would repeat a write at the new address (which also made the DNS retry above unsafe in that one case) and would send the Mobile ID and API Key to whatever host the redirect names. No Nexia mobile endpoint redirects, so nothing changes in normal use.
- Only one polling loop can exist at a time: asking for an early poll can no longer start a second loop.

## [1.1.3] - 2026-11-25

### Fixed

- A thermostat whose mode is not in `current_zone_mode` (reported for the American Standard UX360, [#1](https://github.com/drewan50/homebridge-trane-nexia/issues/1)) no longer shows as "Off" in the Home app. The mode is now also read from the zone's `settings`, the thermostat's `system_mode`, the `thermostat_mode` feature and the thermostat's `mode`, in the order the Home Assistant Nexia library uses. If no readable mode exists, the Home app keeps the last known mode, or shows "No Response" if there never was one, and the log says which fields it saw. It no longer pretends the thermostat is Off. This is unverified against a real UX360 payload.
- The `debug` option now works on its own. Previously its output was hidden unless Homebridge itself was started in debug mode, so turning it on appeared to do nothing. With `debug` on, the log also gets one `[debug]` line per thermostat zone showing what was read, including the thermostat model.
- Heating/cooling activity on zoned systems now uses each zone's own `zone_status` when the thermostat provides it, instead of the thermostat-wide status. A zone that is Off no longer shows as heating or cooling because the system is.
- Setting a temperature while the mode is unknown now fails visibly in the Home app instead of being silently ignored.
- Readings the thermostat does not provide are no longer replaced by made-up numbers: a missing room temperature or outdoor temperature was shown as 20 °C, and a missing humidity as 0 %. The Home app now keeps the last known value, or shows "No Response" if there never was one.
- A thermostat whose setpoints are reported only under `setpoints` (not as `heating_setpoint` / `cooling_setpoint`) now shows and changes its target temperature correctly. A temperature change that cannot be computed is refused with an error rather than sent to the thermostat as an empty value.
- Changing the target in COOL or HEAT mode now moves the other setpoint out of the way when the new target would come closer than the thermostat's minimum gap (deadband) to it, and targets are kept inside the thermostat's limits. Changes that leave the other setpoint alone still send just the one value, as before.
- In AUTO mode your heat/cool spread is now kept exactly. Previously each change could widen an odd spread by 1°, and picking the temperature already shown moved the setpoints. Picking the temperature already set now sends nothing.
- A single odd response from Nexia (an empty list of thermostats, a thermostat or its outdoor reading briefly missing) can no longer remove accessories from the Home app, which would have taken them out of their rooms, scenes and automations. An accessory is now removed only after Nexia has not reported it for at least 3 polls over 5 minutes.
- A `pollInterval` that is not a number (for example `"30s"`) or is out of range no longer makes the plugin poll Nexia continuously. It is replaced by the nearest limit between 10 and 600 seconds, or 30, and the log says so.
- Requests to Nexia now time out after 15 seconds instead of hanging for minutes when a connection stalls.
- During a Nexia outage, or after the Mobile ID / API Key is rejected, the plugin now backs off to at most one poll every 10 minutes, logs the problem once instead of at every poll, and logs when Nexia is reachable again. A rejected key says to run `nexia-activate` again.
- A poll that started before a change you made in the Home app finished can no longer put the old value back for a cycle. Changing the mode also refreshes the shown target temperature straight away.
- The thermostat's temperature scale is now also found from the thermostat-level feature or setting when the zone does not state it, and the outdoor sensor uses the same lookup.
- Links in Nexia's responses are always sent to the configured host over its own scheme (a link back to the same host over plain `http` was followed as given), and an `apiUrl` override with a path prefix, or a link starting with `/mobile/`, now resolves correctly.
- The temperature characteristic no longer starts outside its own range, which Homebridge reported as a warning on every start in debug mode.
- Ignoring a temperature change while the thermostat is Off is now logged at info level (it was hidden).

### Changed

- Mode changes and setpoint changes now also work with thermostats that advertise their update action as `set_setpoints` or `self`, honor the action's own HTTP method (POST or PUT), and fall back to the conventional URL when none is advertised. The actions the XL824/XL850 advertise are tried first, so their behavior is unchanged. This is unverified on a real UX360.
- The `[debug]` line names the thermostat model (for example `UX360`) from the thermostat's own information, since its API "type" is only a family name.
- `prepublishOnly` now cleans, builds and runs the tests, so a stale file in `dist/` can't be published. Source maps, which pointed at sources that are not shipped, are no longer in the package.
- Build toolchain updated: TypeScript 7, Homebridge 2.5 typings, and the removal of the `rimraf` dev dependency (no known vulnerabilities in the dev tree). Verified loading and polling in real Homebridge 1.11 and 2.5. No runtime dependencies were added or changed. Node 18 and later remain supported.
- CI builds once on Node 24, then loads the compiled plugin and runs the tests on Node 18, 20, 22, 24 and 26; GitHub Actions updated to v7.
- README troubleshooting now explains where to turn on `debug` and what to include in a bug report.

### Added

- Releases are published from GitHub Actions with npm trusted publishing (no stored token, with a provenance attestation), followed by a GitHub release with these notes. See `docs/ops/RELEASE.md`.
- Unit tests (`npm test`) with synthetic payload fixtures for the mode, activity and setpoint logic, the thermostat and outdoor accessories, the accessory lifecycle, the Nexia client and the release helper.

## [1.1.2] - 2026-07-04

### Fixed

- `config.schema.json` now declares required fields with a standard JSON Schema object-level `required` array instead of per-field `required: true` booleans (flagged by the Homebridge verification checks).

## [1.1.1] - 2026-07-04

### Changed

- CI now tests against Node.js 18, 20, 22, and 24 (previously stopped at 22).
- Setting mode or target temperature now catches Nexia API failures, logs a clear error, and reports `SERVICE_COMMUNICATION_FAILURE` to HomeKit instead of letting the error propagate unhandled.

## [1.1.0] - 2026-07-04

### Added

- Outdoor temperature sensor: exposes a HomeKit Temperature Sensor accessory ("Outdoor Temperature") when the account reports `has_outdoor_temperature`. New config option `outdoorTemperatureSensor` (default `true`) to disable it.

## [1.0.0] - 2026-07-04

First public release.

### Added

- Dynamic-platform plugin: auto-discovers every thermostat and zone on the Nexia account; one HomeKit Thermostat accessory per zone.
- Read support: current/target temperature, heating/cooling state, mode, display units, indoor humidity.
- Write support: target temperature (mode-aware heat/cool/auto setpoints) and mode changes (Off / Heat / Cool / Auto).
- Three brand backends: Trane Home (default), legacy Nexia, and American Standard (ASair).
- `nexia-activate` CLI for the one-time activation-code → Mobile ID + API Key exchange.
- Accessory information from the device's `advanced_info` (model, serial/AUID, firmware version).
- Config UI X schema with guided setup instructions.

### Notes for pre-release (0.1.x) testers

- 1°F stepping in the Home app was fixed in 0.1.1 by advertising `minStep: 0.1` for
  Fahrenheit thermostats. That fix required re-creating the accessories under new
  internal IDs, so upgrading from 0.1.0 re-adds both thermostats in the Home app
  (rooms/automations need re-assigning once).
