import { NotFoundException } from '@nestjs/common';
import { MediaController } from './media.controller';

describe('MediaController', () => {
  it('never serves a private chat attachment on the public proxy', async () => {
    const storage = { getObject: jest.fn() };
    const media = new MediaController(storage as never);
    for (const key of ['chat/c1/abc.png', ['chat', 'c1', 'abc.png']]) {
      await expect(
        media.get(key, undefined, undefined, undefined, undefined, {} as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(storage.getObject).not.toHaveBeenCalled();
  });
});
