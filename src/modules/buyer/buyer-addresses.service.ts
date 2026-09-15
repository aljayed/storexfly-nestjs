import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type {
  DbExecutor,
  DrizzleDB,
  DrizzleTx,
} from '../../database/drizzle.types';
import { buyerAddresses, users } from '../../database/schema';
import { SaveBuyerAddressDto } from './dto/buyer-address.dto';

@Injectable()
export class BuyerAddressesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  // Everything the buyer sees about an address - the owning account id stays
  // on the server.
  private rows(db: DbExecutor, userId: string) {
    return db
      .select({
        id: buyerAddresses.id,
        label: buyerAddresses.label,
        name: buyerAddresses.name,
        phone: buyerAddresses.phone,
        address: buyerAddresses.address,
        city: buyerAddresses.city,
        pincode: buyerAddresses.pincode,
        geo: buyerAddresses.geo,
        isDefault: buyerAddresses.isDefault,
        createdAt: buyerAddresses.createdAt,
        updatedAt: buyerAddresses.updatedAt,
      })
      .from(buyerAddresses)
      .where(eq(buyerAddresses.userId, userId))
      .orderBy(
        desc(buyerAddresses.isDefault),
        asc(buyerAddresses.createdAt),
        asc(buyerAddresses.id),
      );
  }

  list(userId: string) {
    return this.rows(this.db, userId);
  }

  // Serialize writes per account, including concurrent first-address/default
  // changes. The partial unique index also enforces at most one default.
  private async lock(tx: DrizzleTx, userId: string) {
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!owner) throw new NotFoundException('Account not found');
  }

  private async syncDefault(tx: DrizzleTx, userId: string) {
    const [address] = await tx
      .select()
      .from(buyerAddresses)
      .where(
        and(
          eq(buyerAddresses.userId, userId),
          eq(buyerAddresses.isDefault, true),
        ),
      );
    // Legacy autofill stays useful. Recipient name/phone never change the
    // account identity or its verification status.
    await tx
      .update(users)
      .set({
        addressLine: address?.address ?? null,
        addressCity: address?.city ?? null,
        addressPincode: address?.pincode || null,
        geo: address?.geo ?? null,
      })
      .where(eq(users.id, userId));
  }

  async save(userId: string, dto: SaveBuyerAddressDto, id?: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      const rows = await this.rows(tx, userId);
      const existing = id ? rows.find((row) => row.id === id) : undefined;
      if (id && !existing) throw new NotFoundException('Address not found');
      if (!id && rows.length >= 20)
        throw new BadRequestException('You can save up to 20 addresses');
      const isDefault =
        !rows.length || !!existing?.isDefault || dto.isDefault === true;
      if (isDefault) {
        await tx
          .update(buyerAddresses)
          .set({ isDefault: false })
          .where(eq(buyerAddresses.userId, userId));
      }
      const values = {
        label: dto.label ?? '',
        name: dto.name,
        phone: dto.phone,
        address: dto.address,
        city: dto.city,
        pincode: dto.pincode ?? '',
        geo: dto.geo ?? null,
        isDefault,
      };
      if (id) {
        await tx
          .update(buyerAddresses)
          .set(values)
          .where(
            and(eq(buyerAddresses.id, id), eq(buyerAddresses.userId, userId)),
          );
      } else {
        await tx.insert(buyerAddresses).values({ ...values, userId });
      }
      await this.syncDefault(tx, userId);
      return this.rows(tx, userId);
    });
  }

  async setDefault(userId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      const rows = await this.rows(tx, userId);
      if (!rows.some((row) => row.id === id))
        throw new NotFoundException('Address not found');
      await tx
        .update(buyerAddresses)
        .set({ isDefault: false })
        .where(eq(buyerAddresses.userId, userId));
      await tx
        .update(buyerAddresses)
        .set({ isDefault: true })
        .where(
          and(eq(buyerAddresses.id, id), eq(buyerAddresses.userId, userId)),
        );
      await this.syncDefault(tx, userId);
      return this.rows(tx, userId);
    });
  }

  async remove(userId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      const rows = await this.rows(tx, userId);
      const removed = rows.find((row) => row.id === id);
      if (!removed) throw new NotFoundException('Address not found');
      await tx
        .delete(buyerAddresses)
        .where(
          and(eq(buyerAddresses.id, id), eq(buyerAddresses.userId, userId)),
        );
      const next = rows.find((row) => row.id !== id);
      if (removed.isDefault && next) {
        await tx
          .update(buyerAddresses)
          .set({ isDefault: true })
          .where(
            and(
              eq(buyerAddresses.id, next.id),
              eq(buyerAddresses.userId, userId),
            ),
          );
      }
      await this.syncDefault(tx, userId);
      return this.rows(tx, userId);
    });
  }
}
