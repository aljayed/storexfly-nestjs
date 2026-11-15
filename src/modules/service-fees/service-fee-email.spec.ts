import { serviceFeeEmail, type ServiceFeeEmailInput } from './service-fee-email';
import { ServiceFeesService } from './service-fees.service';

const sample: ServiceFeeEmailInput = {
  event: 'over', shopName: 'Humri', ownerName: 'Shoaib Rahman', amount: '৳2,185',
  payBy: '18 November', feePercent: 4.5, webUrl: 'https://hoomri.com',
};

describe('Service fee notification emails', () => {
  it('makes the amount, deadline and actionable console link available in both formats', () => {
    const mail = serviceFeeEmail(sample);
    expect(mail.subject).toContain('৳2,185 to pay by 18 November');
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('৳2,185');
      expect(body).toContain('18 November');
      expect(body).toContain('https://hoomri.com/admin/settlements#service-fees');
      expect(body).toContain('Pay now');
      expect(body).toContain('Humri');
    }
    expect(mail.html).toContain('Hi Shoaib,');
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain('<v:roundrect href="https://hoomri.com/admin/settlements#service-fees"');
    expect(mail.html).not.toMatch(/<script|<svg|<img|<link/i);
    expect(Buffer.byteLength(mail.html)).toBeLessThan(100_000);
  });

  it('uses supplier balance wording for commission-free trade shops', () => {
    const mail = serviceFeeEmail({ ...sample, feePercent: 0 });
    expect(mail.subject).toContain('supplier balance');
    expect(mail.text).toContain('reseller money you collected');
    expect(mail.text).not.toContain('service fee balance');
    expect(mail.html).not.toContain('service fee balance');
  });

  it('gives paused shops a payment action without claiming the payment is already confirmed', () => {
    const mail = serviceFeeEmail({ ...sample, event: 'suspended' });
    expect(mail.subject).toContain('paused');
    expect(mail.text).toContain('Pay now:');
    expect(mail.text).toContain('once your payment is confirmed');
    expect(mail.html).toContain('Temporarily paused');
  });

  it('celebrates a restored shop without asking it to pay again', () => {
    const mail = serviceFeeEmail({ ...sample, event: 'restored' });
    expect(mail.subject).toBe('Humri is open again');
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('All clear');
      expect(body).toContain('View payouts');
      expect(body).not.toContain('Pay now');
      expect(body).not.toContain('৳2,185');
      expect(body).not.toContain('18 November');
    }
  });

  it('escapes user-controlled text in the HTML body and title', () => {
    const mail = serviceFeeEmail({ ...sample, ownerName: '<script>alert(1)</script>', shopName: 'A & B "Shop" </title><script>alert(1)</script>' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('A &amp; B &quot;Shop&quot;');
    expect(mail.text).toContain('A & B "Shop"');
  });

  it('uses the configured app origin in development and separate console deployments', () => {
    expect(serviceFeeEmail({ ...sample, webUrl: 'http://localhost:5173/' }).text).toContain('http://localhost:5173/admin/settlements#service-fees');
    expect(serviceFeeEmail({ ...sample, webUrl: 'https://admin.hoomri.com/' }).text).toContain('https://admin.hoomri.com/admin/settlements#service-fees');
    expect(() => serviceFeeEmail({ ...sample, webUrl: 'javascript:alert(1)' })).toThrow();
    expect(serviceFeeEmail({ ...sample, ownerName: '   ', payBy: '' }).html).toContain('Hi there,');
  });

  it('sends the template through the existing notification path with the Dhaka deadline', async () => {
    const service = Object.create(ServiceFeesService.prototype) as ServiceFeesService;
    const send = jest.fn().mockResolvedValue(undefined);
    const getOrThrow = jest.fn().mockReturnValue(sample.webUrl);
    Object.assign(service, {
      db: { query: { users: { findFirst: jest.fn().mockResolvedValue({ name: sample.ownerName, email: 'owner@example.com' }) } } },
      mail: { send }, config: { getOrThrow },
    });
    await service['tellOwner']({ name: sample.shopName, ownerId: 'owner' }, 'over', {
      shopId: 'shop', feePercent: 4.5, rows: [], balanceCents: 218500,
      overSince: new Date('2026-11-15T20:00:00Z'), suspended: false, standing: 'due',
    });
    expect(getOrThrow).toHaveBeenCalledWith('app.webUrl');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'owner@example.com' });
    expect(send.mock.calls[0][0].text).toContain('৳2,185');
    // 20:00 UTC is already the following calendar day in Dhaka.
    expect(send.mock.calls[0][0].text).toContain('19 November');
    expect(send.mock.calls[0][0].html).toContain('Pay now');
  });
});
