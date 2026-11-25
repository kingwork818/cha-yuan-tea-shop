/**
 * Outgoing mail: order receipts, refund notices, dispatch notices.
 *
 * Why this file exists at all: the checkout page says "You will receive an email
 * receipt immediately", the thank-you page says "A receipt has been sent to …",
 * and the order-lookup page asks for "the order number from your confirmation
 * email". Until now the shop had no mail code whatsoever, so every one of those
 * sentences was false at the moment money changed hands — and the lookup page was
 * unusable, because the number it asks for was only ever meant to arrive by mail.
 *
 * Two rules shape the design:
 *
 *   1. **Nothing is promised that cannot be delivered.** Every template takes a
 *      `mailEnabled` fact from config; when SMTP is not configured the storefront
 *      shows different copy rather than a false promise. See views that branch on
 *      `mail.enabled`.
 *
 *   2. **Every attempt is recorded.** A receipt that failed to send looks exactly
 *      like one that was never sent, from the customer's side. `mail_log` keeps
 *      the attempt and the provider's error so the back office can answer "did
 *      this customer actually get their receipt?" without reading server logs.
 *
 * Transport is plain SMTP over node:net/node:tls rather than a mail library. The
 * application needs exactly one thing from SMTP — submit a UTF-8 message to one
 * authenticated relay — and that is a hundred lines of well-specified protocol
 * against a dependency that would otherwise pull a parser for a format this file
 * writes itself. See docs/email-setup.md for the credentials.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import config from './config.mjs';
import { run as dbRun, all as dbAll, get as dbGet } from './db.mjs';

export const mailEnabled = () => config.mail.enabled;

/* -------------------------------------------------------------------------- */
/*  SMTP                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The subset of SMTP that matters here.
 *
 * A conversation, not a request: the server greets, we EHLO, optionally upgrade
 * to TLS, authenticate, then one MAIL FROM / RCPT TO / DATA. Every step has a
 * reply code that must start with 2 or 3, and every failure has to be reported
 * with the server's own words — "550 5.7.1 Message rejected" tells an operator
 * what to fix; "send failed" does not.
 */
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    /** Completed replies waiting to be read. */
    this.queue = [];
    this.waiter = null;
    this.waiterTimer = null;
    this.closedError = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    // A relay that never answers must not hang a checkout for a minute.
    socket.setTimeout(timeoutMs, () => this.onClose(new Error('SMTP timed out')));
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.onClose(err));
    socket.on('close', () => this.onClose(new Error('SMTP connection closed')));
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const index = this.buffer.indexOf('\r\n');
      if (index === -1) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      /*
       * A multi-line reply continues while the fourth character is a hyphen and
       * ends when it is a space. Reading only the first line of an EHLO response
       * would miss the AUTH capability list, which is how the first version of
       * this decided there was no way to authenticate.
       */
      if (line.length >= 4 && line[3] === ' ') {
        const text = this.lines.join('\n');
        const code = Number(line.slice(0, 3));
        this.lines = [];
        this.push({ code, text });
      }
    }
  }

  push(reply) {
    if (!this.waiter) {
      this.queue.push(reply);
      return;
    }
    const { resolve, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    resolve(reply);
  }

  onClose(error) {
    if (this.closedError) return;
    this.closedError = error;
    if (this.waiter) {
      const { reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      reject(error);
    }
  }

  /** The next server reply, whether it already arrived or has yet to. */
  read() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('SMTP reply timed out'));
      }, timeoutMs);
      timer.unref?.();
      this.waiter = { resolve, reject, timer };
    });
  }

  write(line) {
    if (this.closedError) throw this.closedError;
    this.socket.write(`${line}\r\n`);
  }

  /** Send a command and require a reply class (2xx or 3xx by default). */
  async command(line, { expect = [2, 3] } = {}) {
    this.write(line);
    const reply = await this.read();
    if (!expect.includes(Math.floor(reply.code / 100))) {
      throw new Error(`SMTP ${line.split(' ')[0]} rejected: ${reply.text}`);
    }
    return reply;
  }

  /** Upgrade a plain connection to TLS, keeping the same session state. */
  async startTls() {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    const upgraded = await new Promise((resolve, reject) => {
      const socket = tls.connect({ socket: plain, servername: host }, () => resolve(socket));
      socket.once('error', reject);
    });
    this.buffer = '';
    this.lines = [];
    this.queue = [];
    this.closedError = null;
    this.attach(upgraded);
  }

  close() {
    try {
      this.socket.write('QUIT\r\n');
    } catch {
      /* the relay may already be gone; nothing to do */
    }
    this.socket.destroy();
  }
}

