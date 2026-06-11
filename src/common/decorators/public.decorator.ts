import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as publicly accessible, bypassing a globally-registered
 * JwtAuthGuard. Use on storefront/product/checkout endpoints.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
