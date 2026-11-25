import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { BRANDS, MAX_BACKOFF_MS, MAX_POLL_SECONDS, MIN_POLL_SECONDS, PLATFORM_NAME, PLUGIN_NAME, nextPollDelayMs, normalizePollSeconds, type BrandName } from './settings';
import { NexiaClient, NexiaHttpError, type NexiaClientOptions } from './nexia/client';
import { ThermostatAccessory } from './thermostatAccessory';
import { OutdoorSensorAccessory } from './outdoorSensorAccessory';

const MAX_BACKOFF_MINUTES = MAX_BACKOFF_MS / 60000;
const STALE_AFTER_POLLS = 3;
const STALE_AFTER_MS = 5 * 60 * 1000;

export class TraneNexiaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly nexia: NexiaClient;
  private readonly pollMs: number;
  private pollTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly handlers: Map<string, ThermostatAccessory | OutdoorSensorAccessory> = new Map();
  // Accessories the last polls did not report, so a vendor glitch can't make us unregister them.
  private readonly missing: Map<string, { since: number; polls: number }> = new Map();
  private warnedEmptyHouse = false;
  // Poll health: consecutive failures drive the backoff, and what we last said keeps the log from repeating itself.
  private failures = 0;
  private lastFailureMessage = '';

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const rawBrand = String(config.brand ?? 'trane').toLowerCase();
    if (!BRANDS.includes(rawBrand as BrandName)) {
      log.error(`Invalid brand "${config.brand}". Expected one of: ${BRANDS.join(', ')}. Falling back to "trane".`);
    }
    const brand: BrandName = (BRANDS as readonly string[]).includes(rawBrand) ? (rawBrand as BrandName) : 'trane';
    const opts: NexiaClientOptions = {
      brand,
      mobileId: String(config.mobileId ?? ''),
      apiKey: String(config.apiKey ?? ''),
      houseId: config.houseId ? String(config.houseId) : undefined,
      appVersion: config.appVersion ? String(config.appVersion) : undefined,
      apiUrl: config.apiUrl ? String(config.apiUrl) : undefined,
      log,
      debug: !!config.debug,
    };
    const pollSeconds = normalizePollSeconds(config.pollInterval);
    if (config.pollInterval !== undefined && config.pollInterval !== null && config.pollInterval !== '' && pollSeconds !== Number(config.pollInterval)) {
      log.warn(`pollInterval ${JSON.stringify(config.pollInterval)} is not a number between ${MIN_POLL_SECONDS} and ${MAX_POLL_SECONDS}; using ${pollSeconds} seconds.`);
    }
    this.pollMs = pollSeconds * 1000;
    this.nexia = new NexiaClient(opts);

    api.on('didFinishLaunching', () => {
      this.start().catch(e => log.error('TraneNexia start failed:', e));
    });
    api.on('shutdown', () => this.stop());
  }

  /** The plugin's own `debug` option. Homebridge hides `log.debug` unless Homebridge itself runs in
   *  debug mode, so code gated on this flag logs at info level instead. */
  get debugEnabled(): boolean {
    return !!this.config.debug;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async start(): Promise<void> {
    if (!this.nexia.options.mobileId || !this.nexia.options.apiKey) {
      this.log.error('Missing mobileId/apiKey in config. Run `nexia-activate <activation_code>` first.');
      return;
    }
    this.log.info(`Starting Nexia poller against ${this.nexia.baseUrl} every ${this.pollMs / 1000}s`);
    this.scheduleNextPoll(0);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.pollOnce().then(next => this.scheduleNextPoll(next));
    }, delayMs);
  }

  /** One poll. Never rejects, and returns how long to wait before the next one: the normal interval while
   *  healthy, longer after consecutive failures. The first failure is logged as an error, the same failure
   *  is then reminded about every 10th time, and recovery is logged once, so an outage or a revoked key
   *  doesn't write thousands of identical lines. */
  async pollOnce(): Promise<number> {
    try {
      await this.refresh();
      if (this.failures > 0) this.log.info(`Nexia is reachable again after ${this.failures} failed poll${this.failures === 1 ? '' : 's'}.`);
      this.failures = 0;
      this.lastFailureMessage = '';
      return this.pollMs;
    } catch (e) {
      this.failures += 1;
      const authFailure = e instanceof NexiaHttpError && (e.status === 401 || e.status === 403);
      const message = authFailure
        ? `Nexia rejected the Mobile ID / API Key (HTTP ${(e as NexiaHttpError).status}). Run \`nexia-activate\` again with a new activation code and update the plugin settings; until then the plugin will retry only every ${MAX_BACKOFF_MINUTES} minutes.`
        : `Nexia poll failed: ${(e as Error).message}`;
      if (this.failures === 1 || message !== this.lastFailureMessage) {
        this.log.error(message);
      } else if (this.failures % 10 === 0) {
        this.log.error(`${message} (still failing after ${this.failures} polls)`);
      }
      this.lastFailureMessage = message;
      return nextPollDelayMs(this.pollMs, this.failures, authFailure);
    }
  }

  private stop(): void {
    this.stopping = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Wall clock; a method so tests can drive time. */
  now(): number {
    return Date.now();
  }

  private async refresh(): Promise<void> {
    // When this poll started: a handler ignores a poll that began before its own last write finished,
    // so a slow poll can't put the old value back for a cycle.
    const polledAt = this.now();
    const house = await this.nexia.getHouse();
    if (house.items.length === 0) {
      // An account always has a thermostat. An empty answer is a vendor hiccup, never a reason to
      // unregister everything (which would cost the user their rooms, scenes and automations).
      if (!this.warnedEmptyHouse) {
        this.warnedEmptyHouse = true;
        this.log.warn('Nexia returned no thermostats for this account; keeping the existing accessories until it does.');
      }
      return;
    }
    this.warnedEmptyHouse = false;
    const seen = new Set<string>();
    for (const t of house.items) {
      for (const z of t.zones ?? []) {
        const uuid = this.api.hap.uuid.generate(`trane-nexia:v2:${house.id}:${t.id}:${z.id}`);
        seen.add(uuid);
        let accessory = this.accessories.find(a => a.UUID === uuid);
        const displayName = (z.name && z.name.trim()) || (t.name && t.name.trim()) || `Thermostat ${t.id}-${z.id}`;
        if (!accessory) {
          this.log.info(`Adding accessory: ${displayName} (thermostat ${t.id}, zone ${z.id})`);
          accessory = new this.api.platformAccessory(displayName, uuid);
          accessory.context.thermostatId = t.id;
          accessory.context.zoneId = z.id;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }
        let handler = this.handlers.get(uuid);
        if (!handler) {
          handler = new ThermostatAccessory(this, accessory, this.nexia, t, z);
          this.handlers.set(uuid, handler);
        } else {
          (handler as ThermostatAccessory).update(t, z, polledAt);
        }
      }
    }

    if (this.config.outdoorTemperatureSensor !== false) {
      // A thermostat that still advertises an outdoor sensor keeps its accessory even in a poll where the
      // reading is empty; the accessory is only created once there is a reading to show.
      const capable = house.items.filter(t => t.has_outdoor_temperature);
      const withReading = capable.find(t => t.outdoor_temperature != null && t.outdoor_temperature !== '');
      if (capable.length) {
        const uuid = this.api.hap.uuid.generate(`trane-nexia:v2:${house.id}:outdoor`);
        seen.add(uuid);
        let accessory = this.accessories.find(a => a.UUID === uuid);
        if (!accessory && withReading) {
          this.log.info('Adding accessory: Outdoor Temperature');
          accessory = new this.api.platformAccessory('Outdoor Temperature', uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }
        if (accessory) {
          const handler = this.handlers.get(uuid);
          if (handler) {
            (handler as OutdoorSensorAccessory).update(withReading ?? capable[0]);
          } else if (withReading) {
            this.handlers.set(uuid, new OutdoorSensorAccessory(this, accessory, withReading));
          }
        }
      }
    }

    this.removeStaleAccessories(seen);
  }

  /** Unregisters an accessory only after Nexia has failed to report it for several polls in a row AND for
   *  several minutes. Unregistering takes it out of the user's HomeKit rooms, scenes and automations, and
   *  re-adding it does not bring those back, so one odd response must not be able to do it. */
  private removeStaleAccessories(seen: Set<string>): void {
    const nowMs = this.now();
    for (const a of this.accessories) {
      if (seen.has(a.UUID)) {
        this.missing.delete(a.UUID);
        continue;
      }
      const m = this.missing.get(a.UUID) ?? { since: nowMs, polls: 0 };
      m.polls += 1;
      this.missing.set(a.UUID, m);
      if (m.polls === 1) {
        this.log.warn(`"${a.displayName}" was not in Nexia's latest response. It will be removed only if it stays missing for ${STALE_AFTER_POLLS} polls over at least ${STALE_AFTER_MS / 60000} minutes.`);
      }
    }
    const stale = this.accessories.filter(a => {
      const m = this.missing.get(a.UUID);
      return m !== undefined && m.polls >= STALE_AFTER_POLLS && nowMs - m.since >= STALE_AFTER_MS;
    });
    if (stale.length) {
      for (const s of stale) {
        this.log.info(`Removing accessory that Nexia no longer reports: ${s.displayName}`);
        this.handlers.delete(s.UUID);
        this.missing.delete(s.UUID);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const s of stale) {
        const idx = this.accessories.indexOf(s);
        if (idx >= 0) this.accessories.splice(idx, 1);
      }
    }
  }
}
