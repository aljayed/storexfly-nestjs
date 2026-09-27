import { ConversationsService } from './conversations.service';

/** The service with the shop/owner/admin lookup answering `row`. */
function withRow(row: object | undefined) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(row ? [row] : []),
  };
  const db = { select: () => chain };
  return new ConversationsService(db as never, {} as never);
}

const seller = (id: string) =>
  ({ role: 'seller', id, shopId: 'shop-humri', name: 'x' }) as const;

describe('ConversationsService.partySetFor (console sessions)', () => {
  it("adds the owner's own account when the console record is theirs", async () => {
    const svc = withRow({
      ownerId: 'acct-shoaib',
      ownerEmail: 'AlJayedShoaib@gmail.com',
      adminEmail: 'aljayedshoaib@gmail.com ',
    });
    await expect(svc.partySetFor(seller('admin-0a52'))).resolves.toEqual([
      { kind: 'shop', id: 'shop-humri' },
      { kind: 'account', id: 'acct-shoaib' },
    ]);
  });

  it('keeps invited staff to the shop alone', async () => {
    const svc = withRow({
      ownerId: 'acct-shoaib',
      ownerEmail: 'aljayedshoaib@gmail.com',
      adminEmail: 'helper@example.com',
    });
    await expect(svc.partySetFor(seller('admin-staff'))).resolves.toEqual([
      { kind: 'shop', id: 'shop-humri' },
    ]);
  });

  it('never matches on two missing emails', async () => {
    const svc = withRow({
      ownerId: 'acct-x',
      ownerEmail: null,
      adminEmail: null,
    });
    await expect(svc.partySetFor(seller('admin-y'))).resolves.toEqual([
      { kind: 'shop', id: 'shop-humri' },
    ]);
  });

  it('still accepts a session whose id is the account id', async () => {
    const svc = withRow({
      ownerId: 'acct-z',
      ownerEmail: null,
      adminEmail: null,
    });
    await expect(svc.partySetFor(seller('acct-z'))).resolves.toEqual([
      { kind: 'shop', id: 'shop-humri' },
      { kind: 'account', id: 'acct-z' },
    ]);
  });
});
