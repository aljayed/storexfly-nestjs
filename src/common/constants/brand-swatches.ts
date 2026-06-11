import { brandSwatchEnum } from '../../database/schema/enums';

export type BrandSwatchId = (typeof brandSwatchEnum.enumValues)[number];

export interface BrandSwatchDef {
  id: BrandSwatchId;
  c: string;
  soft: string;
  name: string;
}

/**
 * The six per-shop brand swatches from the create-shop wizard (README §2).
 * The selected swatch resolves to `brand`/`brandSoft` hex on the shop record,
 * which the Vue app cascades into `--brand` / `--brand-soft` CSS props.
 */
export const BRAND_SWATCHES: Record<BrandSwatchId, BrandSwatchDef> = {
  amber: { id: 'amber', c: '#e8943a', soft: '#fbeede', name: 'Mango' },
  blue: { id: 'blue', c: '#2f5be0', soft: '#e9eefc', name: 'Indigo' },
  green: { id: 'green', c: '#2f8f5b', soft: '#e2f1e8', name: 'Leaf' },
  rose: { id: 'rose', c: '#d6457f', soft: '#fbe4ee', name: 'Rose' },
  violet: { id: 'violet', c: '#6a52c9', soft: '#ebe6f8', name: 'Plum' },
  clay: { id: 'clay', c: '#c5563a', soft: '#f8e3dc', name: 'Clay' },
};

export const BRAND_SWATCH_LIST: BrandSwatchDef[] = Object.values(BRAND_SWATCHES);
