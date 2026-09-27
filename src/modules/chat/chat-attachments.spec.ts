import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import type { SendMessageDto } from './dto/chat.dto';
import { MessagesService } from './messages.service';

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('rest of a png'),
]);
const dataUrl = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${bytes.toString('base64')}`;
const convo = {
  id: '11111111-1111-1111-1111-111111111111',
  shopId: null,
  buyerId: null,
  buyer: null,
  shop: null,
};

function service(opts: { enabled?: boolean; putFails?: boolean } = {}) {
  const storage = {
    enabled: opts.enabled ?? true,
    putPrivate: jest.fn(() =>
      opts.putFails ? Promise.reject(new Error('down')) : Promise.resolve(),
    ),
    getObject: jest.fn(),
  };
  const db = { query: { chatMessages: { findFirst: jest.fn() } } };
  const conversations = { requireParticipantRow: jest.fn() };
  const svc = new MessagesService(
    db as never,
    conversations as never,
    {} as never,
    {} as never,
    storage as never,
  );
  const build = (dto: Partial<SendMessageDto>) =>
    (
      svc as unknown as {
        buildTypedFields(
          d: unknown,
          c: unknown,
        ): Promise<{ attachment?: unknown }>;
      }
    ).buildTypedFields(dto, convo);
  return { svc, storage, db, build };
}

const image = (mime: string, bytes: Buffer) => ({
  type: 'image' as const,
  attachment: {
    kind: 'image' as const,
    fileName: 'photo.png',
    mimeType: mime,
    sizeBytes: 1,
    dataUrl: dataUrl(mime, bytes),
  },
});

describe('chat attachments', () => {
  it('stores the bytes privately under the thread and keeps only metadata', async () => {
    const { build, storage } = service();
    const fields = await build(image('image/png', PNG));
    const key = (storage.putPrivate.mock.calls[0] as unknown[])[0] as string;
    expect(key).toMatch(new RegExp(`^chat/${convo.id}/[0-9a-f]{64}\\.png$`));
    expect(fields.attachment).toEqual({
      kind: 'image',
      fileName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      key,
    });
  });

  it('lands a retry of the same bytes on the same object', async () => {
    const { build, storage } = service();
    await build(image('image/png', PNG));
    await build(image('image/png', PNG));
    const [a, b] = storage.putPrivate.mock.calls.map((c) => c[0] as string);
    expect(a).toBe(b);
  });

  it('refuses a photo whose bytes are not the type it claims', async () => {
    const { build, storage } = service();
    await expect(
      build(image('image/png', Buffer.from('<script>alert(1)</script>'))),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.putPrivate).not.toHaveBeenCalled();
  });

  it('refuses a payload padded with characters that are not base64', async () => {
    const { build } = service();
    const dto = image('image/png', PNG);
    dto.attachment.dataUrl += '!!!!!!!!';
    await expect(build(dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers a storage outage with a 5xx, so the client sends again', async () => {
    const { build } = service({ putFails: true });
    await expect(build(image('image/png', PNG))).rejects.toMatchObject({
      status: 503,
    });
  });

  it('keeps the bytes inline when no storage is configured', async () => {
    const { build, storage } = service({ enabled: false });
    const fields = await build(image('image/png', PNG));
    expect(storage.putPrivate).not.toHaveBeenCalled();
    expect(fields.attachment).toMatchObject({
      dataUrl: dataUrl('image/png', PNG),
    });
  });

  it('streams only an attachment of this thread that has a key', async () => {
    const { svc, db, storage } = service();
    const actor = { role: 'customer', id: 'buyer' } as never;
    db.query.chatMessages.findFirst.mockResolvedValueOnce({
      attachment: {
        kind: 'image',
        fileName: 'p.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        dataUrl: 'data:',
      },
    });
    await expect(svc.attachment(actor, convo.id, 'm1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const body = Readable.from(['abc']);
    db.query.chatMessages.findFirst.mockResolvedValueOnce({
      attachment: {
        kind: 'image',
        fileName: 'p.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        key: 'chat/x/y.png',
      },
    });
    storage.getObject.mockResolvedValueOnce({ body, contentType: 'image/png' });
    await expect(svc.attachment(actor, convo.id, 'm2')).resolves.toMatchObject({
      body,
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    expect(storage.getObject).toHaveBeenCalledWith('chat/x/y.png');
  });
});
