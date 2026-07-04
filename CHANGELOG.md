# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
