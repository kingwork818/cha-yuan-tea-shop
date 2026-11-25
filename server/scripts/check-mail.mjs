/**
 * Mail checks: the SMTP conversation, and the templates that depend on it.
 *
 *   node server/scripts/check-mail.mjs
 *
 * The transport is a hand-written subset of SMTP, so it needs a test that does
 * not require a real mailbox and does not pretend a failure is a success. A tiny
 * server on localhost speaks the protocol back: greeting, EHLO, AUTH PLAIN,
 * envelope, DATA, and it records what actually arrived on the wire.
 *
 * What this proves, in order of how badly it would hurt to get wrong:
 *
 *   1. The client does not lose the server greeting. That greeting is sent before
 *      the client asks for anything, and the first draft of this client dropped it
 *      and hung — a bug that would only ever show up as "no receipts arrived".
 *   2. AUTH PLAIN actually authenticates, and the base64 credentials decode to
 *      what was configured.
 *   3. The message body survives the trip: header, base64 body, dot-stuffing.
 *   4. A send with no SMTP configured is recorded as `skipped` and does not throw,
 *      because a mail failure must never undo a payment.
 *   5. The receipt names the order number, because the order-lookup page tells
 *      customers to get it from this email.
 */
import net from 'node:net';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/* -------------------------------------------------------------------------- */
/*  A relay that records what it was told                                     */
/* -------------------------------------------------------------------------- */

const received = { commands: [], messages: [], auth: null };

function startFakeRelay() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let data = '';
      socket.write('220 fake.relay.test ESMTP ready\r\n');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const index = buffer.indexOf('\r\n');
          if (index === -1) return;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              received.messages.push(data);
              data = '';
              socket.write('250 2.0.0 Message accepted\r\n');
              continue;
            }
            // Undo dot-stuffing so the assertion sees the original body.
            data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
            continue;
          }

          received.commands.push(line);
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-fake.relay.test\r\n250-AUTH PLAIN LOGIN\r\n250-PIPELINING\r\n250 8BITMIME\r\n');
          } else if (upper.startsWith('AUTH PLAIN')) {
            const token = line.slice(10).trim();
            received.auth = { mechanism: 'PLAIN', decoded: Buffer.from(token, 'base64').toString('utf8') };
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (upper.startsWith('MAIL FROM')) {
            socket.write('250 2.1.0 Sender ok\r\n');
          } else if (upper.startsWith('RCPT TO')) {
            socket.write('250 2.1.5 Recipient ok\r\n');
          } else if (upper === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 OK\r\n');
          }
        }
      });

      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* -------------------------------------------------------------------------- */
/*  Configure, then import (config reads the environment once)                */
/* -------------------------------------------------------------------------- */

const { server, port } = await startFakeRelay();

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(port);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'support@bridgeportglobalinc.com';
process.env.SMTP_PASS = 'app-password-for-tests';
process.env.MAIL_FROM_ADDRESS = 'support@bridgeportglobalinc.com';
process.env.MAIL_FROM_NAME = 'Bridgeport Global';
process.env.DATABASE_FILE = process.env.DATABASE_FILE || './data/test-mail.db';

const { default: config } = await import('../config.mjs');
const mail = await import('../mail.mjs');
const { getDb } = await import('../db.mjs');

console.log('\n  Mail transport and templates\n');

check('config reports mail as configured', config.mail.enabled === true, config.mail.reason);

/* -------------------------------------------------------------------------- */
/*  1-3. The SMTP conversation                                                */
/* -------------------------------------------------------------------------- */

const delivered = await mail.deliver({
  to: 'customer@example.com',
  subject: 'Your order — a subject with an em dash',
  text: 'Line one\n. a line that is only a dot after stuffing\nLast line\n',
  html: '<p>Line one</p><p>Last line</p>',
});

check('deliver() resolves', delivered.ok === true);

const commands = received.commands.map((c) => c.split(' ')[0].toUpperCase());
check('client sent EHLO', commands.includes('EHLO'), commands.join(','));
check('client authenticated with PLAIN', received.auth?.mechanism === 'PLAIN');
check(
  'auth token decodes to user\\0pass',
  received.auth?.decoded === '\u0000support@bridgeportglobalinc.com\u0000app-password-for-tests',
  JSON.stringify(received.auth?.decoded),
);
check('envelope sender is the configured address', received.commands.some((c) => c.startsWith('MAIL FROM:<support@bridgeportglobalinc.com>')));
check('envelope recipient is the customer', received.commands.some((c) => c.startsWith('RCPT TO:<customer@example.com>')));
check('message arrived', received.messages.length === 1, String(received.messages.length));

