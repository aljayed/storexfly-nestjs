import { BadRequestException } from '@nestjs/common';
import { ChatOffersService } from './chat-offers.service';

describe('ChatOffersService participant contract', () => {
  const serviceFor = (participants: object[]) => {
    const db = {
      query: {
        chatParticipants: {
          findMany: jest.fn().mockResolvedValue(participants),
        },
      },
    };
    return new ChatOffersService(db as never, {} as never, {} as never);
  };

  it('derives the buyer and shop from participant rows', async () => {
    const service = serviceFor([
      { side: 'a', kind: 'account', accountId: 'buyer', shopId: null },
      { side: 'b', kind: 'shop', accountId: null, shopId: 'shop' },
    ]);
    await expect(service['commerceParties']('conversation')).resolves.toEqual({
      buyerId: 'buyer',
      shopId: 'shop',
    });
  });

  it.each([
    [
      { side: 'a', kind: 'account', accountId: 'one', shopId: null },
      { side: 'b', kind: 'account', accountId: 'two', shopId: null },
    ],
    [
      { side: 'a', kind: 'shop', accountId: null, shopId: 'shop' },
      { side: 'b', kind: 'support', accountId: null, shopId: null },
    ],
  ])('refuses non-commerce thread shape %#', async (...participants) => {
    const service = serviceFor(participants);
    await expect(
      service['commerceParties']('conversation'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