const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS) || 20000;
const host = config.mail.host;

/** Open a connection, encrypted from the first byte on port 465. */
async function connect() {
  const { host: hostname, port, secure } = config.mail;
  const socket = secure
    ? await new Promise((resolve, reject) => {
        const s = tls.connect({ host: hostname, port, servername: hostname }, () => resolve(s));
        s.once('error', reject);
      })
    : await new Promise((resolve, reject) => {
        const s = net.connect({ host: hostname, port }, () => resolve(s));
        s.once('error', reject);
      });
  return new SmtpSession(socket);
}

/**
 * Authenticate.
 *
 * Only PLAIN and LOGIN are implemented: both are offered over TLS by Fastmail,
 * Google, Microsoft and every transactional provider. If a relay offers neither,
 * the error names what it did offer rather than guessing at a mechanism.
 */
async function authenticate(session) {
  const { user, pass } = config.mail;
  const ehlo = await session.command(`EHLO ${heloName}`, { expect: [2] });
  const mechanisms = (ehlo.text.match(/AUTH[ =]([^\r\n]+)/i)?.[1] || '').toUpperCase();

  if (mechanisms.includes('PLAIN')) {
    const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
    await session.command(`AUTH PLAIN ${token}`, { expect: [2] });
    return;
  }
  if (mechanisms.includes('LOGIN')) {
    await session.command('AUTH LOGIN', { expect: [3] });
    await session.command(Buffer.from(user, 'utf8').toString('base64'), { expect: [3] });
    await session.command(Buffer.from(pass, 'utf8').toString('base64'), { expect: [2] });
    return;
  }
  throw new Error(`SMTP server offers no supported AUTH mechanism (offered: ${mechanisms || 'none'})`);
}

const heloName = (config.mail.fromAddress.split('@')[1] || 'localhost').toLowerCase();

/** Deliver one already-composed message. Throws with the relay's own words. */
export async function deliver({ to, subject, text, html }) {
  if (!config.mail.enabled) throw new Error(`mail is not configured (${config.mail.reason})`);

  const session = await connect();
  try {
    await session.read(); // 220 greeting, which may have arrived before we asked
    if (!config.mail.secure) {
      const caps = await session.command(`EHLO ${heloName}`, { expect: [2] });
      if (/STARTTLS/i.test(caps.text)) {
        await session.command('STARTTLS', { expect: [2] });
        await session.startTls();
      }
    }
    await authenticate(session);
    await session.command(`MAIL FROM:<${config.mail.fromAddress}>`, { expect: [2] });
    await session.command(`RCPT TO:<${to}>`, { expect: [2, 3] });
    await session.command('DATA', { expect: [3] });

    const message = compose({ to, subject, text, html });
    // Dot-stuffing: a body line of "." would otherwise end the DATA phase early.
    const wire = message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    session.write(`${wire}\r\n.`);
    const accepted = await session.read();
    if (Math.floor(accepted.code / 100) !== 2) {
      throw new Error(`SMTP rejected the message: ${accepted.text}`);
    }
    session.close();
    return { ok: true };
  } catch (err) {
    session.close();
    throw err;
  }
}

