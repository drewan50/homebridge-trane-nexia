import type { Logging } from 'homebridge';
import { BRANDS, baseUrlFor } from '../settings';
import type {
  ActivateResponse,
  Brand,
  House,
  HouseResponse,
  SessionResponse,
  Thermostat,
  Zone,
  ZoneMode,
} from './types';

export interface NexiaClientOptions {
  brand: Brand;
  mobileId: string;
  apiKey: string;
  houseId?: string;
  appVersion?: string;
  apiUrl?: string;
  log?: Logging;
  debug?: boolean;
}

export class NexiaClient {
  readonly baseUrl: string;
  private cachedHouseId: string | undefined;

  constructor(public readonly options: NexiaClientOptions) {
    if (!BRANDS.includes(options.brand)) {
      throw new Error(`Invalid brand "${options.brand}". Expected one of: ${BRANDS.join(', ')}`);
    }
    const override = options.apiUrl?.trim();
    if (override) {
      this.baseUrl = override.endsWith('/') ? override : override + '/';
    } else {
      this.baseUrl = baseUrlFor(options.brand);
    }
    this.cachedHouseId = options.houseId;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'X-MobileId': this.options.mobileId,
      'X-ApiKey': this.options.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.options.brand === 'asair') {
      h['X-AssociatedBrand'] = 'asair';
      if (this.options.appVersion) h['X-AppVersion'] = this.options.appVersion;
    }
    return h;
  }

  private url(pathOrAbsolute: string): string {
    if (/^https?:\/\//i.test(pathOrAbsolute)) {
      // Rewrite host to match our configured base so we stay on one brand domain,
      // even though Nexia's HATEOAS responses interleave mynexia.com URLs.
      try {
        const u = new URL(pathOrAbsolute);
        const b = new URL(this.baseUrl);
        if (u.host !== b.host) return b.origin + u.pathname + u.search + u.hash;
      } catch { /* fall through */ }
      return pathOrAbsolute;
    }
    return this.baseUrl + pathOrAbsolute.replace(/^\//, '');
  }

  private log(...args: unknown[]): void {
    if (this.options.debug) this.options.log?.debug('[nexia]', ...args);
  }

  private async request<T>(method: 'GET' | 'POST', pathOrUrl: string, body?: unknown): Promise<T> {
    const url = this.url(pathOrUrl);
    this.log(method, url, body ?? '');
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Nexia ${method} ${url} -> HTTP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
    }
    const text = await res.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new Error(`Nexia ${method} ${url} returned non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  async getSession(): Promise<SessionResponse['result']> {
    const r = await this.request<SessionResponse>('GET', 'session');
    return r.result;
  }

  async getHouseId(): Promise<string> {
    if (this.cachedHouseId) return this.cachedHouseId;
    const session = await this.getSession();
    const id = session?._links?.child?.[0]?.data?.id;
    if (!id) throw new Error('Nexia session response missing house id');
    this.cachedHouseId = String(id);
    return this.cachedHouseId;
  }

  async getHouse(): Promise<House> {
    const id = await this.getHouseId();
    const r = await this.request<HouseResponse>('GET', `houses/${id}`);
    const items = r.result?._links?.child?.[0]?.data?.items;
    if (!Array.isArray(items)) {
      throw new Error('Nexia house response missing items[]');
    }
    return { id: Number(id), items };
  }

  async setZoneMode(zone: Zone, mode: ZoneMode): Promise<void> {
    const href = this.findActionHref(zone, 'thermostat_mode', 'update_thermostat_mode');
    if (!href) throw new Error(`Zone ${zone.id} has no update_thermostat_mode action`);
    await this.request<unknown>('POST', href, { value: mode });
  }

  async setSetpoints(zone: Zone, payload: { heat?: number; cool?: number }): Promise<void> {
    // Endpoint URL is the same regardless of which setpoint key the server advertises
    // (e.g. only `set_cool_setpoint` is exposed when the zone is in COOL mode), so we
    // pick whichever href is present.
    let href = this.findActionHref(zone, 'thermostat', 'set_heat_setpoint')
      || this.findActionHref(zone, 'thermostat', 'set_cool_setpoint');
    if (!href) {
      const modeHref = this.findActionHref(zone, 'thermostat_mode', 'update_thermostat_mode');
      if (modeHref) href = modeHref.replace('zone_mode', 'setpoints');
    }
    if (!href) href = `${zone.type}s/${zone.id}/setpoints`;
    await this.request<unknown>('POST', href, payload);
  }

  async runMode(zone: Zone, mode: 'permanent_hold' | 'run_schedule'): Promise<void> {
    await this.request<unknown>('POST', `${zone.type}s/${zone.id}/run_mode`, { value: mode });
  }

  private findActionHref(zone: Zone, featureName: string, action: string): string | undefined {
    const feat = zone.features?.find(f => f.name === featureName);
    return feat?.actions?.[action]?.href;
  }

  static async activate(brand: Brand, activationCode: string): Promise<{ mobileId: string; apiKey: string }> {
    if (!BRANDS.includes(brand)) {
      throw new Error(`Invalid brand "${brand}". Expected one of: ${BRANDS.join(', ')}`);
    }
    const url = baseUrlFor(brand) + 'activate';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ activation_code: activationCode }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`activate HTTP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
    }
    const data = JSON.parse(text) as ActivateResponse;
    if (!data?.result?.mobile_id || !data?.result?.api_key) {
      throw new Error(`activate response missing mobile_id/api_key: ${text.slice(0, 400)}`);
    }
    return { mobileId: data.result.mobile_id, apiKey: data.result.api_key };
  }
}
