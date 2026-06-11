import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ShopRow } from '../../../database/schema';

/** Public-facing shop shape (the `Shop` interface from the design handoff). */
export class ShopResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() handle!: string;
  @ApiPropertyOptional() tagline?: string;
  @ApiProperty() cat!: string;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty() brandId!: string;
  @ApiProperty({ example: '#e8943a' }) brand!: string;
  @ApiProperty({ example: '#fbeede' }) brandSoft!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty() live!: boolean;
  @ApiProperty() createdAt!: string;

  static fromRow(row: ShopRow): ShopResponse {
    return {
      id: row.id,
      name: row.name,
      handle: row.handle,
      tagline: row.tagline ?? undefined,
      cat: row.cat,
      currency: row.currency,
      brandId: row.brandId,
      brand: row.brand,
      brandSoft: row.brandSoft,
      ownerId: row.ownerId,
      live: row.live,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
