import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ItemAiCardCopyDto, ItemAiTurnDto } from './item-ai.dto';

/**
 * The draft and flow are passed through to the assistant as plain objects.
 * The app validates every body with `whitelist` and `forbidNonWhitelisted`,
 * which strip or refuse properties a DTO does not declare - so these pin that
 * the nested objects survive intact, while the envelope itself stays strict.
 */
const pipes = [
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
];

const body = (metatype: unknown) => ({ type: 'body' as const, metatype: metatype as never, data: '' });

describe.each(pipes.map((p, i) => [i === 0 ? 'with transform' : 'without transform', p] as const))(
  'item AI DTOs under the app validation rules (%s)',
  (_label, pipe) => {
    it('keeps a nested draft and flow exactly as sent', async () => {
      const turn = {
        draft: { name: 'Cotton Panjabi', price: 1499, listingType: 'sale', deliveryDhaka: 70 },
        flow: { hasImage: true, imageChoice: 'card', skipped: ['blurb'] },
        history: [{ role: 'user', content: 'cotton panjabi' }],
        event: { type: 'message', text: 'price 1499' },
        locale: 'bn',
      };
      const out = (await pipe.transform(turn, body(ItemAiTurnDto))) as ItemAiTurnDto;
      expect(out.draft).toEqual(turn.draft);
      expect(out.flow).toEqual(turn.flow);
      expect(out.event.text).toBe('price 1499');
    });

    it('refuses a shop id smuggled into the envelope', async () => {
      await expect(
        pipe.transform({ event: { type: 'start' }, shopId: 'someone-elses-shop' }, body(ItemAiTurnDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an event type the assistant does not handle', async () => {
      await expect(
        pipe.transform({ event: { type: 'create_product' } }, body(ItemAiTurnDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an oversized history', async () => {
      const history = Array.from({ length: 25 }, () => ({ role: 'user', content: 'hi' }));
      await expect(
        pipe.transform({ event: { type: 'start' }, history }, body(ItemAiTurnDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts card copy fields and refuses an absurd length', async () => {
      const ok = {
        draft: { name: 'Cotton Panjabi' },
        templateName: 'Eid Panjabi Luxe',
        fields: [{ key: 'headline', maxLen: 32, maxLines: 2 }],
      };
      await expect(pipe.transform(ok, body(ItemAiCardCopyDto))).resolves.toBeDefined();
      await expect(
        pipe.transform({ ...ok, fields: [{ key: 'headline', maxLen: 5000 }] }, body(ItemAiCardCopyDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  },
);
