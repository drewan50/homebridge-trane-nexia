import type { Logging } from 'homebridge';
import { BRANDS, baseUrlFor } from '../settings';
import type {
  ActivateResponse,
  Brand,
  FeatureAction,
  House,
  HouseResponse,
  SessionResponse,
  Zone,
  ZoneMode,
} from './types';

/** Every request gets this long, including reading the response. Without a limit a half-open connection
 *  stalls polling (and a pending HomeKit write) for minutes. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** One retry after a DNS failure waits this long. */
export const DNS_RETRY_DELAY_MS = 1_000;

/** The name of the host could not be looked up (EAI_AGAIN is "temporary failure in name resolution", common on a NAS whose
 *  resolver hiccups). Nothing was connected to, let alone sent, so repeating the request cannot do anything twice. */
function isNameResolutionFailure(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === 'EAI_AGAIN' || code === 'ENOTFOUND';
}

/** A non-2xx answer from Nexia. `status` lets callers tell "your key was rejected" from "Nexia is down". */
export class NexiaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'NexiaHttpError';
  }
}

export interface NexiaClientOptions {
  brand: Brand;
  mobileId: string;
  apiKey: string;
  houseId?: string;
  appVersion?: string;
  apiUrl?: string;
  log?: Logging;
  debug?: boolean;
  /** Per-request limit in milliseconds; defaults to REQUEST_TIMEOUT_MS. Exposed so tests don't wait 15 s. */
  timeoutMs?: number;
  /** Pause before the single retry after a DNS lookup failure; defaults to DNS_RETRY_DELAY_MS. */
  retryDelayMs?: number;
}

type Method = 'GET' | 'POST' | 'PUT';
interface Action { href: string; method: 'POST' | 'PUT' }

