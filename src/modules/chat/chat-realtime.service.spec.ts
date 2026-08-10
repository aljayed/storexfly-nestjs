import { ChatRealtimeService } from './chat-realtime.service';

describe('ChatRealtimeService rooms', () => {
  it('uses party rooms rather than buyer/seller role rooms', () => {
    expect(
      ChatRealtimeService.partyRoom({ kind: 'account', id: 'rafiqul' }),
    ).toBe('account:rafiqul');
    expect(ChatRealtimeService.partyRoom({ kind: 'shop', id: 'rafiq' })).toBe(
      'shop:rafiq',
    );
    expect(ChatRealtimeService.partyRoom({ kind: 'support', id: null })).toBe(
      'support:support',
    );
  });

  it('deduplicates every party an owner listens as', () => {
    expect(
      ChatRealtimeService.actorRooms([
        { kind: 'account', id: 'owner' },
        { kind: 'shop', id: 'shop' },
        { kind: 'account', id: 'owner' },
      ]),
    ).toEqual(['account:owner', 'shop:shop']);
  });
});
