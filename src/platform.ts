import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { BRANDS, PLATFORM_NAME, PLUGIN_NAME, type BrandName } from './settings';
import { NexiaClient, type NexiaClientOptions } from './nexia/client';
import { ThermostatAccessory } from './thermostatAccessory';

export class TraneNexiaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly nexia: NexiaClient;
  private readonly pollMs: number;
  private pollTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly handlers: Map<string, ThermostatAccessory> = new Map();

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
    this.pollMs = Math.max(10, Number(config.pollInterval ?? 30)) * 1000;
    this.nexia = new NexiaClient(opts);

    api.on('didFinishLaunching', () => {
      this.start().catch(e => log.error('TraneNexia start failed:', e));
    });
    api.on('shutdown', () => this.stop());
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
      this.refresh()
        .catch(e => this.log.error('Nexia poll failed:', (e as Error).message))
        .finally(() => this.scheduleNextPoll(this.pollMs));
    }, delayMs);
  }

  private stop(): void {
    this.stopping = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async refresh(): Promise<void> {
    const house = await this.nexia.getHouse();
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
          handler.update(t, z);
        }
      }
    }
    const stale = this.accessories.filter(a => !seen.has(a.UUID));
    if (stale.length) {
      for (const s of stale) {
        this.log.info(`Removing stale accessory: ${s.displayName}`);
        this.handlers.delete(s.UUID);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const s of stale) {
        const idx = this.accessories.indexOf(s);
        if (idx >= 0) this.accessories.splice(idx, 1);
      }
    }
  }
}
