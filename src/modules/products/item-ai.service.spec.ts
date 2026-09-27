import { clipWords, ItemAiService } from './item-ai.service';

/** The service with the agent answering `reply` to card-copy. */
function withReply(reply: unknown) {
  const db = {
    query: {
      shops: {
        findFirst: () =>
          Promise.resolve({ id: 's', name: 'Shop', currency: 'BDT' }),
      },
    },
  };
  const svc = new ItemAiService(db as never);
  (svc as unknown as { post: () => Promise<unknown> }).post = () =>
    Promise.resolve(reply);
  return svc.cardCopy('s', {
    draft: { name: 'বাটিক থ্রী পিস' },
    templateName: 'Elegant Dress Collection',
    fields: [
      { key: 'description', maxLen: 20, maxLines: 1 },
      { key: 'campaignTitle', maxLen: 13, maxLines: 1 },
      { key: 'features', maxLen: 60, maxLines: 3 },
    ],
    locale: 'bn',
  } as never);
}

describe('ItemAiService.cardCopy', () => {
  it('keeps only the asked-for fields, as trimmed text within their limits', async () => {
    const { values } = await withReply({
      values: {
        description:
          '  খাঁটি সুতির আরামদায়ক বাটিক থ্রি পিস, সারাদিন পরার জন্য  ',
        campaignTitle: null,
        features: ['সুতি', 7, 'আরাম'],
        headline: 'not asked for',
      },
      ai_used: true,
    });
    expect(values).toEqual({
      description: 'খাঁটি সুতির',
      features: 'সুতি\nআরাম',
    });
  });

  it('answers empty rather than crash on a reply with no values', async () => {
    await expect(withReply({ values: 'oops' })).resolves.toEqual({
      values: {},
      aiUsed: false,
    });
    await expect(withReply({})).resolves.toEqual({
      values: {},
      aiUsed: false,
    });
  });
});

describe('clipWords', () => {
  it('leaves short text alone', () => {
    expect(clipWords('নতুন', 13)).toBe('নতুন');
  });
  it('cuts at a word boundary', () => {
    expect(clipWords('Pure cotton batik three piece', 16)).toBe('Pure cotton');
  });
  it('never splits a Bangla letter from its vowel sign', () => {
    // "আরামদায়ক" is one word; 7 code units would end on a bare consonant.
    const out = clipWords('আরামদায়কপোশাক', 7);
    expect('আরামদায়কপোশাক'.startsWith(out)).toBe(true);
    expect(out).not.toMatch(/[\u0995-\u09B9]$/u);
  });
});