/**
 * Build the RFC 5322 message.
 *
 * Base64 for both bodies so the transport never has to care about line length,
 * dot-stuffing or an 8-bit path, and so a tea name in any script survives. The
 * Message-ID and Date are here rather than left to the relay: a receipt with no
 * Message-ID is the first thing a spam filter scores against.
 */
function compose({ to, subject, text, html }) {
  const domain = config.mail.fromAddress.split('@')[1] || 'localhost';
  const boundary = `--bpg-${crypto.randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${config.mail.from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    `Reply-To: ${config.mail.replyTo}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `X-Entity-Ref-ID: ${crypto.randomUUID()}`,
  ];

  if (!html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(text, 'utf8').toString('base64')),
    ].join('\r\n');
  }

  const plainPart = [
    `Content-Type: text/plain; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
  ].join('\r\n');
  const htmlPart = [
    `Content-Type: text/html; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html, 'utf8').toString('base64')),
  ].join('\r\n');

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    plainPart,
    `--${boundary}`,
    htmlPart,
    `--${boundary}--`,
  ].join('\r\n');
}

/** Non-ASCII subjects must be RFC 2047 encoded, or they arrive as mojibake. */
function encodeHeader(value) {
  const text = String(value || '');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?utf-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** Base64 lines must not exceed 76 characters. */
const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

/* -------------------------------------------------------------------------- */
/*  Message bodies                                                            */
/* -------------------------------------------------------------------------- */

const money = (cents, currency = config.store.currency) =>
  `${currency} ${(Number(cents || 0) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function shell({ heading, lead, body, footerNote }) {
  const year = new Date().getFullYear();
  const company = config.company;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f1e9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1e9;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#0d1f16;border:1px solid #22392c;">
        <tr><td style="padding:30px 32px 22px;border-bottom:1px solid #22392c;">
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:0.16em;color:#d9b96b;text-transform:uppercase;">
            ${escapeHtml(config.store.name)}
          </div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:0.24em;color:#8ba394;margin-top:6px;text-transform:uppercase;">
            ${escapeHtml(config.store.logoSubtitle)}
          </div>
        </td></tr>
        <tr><td style="padding:30px 32px 8px;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#f4efe3;">
          ${escapeHtml(heading)}
        </td></tr>
        <tr><td style="padding:0 32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.7;color:#c9d6cd;">
          ${lead}
        </td></tr>
        <tr><td style="padding:0 32px 28px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.7;color:#c9d6cd;">
          ${body}
        </td></tr>
        <tr><td style="padding:20px 32px 26px;border-top:1px solid #22392c;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.8;color:#8ba394;">
          ${footerNote || ''}
          <div style="margin-top:14px;color:#6f8a7c;">
            ${escapeHtml(company.legalName)}<br />
            ${company.addressLines.map((l) => escapeHtml(l)).join('<br />')}<br />
            <a href="mailto:${escapeHtml(company.email)}" style="color:#d9b96b;text-decoration:none;">${escapeHtml(company.email)}</a>
            &nbsp;·&nbsp; ${escapeHtml(company.phone)}<br />
            Every order is packed and dispatched from our warehouse in China within 48 hours.
          </div>
          <div style="margin-top:10px;color:#556e61;">© ${year} ${escapeHtml(company.legalName)}. All rights reserved.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function orderTable(order) {
  const rows = order.items
    .map(
      (item) => `        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #22392c;color:#c9d6cd;">${escapeHtml(item.product_name)}
            <span style="display:block;color:#6f8a7c;font-size:11px;">${escapeHtml(item.variant_label)} · ${escapeHtml(item.sku)}</span>
          </td>
          <td align="center" style="padding:9px 0;border-bottom:1px solid #22392c;color:#8ba394;">${item.quantity}</td>
          <td align="right" style="padding:9px 0;border-bottom:1px solid #22392c;color:#c9d6cd;">${money(item.line_total_cents, order.currency)}</td>
        </tr>`,
    )
    .join('\n');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:6px 0 14px;">
      <tr>
        <th align="left" style="padding:0 0 8px;color:#8ba394;font-weight:normal;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Item</th>
        <th align="center" style="padding:0 0 8px;color:#8ba394;font-weight:normal;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Qty</th>
        <th align="right" style="padding:0 0 8px;color:#8ba394;font-weight:normal;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Line</th>
      </tr>
${rows}
      <tr><td style="padding:10px 0 2px;color:#8ba394;">Subtotal</td><td></td><td align="right" style="padding:10px 0 2px;color:#c9d6cd;">${money(order.subtotal_cents, order.currency)}</td></tr>
      <tr><td style="padding:2px 0;color:#8ba394;">Shipping (${escapeHtml(order.shipping_method)})</td><td></td><td align="right" style="padding:2px 0;color:#c9d6cd;">${order.shipping_cents === 0 ? 'Complimentary' : money(order.shipping_cents, order.currency)}</td></tr>
      <tr><td style="padding:2px 0;color:#8ba394;">${escapeHtml(config.store.taxLabel)}</td><td></td><td align="right" style="padding:2px 0;color:#c9d6cd;">${money(order.tax_cents, order.currency)}</td></tr>
      <tr><td style="padding:10px 0 0;color:#f4efe3;font-weight:bold;border-top:1px solid #22392c;">Total paid</td><td></td><td align="right" style="padding:10px 0 0;color:#d9b96b;font-weight:bold;border-top:1px solid #22392c;">${money(order.total_cents, order.currency)}</td></tr>
    </table>`;
}

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The receipt.
 *
 * Deliberately carries the order number in the subject and in the body: the
 * order-lookup page asks customers for it, so it has to be somewhere they can
 * find it after the tab is closed.
 */
