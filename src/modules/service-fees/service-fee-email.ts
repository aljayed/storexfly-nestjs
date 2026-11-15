export type ServiceFeeEmailEvent = 'over' | 'suspended' | 'restored';

export interface ServiceFeeEmailInput {
  event: ServiceFeeEmailEvent;
  shopName: string;
  ownerName?: string | null;
  amount: string;
  payBy: string;
  feePercent: number;
  webUrl: string;
}

/** Transactional balance notices: inline styles and presentation tables work
 * without remote images, web fonts, scripts, or a mail client's stylesheet. */
export function serviceFeeEmail(input: ServiceFeeEmailInput) {
  const { event, shopName, amount, payBy, feePercent } = input;
  const url = new URL('/admin/settlements', input.webUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The seller console URL must use HTTP or HTTPS.');
  }
  url.hash = 'service-fees';
  const consoleUrl = url.toString();
  const name = input.ownerName?.trim().split(/\s+/)[0] || 'there';
  const balanceName = feePercent === 0 ? 'supplier balance' : 'service fee balance';
  const balanceSource = feePercent === 0
    ? 'reseller money you collected or online processing your proceeds did not cover'
    : 'orders you collected payment for';
  const copy = {
    over: {
      subject: `${shopName}: ${balanceName} of ${amount} to pay by ${payBy}`,
      preview: `${shopName} has ${amount} to pay by ${payBy}. Review your balance in Payouts.`,
      status: 'Payment reminder',
      title: 'Let’s keep your shop moving.',
      intro: `Your shop ${shopName} has a ${balanceName} from ${balanceSource}. Here’s a quick overview so you can take care of it.`,
      label: 'Outstanding balance',
      value: amount,
      detailLabel: 'Please pay by',
      detail: payBy || 'See Payouts',
      note: `Please clear this balance${payBy ? ` by ${payBy}` : ''} to keep your shop open and ready for customers.`,
      action: 'Pay now',
      actionHint: 'Review your statement and choose a payment method in your seller console.',
      closing: 'Thanks for growing your business with Hoomri.',
    },
    suspended: {
      subject: `${shopName} is paused until its outstanding balance is paid`,
      preview: `Clear the ${amount} ${balanceName} to reopen ${shopName}.`,
      status: 'Shop temporarily paused',
      title: 'Let’s get your shop back open.',
      intro: `Your shop ${shopName} is temporarily paused because its ${balanceName} wasn’t paid in time. Your shop and order records are still here.`,
      label: 'Outstanding balance',
      value: amount,
      detailLabel: 'Shop status',
      detail: 'Temporarily paused',
      note: 'Clear the outstanding balance to reopen your shop. We’ll restore access once your payment is confirmed and the balance is cleared.',
      action: 'Pay now',
      actionHint: 'Review your statement and choose a payment method in your seller console.',
      closing: 'We look forward to welcoming your customers back.',
    },
    restored: {
      subject: `${shopName} is open again`,
      preview: `Good news! The outstanding balance for ${shopName} is cleared and your shop is live again.`,
      status: 'Shop open again',
      title: 'You’re back in business.',
      intro: `Good news! The outstanding balance for ${shopName} is cleared and your shop is live again. Thank you for taking care of it.`,
      label: 'Account status',
      value: 'All clear',
      detailLabel: 'Shop status',
      detail: 'Open for business',
      note: 'You can review your latest balance and payment history in Payouts whenever you need to.',
      action: 'View payouts',
      actionHint: 'Your latest balance and payment history, all in one place.',
      closing: 'Here’s to your next sale. Thanks for being part of Hoomri.',
    },
  }[event];
  const greeting = `Hi ${name},`;
  const text = [
    greeting, copy.title, copy.intro,
    `${copy.label}: ${copy.value}\n${copy.detailLabel}: ${copy.detail}`,
    copy.note, `${copy.action}: ${consoleUrl}`, copy.actionHint,
    `If you manage more than one shop, select ${shopName} in the console before continuing.`,
    'For help, open Messages in your seller console and contact Hoomri support.',
    copy.closing, 'The Hoomri team',
  ].join('\n\n');
  const e = escapeHtml;
  const restored = event === 'restored';
  const accent = restored ? '#23734b' : '#2f5be0';
  const tint = restored ? '#eef8f2' : '#f0f4ff';
  const badgeBg = event === 'suspended' ? '#fff0e9' : restored ? '#e8f5ed' : '#edf2ff';
  const badgeInk = event === 'suspended' ? '#9a4425' : restored ? '#23734b' : '#2446aa';

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${e(copy.subject)}</title>
<style>@media only screen and (max-width:600px){.email-shell{padding:20px 12px!important}.email-content{padding:26px 22px!important}.email-title{font-size:27px!important}.balance-cell{display:block!important;width:auto!important}.balance-detail{padding:0 20px 20px!important}.balance-value{font-size:38px!important}.email-footer{padding:22px!important}}</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:#f3f5f9;color:#202636;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;color:#f3f5f9;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${e(copy.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f5f9"><tr><td align="center" class="email-shell" style="padding:36px 20px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 8px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><span style="font-size:29px;font-weight:800;letter-spacing:-1.2px;color:#202636;">hoomri<span style="color:#2f5be0;">.</span></span></td><td align="right" style="font-size:10px;font-weight:700;letter-spacing:1.4px;color:#687386;">SELLER ACCOUNT</td></tr></table></td></tr>
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e2e7ef;border-radius:16px;overflow:hidden;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td height="5" bgcolor="${accent}" style="height:5px;line-height:5px;font-size:1px;border-radius:16px 16px 0 0;">&nbsp;</td></tr>
<tr><td class="email-content" style="padding:34px 36px 30px;">
<p style="margin:0 0 26px;"><span style="display:inline-block;padding:7px 11px;border-radius:6px;background-color:${badgeBg};color:${badgeInk};font-size:11px;font-weight:700;">${e(copy.status)}</span></p>
<p style="margin:0 0 12px;font-size:14px;line-height:22px;color:#4f5b6d;">${e(greeting)}</p>
<h1 class="email-title" style="margin:0 0 16px;font-size:31px;font-weight:700;line-height:1.22;letter-spacing:-.8px;color:#202636;">${e(copy.title)}</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:24px;color:#536074;">${e(copy.intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${tint}" style="background-color:${tint};border:1px solid ${restored ? '#d3e9dc' : '#dce4fc'};border-radius:12px;">
<tr><td class="balance-cell" width="58%" style="padding:22px 20px;vertical-align:middle;"><p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#52617b;">${e(copy.label)}</p><p class="balance-value" style="margin:0;font-size:42px;line-height:1.15;font-weight:700;letter-spacing:-1.5px;color:${accent};">${e(copy.value)}</p></td>
<td class="balance-cell balance-detail" style="padding:22px 20px;vertical-align:middle;"><p style="margin:0 0 8px;font-size:11px;color:#52617b;">${e(copy.detailLabel)}</p><p style="margin:0;font-size:16px;line-height:24px;font-weight:700;color:#25334d;">${e(copy.detail)}</p></td></tr>
<tr><td colspan="2" style="padding:12px 20px;border-top:1px solid ${restored ? '#d3e9dc' : '#dce4fc'};font-size:11px;line-height:18px;color:#52617b;">Shop: <strong style="color:#25334d;">${e(shopName)}</strong></td></tr></table>
<p style="margin:22px 0;font-size:14px;line-height:24px;color:#536074;">${e(copy.note)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<!--[if mso]><v:roundrect href="${e(consoleUrl)}" style="height:50px;v-text-anchor:middle;width:260px;" arcsize="16%" stroke="f" fillcolor="${accent}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${e(copy.action)} &#8594;</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${e(consoleUrl)}" target="_blank" style="display:block;background-color:${accent};border:1px solid ${accent};border-radius:8px;color:#ffffff;font-size:15px;font-weight:700;line-height:22px;text-align:center;text-decoration:none;padding:15px 24px;mso-hide:all;">${e(copy.action)}&nbsp; &#8594;</a><!--<![endif]-->
</td></tr></table>
<p style="margin:11px 0 0;font-size:11px;line-height:19px;text-align:center;color:#69768a;">${e(copy.actionHint)}</p>
<p style="margin:22px 0 0;font-size:11px;line-height:19px;color:#69768a;">Manage multiple shops? Select <strong>${e(shopName)}</strong> in your console before continuing.</p>
<p style="margin:26px 0 0;font-size:13px;line-height:22px;color:#536074;">${e(copy.closing)}<br><strong style="color:#25334d;">The Hoomri team</strong></p>
</td></tr>
<tr><td class="email-footer" bgcolor="#fafbfe" style="padding:22px 36px;border-top:1px solid #e9edf3;border-radius:0 0 16px 16px;"><p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#3b475b;">Need a hand?</p><p style="margin:0;font-size:11px;line-height:19px;color:#69768a;">Open Messages in your seller console and contact Hoomri support.</p></td></tr>
</table></td></tr>
<tr><td style="padding:23px 8px 0;text-align:center;"><p style="margin:0 0 10px;font-size:10px;line-height:18px;color:#798496;">Button not working? Copy this link into your browser:<br><a href="${e(consoleUrl)}" style="color:#536781;text-decoration:underline;word-break:break-all;">${e(consoleUrl)}</a></p><p style="margin:0;font-size:10px;line-height:18px;color:#798496;">You received this account update because you own ${e(shopName)} on Hoomri.</p></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
  return { subject: copy.subject, text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