function describeFetchError(method: string, url: string, e: unknown, timeoutMs: number, retried = false): Error {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new Error(`Nexia ${method} ${url} timed out after ${timeoutMs / 1000}s`);
  }
  // undici reports every network failure as "fetch failed"; the useful part is on `cause` (ENOTFOUND, ECONNRESET, ...).
  const cause = err?.cause?.code ?? err?.cause?.message;
  return new Error(`Nexia ${method} ${url} failed: ${err?.message ?? String(e)}${cause ? ` (${cause})` : ''}${retried ? ' after one retry' : ''}`);
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

  /** Turns a path or a link from a Nexia response into a URL on the configured host, always. The mobile
   *  API's links are absolute and interleave several brand hosts (mynexia.com in a tranehome.com account),
   *  and the credential headers must never go anywhere but the configured base, over its scheme. */
  private url(pathOrAbsolute: string): string {
    const base = new URL(this.baseUrl);
    // An `apiUrl` override may sit under a path prefix in front of /mobile/ (a proxy, a test server).
    const mobileAt = base.pathname.indexOf('/mobile/');
    const prefix = mobileAt > 0 ? base.pathname.slice(0, mobileAt) : '';
    const onBase = (path: string): string => base.origin + (path.startsWith('/mobile/') ? prefix : '') + path;

    if (/^https?:\/\//i.test(pathOrAbsolute)) {
      let u: URL;
      try {
        u = new URL(pathOrAbsolute);
      } catch {
        throw new Error('Nexia returned a link that is not a valid URL');
      }
      return onBase(u.pathname) + u.search + u.hash;
    }
    if (pathOrAbsolute.startsWith('/mobile/')) return onBase(pathOrAbsolute);
    return this.baseUrl + pathOrAbsolute.replace(/^\//, '');
  }

  // Info level on purpose: Homebridge drops log.debug unless Homebridge itself runs in debug mode,
  // which would make the plugin's own `debug: true` option print nothing.
  private log(...args: unknown[]): void {
    if (this.options.debug) this.options.log?.info('[nexia]', ...args);
  }

  private async request<T>(method: Method, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = this.url(pathOrUrl);
    this.log(method, url, body ?? '');
    const timeoutMs = this.options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let res: Response;
    let text: string;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, {
          method,
          headers: this.headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          // Never follow a redirect: fetch would repeat a POST at the new address, and would carry the Mobile ID / API Key
          // headers to whatever host it points at. No Nexia mobile endpoint redirects (checked for all three brands).
          redirect: 'error',
        });
        text = await res.text();
        break;
      } catch (e) {
        if (attempt === 0 && isNameResolutionFailure(e)) {
          this.log(`${method} ${url}: name lookup failed, retrying once`);
          await new Promise<void>(resolve => setTimeout(resolve, this.options.retryDelayMs ?? DNS_RETRY_DELAY_MS));
          continue;
        }
        throw describeFetchError(method, url, e, timeoutMs, attempt > 0);
      }
    }
    if (!res.ok) {
      throw new NexiaHttpError(res.status, `Nexia ${method} ${url} -> HTTP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
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

  /** Mode change. The advertised action first (the XL824/XL850 expose `update_thermostat_mode`); `self` for
   *  models that expose only that; otherwise the conventional URL, as the reference implementation does. */
  async setZoneMode(zone: Zone, mode: ZoneMode, thermostatId?: number): Promise<void> {
    const action = this.findAction(zone, 'thermostat_mode', ['update_thermostat_mode', 'self']);
    if (action) return this.send(action, { value: mode });
    const href = this.zonePath(zone, thermostatId, 'zone_mode');
    this.log(`zone ${zone.id} advertises no mode action; using ${href}`);
    await this.request<unknown>('POST', href, { value: mode });
  }

  /** Setpoint change. The XL824/XL850 advertise `set_heat_setpoint` (or `set_cool_setpoint` in COOL mode) and
   *  the URL is the same either way, so those stay first; `set_setpoints` and `self` cover other models. The
   *  action's own `method` is honored (POST unless it says PUT). */
  async setSetpoints(zone: Zone, payload: { heat?: number; cool?: number }, thermostatId?: number): Promise<void> {
    const action = this.findAction(zone, 'thermostat', ['set_heat_setpoint', 'set_cool_setpoint', 'set_setpoints', 'self']);
    if (action) return this.send(action, payload);
    const modeHref = this.findAction(zone, 'thermostat_mode', ['update_thermostat_mode'])?.href;
    const href = modeHref ? modeHref.replace('zone_mode', 'setpoints') : this.zonePath(zone, thermostatId, 'setpoints');
    await this.request<unknown>('POST', href, payload);
  }

  async runMode(zone: Zone, mode: 'permanent_hold' | 'run_schedule', thermostatId?: number): Promise<void> {
    await this.request<unknown>('POST', this.zonePath(zone, thermostatId, 'run_mode'), { value: mode });
  }

  private async send(action: Action, body: unknown): Promise<void> {
    await this.request<unknown>(action.method, action.href, body);
  }

  private findAction(zone: Zone, featureName: string, names: string[]): Action | undefined {
    const actions = zone.features?.find(f => f.name === featureName)?.actions;
    for (const name of names) {
      const a: FeatureAction | undefined = actions?.[name];
      if (typeof a?.href !== 'string' || !a.href) continue;
      const method = (a.method ?? 'POST').toUpperCase();
      if (method !== 'POST' && method !== 'PUT') {
        throw new Error(`Nexia action "${name}" uses unsupported method ${method}`);
      }
      return { href: a.href, method };
    }
    return undefined;
  }

  /** The conventional zone URL (`xxl_zones/<id>/<endpoint>`). Zoned systems such as the UX360 reuse small
   *  zone ids across thermostats, so the reference qualifies those with the thermostat id. */
  private zonePath(zone: Zone, thermostatId: number | undefined, endpoint: string): string {
    const qualified = typeof zone.id === 'number' && zone.id < 256 && thermostatId !== undefined;
    const id = qualified ? `${thermostatId}_${zone.id}` : String(zone.id);
    const type = zone.type && typeof zone.type === 'string' ? zone.type : 'xxl_zone';
    return `${type}s/${id}/${endpoint}`;
  }

  static async activate(brand: Brand, activationCode: string): Promise<{ mobileId: string; apiKey: string }> {
    if (!BRANDS.includes(brand)) {
      throw new Error(`Invalid brand "${brand}". Expected one of: ${BRANDS.join(', ')}`);
    }
    const url = baseUrlFor(brand) + 'activate';
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ activation_code: activationCode }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      text = await res.text();
    } catch (e) {
      throw describeFetchError('POST', url, e, REQUEST_TIMEOUT_MS);
    }
    if (!res.ok) {
      throw new NexiaHttpError(res.status, `activate HTTP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
    }
    let data: ActivateResponse;
    try {
      data = JSON.parse(text) as ActivateResponse;
    } catch {
      throw new Error(`activate returned a non-JSON body: ${text.slice(0, 200)}`);
    }
    if (!data?.result?.mobile_id || !data?.result?.api_key) {
      throw new Error(`activate response missing mobile_id/api_key: ${text.slice(0, 400)}`);
    }
    return { mobileId: data.result.mobile_id, apiKey: data.result.api_key };
  }
}