export function renderOrderReceipt(order) {
  const firstName = String(order.customer_name || '').split(' ')[0] || 'there';
  const subject = `Your ${config.store.name} order ${order.order_number}`;
  const heading = 'Thank you — your order is confirmed';
  const lead = `<p style="margin:0 0 14px;">Hello ${escapeHtml(firstName)},</p>
    <p style="margin:0;">We have your payment and your order is confirmed. Your order number is
    <strong style="color:#d9b96b;">${escapeHtml(order.order_number)}</strong> — keep it, you can use it with
    your email address to track the order at any time.</p>`;

  const body = `${orderTable(order)}
    <p style="margin:0 0 14px;"><strong style="color:#f4efe3;">Dispatch</strong><br />
    Every order is packed by hand and dispatched from our warehouse in China within 48 hours, with tracking.
    Delivery is normally 10–25 business days by standard post, or 7–15 by express.</p>
    <p style="margin:0 0 14px;"><strong style="color:#f4efe3;">Shipping to</strong><br />
    ${escapeHtml(order.shipping_name)}<br />
    ${escapeHtml(order.shipping_line1)}${order.shipping_line2 ? `<br />${escapeHtml(order.shipping_line2)}` : ''}<br />
    ${escapeHtml(order.shipping_city)}, ${escapeHtml(order.shipping_province)} ${escapeHtml(order.shipping_postal_code)}<br />
    ${escapeHtml(order.shipping_country)}</p>
    <p style="margin:0;">If anything is wrong — the wrong piece, a damaged parcel, a change of mind — reply to this
    email within 30 days and we will sort it out.</p>`;

  const text = [
    `${config.store.name} — order confirmed`,
    '',
    `Hello ${firstName},`,
    '',
    `Thank you. We have your payment and your order is confirmed.`,
    `Order number: ${order.order_number}`,
    '',
    'Items',
    ...order.items.map((i) => `  ${i.quantity} x ${i.product_name} (${i.variant_label}) — ${money(i.line_total_cents, order.currency)}`),
    '',
    `Subtotal:  ${money(order.subtotal_cents, order.currency)}`,
    `Shipping:  ${order.shipping_cents === 0 ? 'Complimentary' : money(order.shipping_cents, order.currency)} (${order.shipping_method})`,
    `${config.store.taxLabel}:  ${money(order.tax_cents, order.currency)}`,
    `Total paid: ${money(order.total_cents, order.currency)}`,
    '',
    'Shipping to',
    `  ${order.shipping_name}`,
    `  ${order.shipping_line1}`,
    ...(order.shipping_line2 ? [`  ${order.shipping_line2}`] : []),
    `  ${order.shipping_city}, ${order.shipping_province} ${order.shipping_postal_code}`,
    `  ${order.shipping_country}`,
    '',
    'Dispatched from our warehouse in China within 48 hours, with tracking.',
    'Delivery is normally 10–25 business days by standard post, or 7–15 by express.',
    '',
    '--',
    config.company.legalName,
    ...config.company.addressLines,
    `${config.company.email} · ${config.company.phone}`,
  ].join('\n');

  return {
    subject,
    text,
    html: shell({ heading, lead, body, footerNote: 'You are receiving this because you placed an order with us.' }),
  };
}

