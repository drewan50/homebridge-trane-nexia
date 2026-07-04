export const PLATFORM_NAME = 'TraneNexia';
export const PLUGIN_NAME = 'homebridge-trane-nexia';

export const TRANE_BASE_URL = 'https://www.tranehome.com/mobile/';
export const NEXIA_BASE_URL = 'https://www.mynexia.com/mobile/';
export const ASAIR_BASE_URL = 'https://asairhome.com/mobile/';

export const BRANDS = ['trane', 'nexia', 'asair'] as const;
export type BrandName = typeof BRANDS[number];

export function baseUrlFor(brand: BrandName): string {
  switch (brand) {
    case 'trane': return TRANE_BASE_URL;
    case 'nexia': return NEXIA_BASE_URL;
    case 'asair': return ASAIR_BASE_URL;
  }
}
