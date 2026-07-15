# homebridge-trane-nexia

[![npm version](https://img.shields.io/npm/v/homebridge-trane-nexia)](https://www.npmjs.com/package/homebridge-trane-nexia)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-trane-nexia)](https://www.npmjs.com/package/homebridge-trane-nexia)
[![license](https://img.shields.io/npm/l/homebridge-trane-nexia)](LICENSE)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

A [Homebridge](https://homebridge.io) dynamic-platform plugin that exposes **Trane** and **American Standard** thermostats to Apple Home via the Nexia cloud API.

Auto-discovers every thermostat and zone on your account. Each zone becomes one HomeKit `Thermostat` accessory with full read/write support for temperature, mode, and humidity.

**Tested devices:** XL824, XL850 (and expected to work with XL950, XL1050 and any other Nexia-connected thermostat)  
**Tested platform:** Synology DSM 7 with `homebridge-syno-spk` 4.1.2, Node 22

---

## Why cloud?

These thermostats accept no inbound connections on the local network — they only make outbound calls to Nexia. Port scans, mDNS, and SSDP discovery confirm there is no local API surface. The Nexia cloud is the only integration path.

No passwords are stored. The plugin uses a long-lived **Mobile ID + API Key** pair that you generate once via the Nexia web UI (see [Get credentials](#step-1-get-credentials) below).

---

## Requirements

- Homebridge >= 1.8.0
- Node >= 18.0.0 (uses built-in `fetch` — no native dependencies)
- A Trane Home, Nexia, or American Standard (ASair) account linked to your thermostat(s)

---

## Installation

### Standard Homebridge (Linux / macOS / Raspberry Pi)

```sh
sudo hb-service add homebridge-trane-nexia
```

Or via the Homebridge Config UI X web interface: search for `homebridge-trane-nexia` and click **Install**.

### Synology DSM 7 (homebridge-syno-spk)

`hb-service add` on older SPK builds rejects local file paths. Use one of the two methods below.

#### Method A — Install from npm registry (recommended once published)

```sh
ssh admin@<nas-ip>
sudo hb-service add homebridge-trane-nexia
```

#### Method B — Install from local tarball

Use this method when installing a build that is not yet published to npm.

**1. Copy the tarball to the NAS** (from your Mac, using the Homebridge shared folder over SMB):

- In Finder → Go → Connect to Server → `smb://<nas-ip>`
- Open the **homebridge** share
- Drop `homebridge-trane-nexia-X.X.X.tgz` into the root of the share

Or via SCP:
```sh
scp homebridge-trane-nexia-X.X.X.tgz admin@<nas-ip>:/volume1/homebridge/
```

**2. Install via npm into the Homebridge storage prefix:**

```sh
ssh admin@<nas-ip>
sudo /usr/local/bin/npm install --prefix /volume1/homebridge /volume1/homebridge/homebridge-trane-nexia-X.X.X.tgz
```

**3. Fix ownership and permissions** (critical — `sudo npm` installs as root; Homebridge runs as the `homebridge` user and cannot read root-owned files):

```sh
sudo chown -R homebridge:homebridge /volume1/homebridge/node_modules/homebridge-trane-nexia
sudo chmod -R 755 /volume1/homebridge/node_modules/homebridge-trane-nexia
```

**4. Restart Homebridge:**

```sh
sudo hb-service restart
```

**5. Verify the plugin loaded:**

```sh
sudo -u homebridge node -e "require('/volume1/homebridge/node_modules/homebridge-trane-nexia/dist/index.js')"
```

No output = clean load. If you see `Cannot find module`, the permissions fix in step 3 was not applied correctly.

---

## Step 1 — Get credentials

The plugin does not use your Nexia password. Instead, you register a "mobile device" on the Nexia website and exchange an activation code for a permanent **Mobile ID** and **API Key**.

1. Open the correct portal for your account:
   - **Trane Home:** https://www.tranehome.com
   - **Legacy Nexia / American Standard:** https://www.mynexia.com (redirects to tranehome.com)
   - **American Standard (ASair):** https://asairhome.com

2. Log in with the same credentials you use in the mobile app.

3. Open your house. Note the numeric **House ID** in the URL — it looks like `/houses/1234567`. You'll need this for the config.

4. In the site header, click **Mobile** → **Add Mobile Device**.  
   - Name it anything (e.g. "Homebridge")  
   - Set **Mobile Connection** to **Wifi**  
   - Save

5. Find the new entry in the device list → click **Get Activation Code**. You'll see a 12-digit code. Copy it — it is single-use.

6. Run the activation helper (included in the plugin):

   ```sh
   # Trane Home accounts (default):
   npx nexia-activate 123456789012

   # Legacy Nexia accounts:
   npx nexia-activate --brand nexia 123456789012

   # American Standard accounts:
   npx nexia-activate --brand asair 123456789012
   ```

   Output:
   ```
   mobileId: 1234567
   apiKey:   abcdef1234567890abcdef1234567890
   ```

   Save these — you will not be able to retrieve the API key again without generating a new activation code.

---

## Step 2 — Configure

Open the Homebridge Config UI at `http://<homebridge-ip>:8581`, go to **Config**, and add the following to the `"platforms"` array:

```json
{
  "platform": "TraneNexia",
  "name": "Trane Nexia",
  "brand": "trane",
  "mobileId": "YOUR_MOBILE_ID",
  "apiKey": "YOUR_API_KEY",
  "houseId": "YOUR_HOUSE_ID",
  "pollInterval": 30
}
```

### All config options

| Key            | Required | Default  | Description |
| -------------- | -------- | -------- | ----------- |
| `platform`     | yes      | —        | Must be `"TraneNexia"` |
| `name`         | yes      | —        | Display name (any string) |
| `brand`        | yes      | `"trane"` | `"trane"`, `"nexia"`, or `"asair"` |
| `mobileId`     | yes      | —        | From `nexia-activate` |
| `apiKey`       | yes      | —        | From `nexia-activate` |
| `houseId`      | no       | auto     | Numeric house ID from the URL. Omit to auto-discover from session. |
| `pollInterval` | no       | `30`     | Seconds between Nexia API polls. Minimum 10. |
| `outdoorTemperatureSensor` | no | `true` | Expose a HomeKit temperature sensor for the outdoor reading. Set `false` to disable. |
| `appVersion`   | no       | —        | Only needed for `brand: "asair"` (sent as `X-AppVersion`). |
| `apiUrl`       | no       | —        | Override the Nexia API base URL (for debugging). |
| `debug`        | no       | `false`  | Log all Nexia HTTP calls to the Homebridge log. |

---

## What each accessory exposes

One HomeKit **Thermostat** accessory is created per zone. On single-zone thermostats the accessory is named after the thermostat; on multi-zone units the name is `"<Thermostat> <Zone>"`.

| HomeKit characteristic       | Source in Nexia API |
| ---------------------------- | ------------------- |
| `CurrentTemperature`         | `zone.temperature` — converted from °F or °C based on the thermostat's native scale |
| `TargetTemperature`          | Heating or cooling setpoint, or midpoint of both in AUTO mode |
| `CurrentHeatingCoolingState` | Parsed from `thermostat.system_status` ("Heating" → HEAT, "Cooling" → COOL, anything else → OFF) |
| `TargetHeatingCoolingState`  | `zone.current_zone_mode` (OFF / HEAT / COOL / AUTO) |
| `TemperatureDisplayUnits`    | `thermostat` feature `scale` field (`"f"` or `"c"`) |
| `CurrentRelativeHumidity`    | `thermostat.indoor_humidity` — only registered if the thermostat reports humidity |

**Accessory Information:**

| Field              | Source |
| ------------------ | ------ |
| Manufacturer       | `thermostat.manufacturer` (defaults to "Trane") |
| Model              | `features[advanced_info].items[label="Model"]` |
| Serial Number      | `features[advanced_info].items[label="AUID"]` |
| Firmware Revision  | `features[advanced_info].items[label="Firmware Version"]` |

### Outdoor temperature sensor

If any thermostat on the account reports `has_outdoor_temperature`, the plugin adds one additional HomeKit **Temperature Sensor** accessory named "Outdoor Temperature" (shared across the house — Nexia reports a single outdoor reading, not one per thermostat). Disable it with `"outdoorTemperatureSensor": false` in the config.

### Writing setpoints

| Mode   | What gets sent |
| ------ | -------------- |
| HEAT   | `{ heat: <value> }` |
| COOL   | `{ cool: <value> }` |
| AUTO   | `{ heat: midpoint − half_spread, cool: midpoint + half_spread }` — preserves the existing spread between setpoints |
| OFF    | No-op (Apple Home shouldn't send setpoint changes in OFF mode, but the plugin ignores them if it does) |

---

## Troubleshooting

### "No plugin was found for the platform TraneNexia"

Either the plugin is not installed in Homebridge's storage path, or it has a load error that Homebridge is swallowing silently. Check both:

```sh
# Confirm the files are there
ls /volume1/homebridge/node_modules/homebridge-trane-nexia/dist/

# Confirm the plugin loads without error (must run as homebridge user)
sudo -u homebridge node -e "require('/volume1/homebridge/node_modules/homebridge-trane-nexia/dist/index.js')"
```

If the second command fails with `Cannot find module` even though the files are present, fix permissions:

```sh
sudo chown -R homebridge:homebridge /volume1/homebridge/node_modules/homebridge-trane-nexia
sudo chmod -R 755 /volume1/homebridge/node_modules/homebridge-trane-nexia
sudo hb-service restart
```

### Plugin does not appear in the Homebridge UI plugin list

The Homebridge Config UI X only lists plugins installed via `hb-service add`. Installing via raw `npm install` puts the plugin in the right place for Homebridge to load it, but the UI won't list it under Plugins. This is cosmetic — the plugin will still work. To make it appear, reinstall using `hb-service add` once the package is published to npm.

### "hb-service add" returns "Invalid Plugin name."

Some older `homebridge-syno-spk` versions do not accept local file paths in `hb-service add`. Use the [Method B tarball install](#method-b----install-from-local-tarball) instructions above.

### Activation returns HTTP 401 or 404

- Wrong `--brand` flag. Trane Home accounts use `--brand trane` (default). Legacy Nexia accounts use `--brand nexia`. American Standard uses `--brand asair`.
- The activation code was already used. Go back to the web UI, delete the mobile device entry, and create a new one to get a fresh code.
- The code expired. Activation codes expire quickly — run `nexia-activate` immediately after copying the code.

### Thermostat shows wrong state / temperature not updating

Enable debug logging to see every Nexia API call:

```json
"debug": true
```

Restart Homebridge and check the log (`sudo hb-service logs`). Every HTTP request and response is printed with `[nexia]` prefix.

### Temperatures only update every 30 seconds

By design. The plugin polls the Nexia cloud API on a configurable interval (`pollInterval`, default 30s). Nexia does not offer push notifications to third-party integrations. Lowering `pollInterval` increases API call frequency — values below 15s are not recommended.

### Temperature only adjusts in 2°F jumps (even numbers only)

Fixed in v0.1.1. Earlier versions advertised a `minStep` in °C that didn't map cleanly onto whole °F values, so the Home app fell back to 1°C (~2°F) per tap. As of v0.1.1 the plugin advertises `minStep: 0.1` for Fahrenheit thermostats and lets the Home app do its own 1°F stepping.

Because iOS caches each accessory's characteristic metadata, upgrading to v0.1.1 causes both thermostats to be re-created with a new internal ID so the Home app picks up the corrected step size. This is a one-time event: you'll see them disappear and reappear in the Home app after restarting Homebridge, and you'll need to re-assign rooms and re-add them to any automations/scenes that referenced them.

---

## Development

```sh
git clone https://github.com/drewan50/homebridge-trane-nexia.git
cd homebridge-trane-nexia
npm install
npm run build       # compiles TypeScript → dist/
npm pack            # produces homebridge-trane-nexia-X.X.X.tgz for local install
```

To test against a real account, copy `nexia-credentials.json.example` to `nexia-credentials.json`, fill in your credentials, and run:

```sh
node scripts/verify-client.js
```

This prints what each HomeKit accessory will look like — current temp, target temp, mode, setpoint range, humidity — without starting Homebridge or touching HAP.

There are no automated tests; the Nexia API has no public OpenAPI spec or mock fixtures, so meaningful testing requires real credentials.

---

## Project structure

```
src/
  index.ts                 — Homebridge plugin entry point
  platform.ts              — DynamicPlatformPlugin: discovery, polling, accessory lifecycle
  thermostatAccessory.ts   — HomeKit Thermostat service mapping and set handlers
  settings.ts              — Brand URLs, platform name constants
  nexia/
    client.ts              — HTTP client: activate, getHouse, setZoneMode, setSetpoints
    types.ts               — TypeScript interfaces for Nexia API responses
bin/
  nexia-activate.js        — CLI helper to exchange an activation code for mobileId + apiKey
scripts/
  verify-client.js         — End-to-end data validation script (requires real credentials)
config.schema.json         — Homebridge Config UI X form schema
```

---

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Trane Technologies, American Standard, or Nexia. "Trane", "American Standard", and "Nexia" are trademarks of their respective owners, used here only to describe compatibility. The plugin talks to the same cloud API the official mobile apps use; use at your own risk.

## License

[MIT](LICENSE)