/** A refund happened, in whole or in part. */
export function renderRefundNotice(order, { amountCents, full }) {
  const subject = full
    ? `Your ${config.store.name} order ${order.order_number} has been refunded`
    : `A refund has been issued for order ${order.order_number}`;
  const heading = full ? 'Your order has been refunded' : 'A refund is on its way';
  const lead = `<p style="margin:0 0 14px;">We have refunded
    <strong style="color:#d9b96b;">${money(amountCents, order.currency)}</strong> against order
    <strong>${escapeHtml(order.order_number)}</strong>.</p>
    <p style="margin:0;">It goes back to the card you paid with. Card refunds normally appear on your statement
    within 5–10 business days, depending on your bank — we cannot send it to a different card or as cash.</p>`;
  const body = `<p style="margin:0;">If it has not appeared after 10 business days, reply to this email with the
    order number and we will trace it with our payment provider.</p>`;

  const text = [
    `${config.store.name} — refund issued`,
    '',
    `Order:  ${order.order_number}`,
    `Amount: ${money(amountCents, order.currency)}`,
    '',
    'Refunded to the original card. Card refunds normally appear within 5-10 business days.',
    '',
    '--',
    config.company.legalName,
    `${config.company.email} · ${config.company.phone}`,
  ].join('\n');

  return { subject, text, html: shell({ heading, lead, body }) };
}

/** The parcel went out, with tracking. */
export function renderDispatchNotice(order, { trackingNumber, carrier }) {
  const subject = `Order ${order.order_number} has been dispatched`;
  const heading = 'Your order is on its way';
  const reference = trackingNumber
    ? `<p style="margin:0 0 14px;"><strong style="color:#f4efe3;">Tracking</strong><br />
       ${escapeHtml(carrier || 'Carrier')} · <span style="color:#d9b96b;">${escapeHtml(trackingNumber)}</span></p>`
    : '';
  const lead = `<p style="margin:0 0 14px;">Order <strong>${escapeHtml(order.order_number)}</strong> left our
    warehouse today and is on its way to you.</p>${reference}
    <p style="margin:0;">Delivery is normally 10–25 business days by standard post, or 7–15 by express. These are
    estimates rather than guarantees, because the parcel clears customs on the way.</p>`;
  const body = `<p style="margin:0;">If the tracking has not moved for more than ten days, reply to this email and
    we will chase the carrier for you.</p>`;

  const text = [
    `${config.store.name} — order dispatched`,
    '',
    `Order: ${order.order_number}`,
    ...(trackingNumber ? [`Tracking: ${carrier || 'carrier'} ${trackingNumber}`] : []),
    '',
    'Delivery is normally 10-25 business days by standard post, or 7-15 by express.',
    '',
    '--',
    config.company.legalName,
    `${config.company.email} · ${config.company.phone}`,
  ].join('\n');

  return { subject, text, html: shell({ heading, lead, body }) };
}

/* -------------------------------------------------------------------------- */
/*  Sending                                                                   */
/* -------------------------------------------------------------------------- */