const wire = received.messages[0] || '';
check('message has a From header', /^From: Bridgeport Global <support@bridgeportglobalinc\.com>$/m.test(wire));
check('message has a Message-ID', /^Message-ID: <[^>]+@bridgeportglobalinc\.com>$/m.test(wire));
check('message has a Date header', /^Date: .+GMT$/m.test(wire));
check('message is multipart/alternative', /Content-Type: multipart\/alternative; boundary=/.test(wire));
check('non-ASCII subject is RFC 2047 encoded', /^Subject: =\?utf-8\?B\?/m.test(wire));

/** Pull a base64 part out of the multipart body and decode it. */
function partBody(source, mimeType) {
  const boundary = source.match(/boundary="([^"]+)"/)?.[1];
  if (!boundary) return '';
  const parts = source.split(`--${boundary}`);
  const part = parts.find((p) => p.includes(`Content-Type: ${mimeType}`));
  if (!part) return '';
  const body = part.split(/\r?\n\r?\n/).slice(1).join('\r\n\r\n');
  return Buffer.from(body.replace(/\r?\n/g, ''), 'base64').toString('utf8');
}

check('dot-stuffed line survived to the wire intact', partBody(wire, 'text/plain').includes('. a line that is only a dot'), JSON.stringify(partBody(wire, 'text/plain')));
check('plain text part decoded', partBody(wire, 'text/plain').includes('Line one'));
check('html part decoded', partBody(wire, 'text/html').includes('<p>Line one</p>'));

/* -------------------------------------------------------------------------- */
/*  4. Failure is recorded, never thrown                                      */
/* -------------------------------------------------------------------------- */

const skipped = await mail.send({
  kind: 'test',
  to: '',
  subject: 'no recipient',
  text: 'x',
  orderNumber: 'CY-TEST-0001',
});
check('send() with no recipient does not throw', skipped.ok === false && skipped.skipped === true);

const db = getDb();
const skippedRow = db.prepare("SELECT * FROM mail_log WHERE kind = 'test' ORDER BY id DESC LIMIT 1").get();
check('skipped attempt is recorded', Boolean(skippedRow) && skippedRow.status === 'skipped', JSON.stringify(skippedRow?.status));

/* -------------------------------------------------------------------------- */
/*  5. The receipt template                                                   */
/* -------------------------------------------------------------------------- */

const order = {
  order_number: 'CY-20260214-0007',
  currency: 'CAD',
  customer_name: 'Mei Lin',
  customer_email: 'mei@example.com',
  subtotal_cents: 41000,
  shipping_cents: 0,
  tax_cents: 5330,
  total_cents: 46330,
  shipping_method: 'Express',
  shipping_name: 'Mei Lin',
  shipping_line1: '88 King Street West',
  shipping_line2: '',
  shipping_city: 'Toronto',
  shipping_province: 'ON',
  shipping_postal_code: 'M5H 1J9',
  shipping_country: 'Canada',
  items: [
    { product_name: 'Amethyst Coin Bracelet', variant_label: 'coin beads, 8 mm', sku: 'CY-JW-001', quantity: 1, line_total_cents: 29000 },
    { product_name: 'Lion Peak Longjing', variant_label: '50 g tin', sku: 'CY-TE-014', quantity: 1, line_total_cents: 12000 },
  ],
};

const receipt = mail.renderOrderReceipt(order);
check('receipt subject names the order', receipt.subject.includes('CY-20260214-0007'), receipt.subject);
check('receipt body names the order number', receipt.text.includes('CY-20260214-0007'));
check('receipt body has the total', receipt.text.includes('CAD 463.30'), receipt.text.split('\n').find((l) => l.startsWith('Total')) || '');
check('receipt lists every item', receipt.text.includes('Amethyst Coin Bracelet') && receipt.text.includes('Lion Peak Longjing'));
check('receipt carries the legal name and address', receipt.text.includes(config.company.legalName) && receipt.text.includes(config.company.addressLines[0]));
check('receipt html is a complete document', receipt.html.startsWith('<!doctype html>') && receipt.html.includes('</html>'));
check('receipt states the dispatch window', /within 48 hours/.test(receipt.text));

const dispatch = mail.renderDispatchNotice(order, { trackingNumber: 'LX123456789CN', carrier: 'China Post' });
check('dispatch notice carries tracking', dispatch.text.includes('LX123456789CN'));

const refund = mail.renderRefundNotice(order, { amountCents: 29000, full: false });
check('partial refund notice has the amount', refund.text.includes('CAD 290.00'));

/* -------------------------------------------------------------------------- */

server.close();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
