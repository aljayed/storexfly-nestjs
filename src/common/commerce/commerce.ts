import { BadRequestException, ConflictException } from '@nestjs/common';

export const COMMERCE_MODES = ['retail', 'reseller', 'wholesale'] as const;
export type CommerceMode = (typeof COMMERCE_MODES)[number];
export interface CommercePolicy {
  channels: CommerceMode[];
  resellerPriceCents?: number;
  wholesaleMoq?: number;
  wholesaleTiers?: { minQty: number; unitPriceCents: number }[];
}
export const DEFAULT_COMMERCE: CommercePolicy = { channels: ['retail'] };

/** Validate the whole effective policy, including on partial product updates. */
export function validateCommerce(policy: CommercePolicy): CommercePolicy {
  if (
    !policy ||
    !Array.isArray(policy.channels) ||
    !policy.channels.length ||
    new Set(policy.channels).size !== policy.channels.length ||
    policy.channels.some((mode) => !COMMERCE_MODES.includes(mode))
  ) {
    throw new BadRequestException(
      'Choose at least one valid commerce channel.',
    );
  }
  const money = (n: unknown): n is number =>
    Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 1_000_000_000;
  if (
    policy.resellerPriceCents !== undefined &&
    !money(policy.resellerPriceCents)
  ) {
    throw new BadRequestException('Enter a valid reseller supply price.');
  }
  if (
    policy.channels.includes('reseller') &&
    !policy.resellerPriceCents
  ) {
    throw new BadRequestException('Reseller products need a supply price.');
  }
  const tiers = [...(policy.wholesaleTiers ?? [])].sort(
    (a, b) => a.minQty - b.minQty,
  );
  const moq = policy.wholesaleMoq ?? 1;
  if (
    !Number.isSafeInteger(moq) ||
    moq < 1 ||
    moq > 1_000_000 ||
    tiers.length > 20
  ) {
    throw new BadRequestException(
      'Enter a valid wholesale minimum quantity and at most 20 price tiers.',
    );
  }
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (
      !Number.isSafeInteger(tier.minQty) ||
      tier.minQty < moq ||
      tier.minQty > 1_000_000 ||
      !money(tier.unitPriceCents) ||
      (i > 0 &&
        (tier.minQty === tiers[i - 1].minQty ||
          tier.unitPriceCents > tiers[i - 1].unitPriceCents))
    ) {
      throw new BadRequestException(
        'Wholesale tiers need unique quantities and prices that do not increase with quantity.',
      );
    }
  }
  if (
    policy.channels.includes('wholesale') &&
    tiers.some((tier) => tier.unitPriceCents <= 0)
  ) {
    throw new BadRequestException('Give every wholesale tier a price.');
  }
  if (
    policy.channels.includes('wholesale') &&
    (!tiers.length || tiers[0].minQty !== moq)
  ) {
    throw new BadRequestException(
      'The first wholesale tier must start at the minimum order quantity.',
    );
  }
  return { ...policy, wholesaleMoq: moq, wholesaleTiers: tiers };
}

/** Price physical units of one SKU. Inventory remains the supplier product's. */
export function commerceUnitPrice(
  policy: CommercePolicy | null | undefined,
  mode: CommerceMode,
  qty: number,
  retailCents: number,
): number {
  const config = policy ?? DEFAULT_COMMERCE;
  if (!config.channels.includes(mode))
    throw new ConflictException(
      `This product is not available for ${mode} orders.`,
    );
  if (mode === 'retail') return retailCents;
  if (mode === 'reseller') {
    if (config.resellerPriceCents === undefined)
      throw new ConflictException('Reseller pricing is unavailable.');
    return config.resellerPriceCents;
  }
  if (qty < (config.wholesaleMoq ?? 1))
    throw new ConflictException(
      `Minimum wholesale quantity is ${config.wholesaleMoq ?? 1} per variant.`,
    );
  const tier = [...(config.wholesaleTiers ?? [])]
    .sort((a, b) => b.minQty - a.minQty)
    .find((t) => qty >= t.minQty);
  if (!tier) throw new ConflictException('Wholesale pricing is unavailable.');
  return tier.unitPriceCents;
}

/**
 * A reseller offer's variant prices: the supplier's combination prices shifted
 * by the reseller's markup over retail. Floored at zero so a listing priced
 * below retail can never advertise a negative variant. Checkout uses the same
 * shift, so the page and the charge agree.
 */
export function resellerVariantCombinations<
  T extends { priceCents: number; comparePriceCents?: number | null },
>(
  product: { priceCents: number; variantCombinations: T[] },
  sellingPriceCents: number,
): T[] {
  const markup = sellingPriceCents - product.priceCents;
  return product.variantCombinations.map((v) => ({
    ...v,
    priceCents: Math.max(0, v.priceCents + markup),
    comparePriceCents: null,
  }));
}