function logAttempt({ kind, recipient, subject, orderNumber, status, error }) {
  try {
    dbRun(
      `INSERT INTO mail_log (kind, recipient, subject, order_number, status, error)
       VALUES (?,?,?,?,?,?)`,
      String(kind),
      String(recipient || ''),
      String(subject || ''),
      String(orderNumber || ''),
      String(status),
      String(error || '').slice(0, 1000),
    );
  } catch (err) {
    console.error(`[mail] could not record attempt: ${err.message}`);
  }
}

/**
 * Send one message and record the outcome.
 *
 * Never throws: a mail failure must not undo a payment or a refund that already
 * happened at the gateway. The caller gets `{ok, error}` and the back office gets
 * a row it can show a customer who says nothing arrived.
 */
export async function send({ kind, to, subject, text, html, orderNumber = '' }) {
  if (!to || !String(to).includes('@')) {
    logAttempt({ kind, recipient: to, subject, orderNumber, status: 'skipped', error: 'no recipient address' });
    return { ok: false, error: 'no recipient address', skipped: true };
  }
  if (!config.mail.enabled) {
    logAttempt({ kind, recipient: to, subject, orderNumber, status: 'skipped', error: `mail not configured (${config.mail.reason})` });
    return { ok: false, error: 'mail not configured', skipped: true };
  }
  try {
    await deliver({ to, subject, text, html });
    logAttempt({ kind, recipient: to, subject, orderNumber, status: 'sent' });
    return { ok: true };
  } catch (err) {
    logAttempt({ kind, recipient: to, subject, orderNumber, status: 'failed', error: err.message });
    console.error(`[mail] ${kind} to ${to} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Order paid → receipt. Safe to call more than once; the receipt is idempotent in content. */
export async function sendOrderReceipt(order) {
  const rendered = renderOrderReceipt(order);
  return send({ kind: 'order.receipt', to: order.customer_email, orderNumber: order.order_number, ...rendered });
}

export async function sendRefundNotice(order, { amountCents, full = false }) {
  const rendered = renderRefundNotice(order, { amountCents, full });
  return send({ kind: 'order.refund', to: order.customer_email, orderNumber: order.order_number, ...rendered });
}

export async function sendDispatchNotice(order, { trackingNumber = '', carrier = '' }) {
  const rendered = renderDispatchNotice(order, { trackingNumber, carrier });
  return send({ kind: 'order.shipped', to: order.customer_email, orderNumber: order.order_number, ...rendered });
}

/** Recent attempts, for the back office. */
export function recentMail(limit = 50) {
  try {
    return dbAll('SELECT * FROM mail_log ORDER BY id DESC LIMIT ?', Math.min(200, Number(limit) || 50));
  } catch {
    return [];
  }
}

/** Every attempt made for one order, so a "nothing arrived" complaint is checkable. */
export function mailForOrder(orderNumber, limit = 20) {
  try {
    return dbAll(
      'SELECT * FROM mail_log WHERE order_number = ? ORDER BY id DESC LIMIT ?',
      String(orderNumber),
      Math.min(100, Number(limit) || 20),
    );
  } catch {
    return [];
  }
}

/** Counts for the dashboard: sent, failed and skipped in the last week. */
export function mailSummary() {
  try {
    return {
      sent: dbGet("SELECT COUNT(*) AS n FROM mail_log WHERE status = 'sent'")?.n ?? 0,
      failed: dbGet("SELECT COUNT(*) AS n FROM mail_log WHERE status = 'failed'")?.n ?? 0,
      skipped: dbGet("SELECT COUNT(*) AS n FROM mail_log WHERE status = 'skipped'")?.n ?? 0,
      week: dbGet("SELECT COUNT(*) AS n FROM mail_log WHERE status = 'sent' AND created_at >= datetime('now','-7 days')")?.n ?? 0,
    };
  } catch {
    return { sent: 0, failed: 0, skipped: 0, week: 0 };
  }
}

