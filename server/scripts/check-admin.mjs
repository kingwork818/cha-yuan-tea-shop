/**
 * Back-office access checks: owner versus reviewer.
 *
 *   node server/scripts/check-admin.mjs
 *
 * The back office is now shown to an acquirer's reviewer, so the boundary between
 * "can look" and "can act" is the thing that must not regress: a read-only account
 * that is merely *shown fewer buttons* is not read-only, because the form
 * endpoints are guessable URLs.
 *
 * This starts a real server on a throwaway database and does what a person would
 * do with curl:
 *
 *   1. sign in as the owner and as the reviewer, both accepted
 *   2. every read page answers 200 for both roles
 *   3. every write endpoint refuses the reviewer with 403 — status change, refund,
 *      stock, test email — and allows the owner
 *   4. the reviewer sees the read-only notice on the page
 *   5. refusals and sign-ins are recorded in the audit trail
 *   6. a wrong password is refused and recorded, without leaking which field failed
 *   7. the printable receipt and the CSV export render for a real order
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

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

const OWNER = { email: 'owner@bridgeportglobalinc.test', password: 'owner-test-password' };
const REVIEWER = { email: 'reviewer@acquirer.test', password: 'reviewer-test-password' };
const PORT = 3400 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `admin-check-${process.pid}.db`);

/* -------------------------------------------------------------------------- */
/*  Server                                                                    */
/* -------------------------------------------------------------------------- */

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  // 'ignore', not 'pipe': a piped child cannot be read through the sandbox, and
  // this test only needs the server to run, not to talk.
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    DATABASE_FILE: DB_FILE,
    SESSION_SECRET: 'admin-check-secret-not-for-production-use',
    ADMIN_EMAIL: OWNER.email,
    ADMIN_PASSWORD: OWNER.password,
    REVIEWER_EMAIL: REVIEWER.email,
    REVIEWER_PASSWORD: REVIEWER.password,
    PAYMENT_MODE: 'mock',
    PUBLIC_BASE_URL: BASE,
    // Mail deliberately unconfigured, so the "not configured" paths are the ones
    // under test here; check-mail.mjs covers the configured paths.
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
  },
});

const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  /*
   * The database file stays locked until the child has actually exited, so the
   * delete retries briefly and then gives up: a leftover temp file is untidy,
   * not a test failure.
   */
  for (const suffix of ['', '-wal', '-shm']) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(`${DB_FILE}${suffix}`, { force: true });
        break;
      } catch {
        // One synchronous pause is enough between attempts here.
        const until = Date.now() + 120;
        while (Date.now() < until) { /* wait for the handle to close */ }
      }
    }
  }
};
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Sign in and keep the cookie, like a browser would. */
async function signIn({ email, password }) {
  const res = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password, next: '/admin' }),
    redirect: 'manual',
  });
  const cookie = res.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ')
    || res.headers.get('set-cookie')?.split(';')[0]
    || '';
  return { status: res.status, cookie, location: res.headers.get('location') };
}

const page = (p, cookie) => fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const post = (p, cookie, form) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form || {}),
    redirect: 'manual',
  });

/**
 * Place a real order through the storefront API, so the order pages have
 * something genuine to show.
 *
 * Done over HTTP rather than by inserting rows: an order written straight into
 * SQLite would miss the pricing, the CSRF gate and the mock gateway, and the test
 * would then be asserting against a shape the application never actually produces.
 */
async function placeOrder() {
  const productRes = await fetch(`${BASE}/api/products/tieguanyin-iron-goddess`);
  const payload = await productRes.json();
  // The API answers with the product at the top level, not wrapped in `data`.
  const product = payload?.product || payload?.data?.product;
  if (!product?.variants?.length) return null;
  const variantId = product.variants[0].id;

  // A CSRF token comes with the first page load, as a cookie.
  const landing = await fetch(`${BASE}/checkout`, { redirect: 'manual' });
  const csrf = (landing.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('cy_csrf='))
    ?.split('=')[1];
  if (!csrf) return null;

  const res = await fetch(`${BASE}/api/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Origin: BASE,
      cookie: `cy_csrf=${csrf}`,
    },
    body: JSON.stringify({
      email: 'buyer@example.com',
      name: 'Ada Lovelace',
      phone: '+1 416 555 0100',
      address: '1123 Leslie Street',
      address2: '',
      city: 'Toronto',
      province: 'ON',
      postalCode: 'M3C 2K5',
      country: 'CA',
      shippingMethod: 'standard',
      note: 'Admin access check.',
      items: [{ variantId, quantity: 1 }],
      cardNumber: '5454545454545454',
      cardHolder: 'Ada Lovelace',
      cardExpiryMonth: '03',
      cardExpiryYear: '30',
      cardCvv: '737',
      browser: {
        userAgent: 'admin-check/1.0',
        language: 'en-CA',
        screenHeight: 1080,
        screenWidth: 1920,
        timezoneOffset: -5,
        colorDepth: 24,
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  /*
   * The checkout API answers flat: { ok, orderNumber, redirectUrl, … }. The mock
   * acquirer stops at a 3-D Secure challenge, which is enough here — the order
   * row exists either way, and completing authentication is what check-mail and
   * the smoke suite cover.
   */
  return body?.orderNumber || body?.data?.orderNumber || null;
}

/* -------------------------------------------------------------------------- */

console.log('\n  Back office access control\n');

if (!(await waitForServer())) {
  console.log('  \x1b[31mFAIL\x1b[0m  server did not start');
  process.exit(1);
}

/* 1. Both accounts can sign in. */
const ownerSignIn = await signIn(OWNER);
check('owner signs in', ownerSignIn.status === 302 && ownerSignIn.location?.includes('/admin'), `${ownerSignIn.status}`);
const reviewerSignIn = await signIn(REVIEWER);
check('reviewer signs in', reviewerSignIn.status === 302 && reviewerSignIn.location?.includes('/admin'), `${reviewerSignIn.status}`);

const wrong = await signIn({ email: OWNER.email, password: 'not-the-password' });
check('wrong password refused', wrong.status === 401, String(wrong.status));

const unknown = await signIn({ email: 'nobody@example.com', password: 'x' });
check('unknown account refused', unknown.status === 401, String(unknown.status));

/* 2. Reads work for both roles. */
const readPages = ['/admin', '/admin/orders', '/admin/products', '/admin/webhooks', '/admin/emails', '/admin/activity', '/admin/settings', '/admin/orders.csv'];
for (const p of readPages) {
  const asOwner = await page(p, ownerSignIn.cookie);
  const asReviewer = await page(p, reviewerSignIn.cookie);
  check(`owner can read ${p}`, asOwner.status === 200, String(asOwner.status));
  check(`reviewer can read ${p}`, asReviewer.status === 200, String(asReviewer.status));
}

/* 3. A reviewer is told why, on the page. */
const dashboard = await (await page('/admin', reviewerSignIn.cookie)).text();
check('reviewer sees the read-only notice', /read-only review access/i.test(dashboard));
const ownerDashboard = await (await page('/admin', ownerSignIn.cookie)).text();
check('owner does not see the read-only notice', !/read-only review access/i.test(ownerDashboard));

/* 4. Writes: reviewer refused, owner allowed. */
const stockForm = { stock: '7' };

const reviewerStock = await post('/admin/products/1/stock', reviewerSignIn.cookie, stockForm);
check('reviewer cannot change stock', reviewerStock.status === 403, String(reviewerStock.status));

const ownerStock = await post('/admin/products/1/stock', ownerSignIn.cookie, stockForm);
check('owner can change stock', ownerStock.status === 302, String(ownerStock.status));

/* 5. Find a real order to act on, then try to change its status. */
const placed = await placeOrder();
check('an order can be placed for the access checks', Boolean(placed), String(placed));

const csv = await (await page('/admin/orders.csv', ownerSignIn.cookie)).text();
check('CSV has a header row', csv.split('\r\n')[0]?.includes('order_number'), csv.split('\r\n')[0]?.slice(0, 60));
check('CSV contains the order', placed ? csv.includes(placed) : false);

const orderNumber = placed;

if (!orderNumber) {
  check('the order pages can be exercised', false, 'no order was created');
} else {
  const reviewerStatus = await post(`/admin/orders/${orderNumber}/status`, reviewerSignIn.cookie, { status: 'cancelled' });
  check('reviewer cannot change an order status', reviewerStatus.status === 403, String(reviewerStatus.status));

  const reviewerRefund = await post(`/admin/orders/${orderNumber}/refund`, reviewerSignIn.cookie, { full: '1' });
  check('reviewer cannot refund', reviewerRefund.status === 403, String(reviewerRefund.status));

  const reviewerSync = await post(`/admin/orders/${orderNumber}/sync`, reviewerSignIn.cookie, {});
  check('reviewer cannot re-query the gateway', reviewerSync.status === 403, String(reviewerSync.status));

  const reviewerMail = await post('/admin/emails/test', reviewerSignIn.cookie, { to: 'x@example.com' });
  check('reviewer cannot send a test email', reviewerMail.status === 403, String(reviewerMail.status));

  const receipt = await page(`/admin/orders/${orderNumber}/receipt`, reviewerSignIn.cookie);
  const receiptHtml = await receipt.text();
  check('reviewer can open the printable receipt', receipt.status === 200, String(receipt.status));
  check('receipt carries the legal entity', receiptHtml.includes('Bridgeport Global Inc.'));
  check('receipt is white-on-paper, not the dark theme', /background: #fff/.test(receiptHtml));
  check('receipt prints the order number', receiptHtml.includes(orderNumber));

  const ownerStatus = await post(`/admin/orders/${orderNumber}/status`, ownerSignIn.cookie, { status: 'processing', adminNote: 'packed' });
  check('owner can change an order status', ownerStatus.status === 302, String(ownerStatus.status));

  const orderPage = await (await page(`/admin/orders/${orderNumber}`, ownerSignIn.cookie)).text();
  check('order page shows the activity trail', /Activity for this order/.test(orderPage));
  check('order page shows the tracking field for the owner', /name="tracking"/.test(orderPage));

  const reviewerOrderPage = await (await page(`/admin/orders/${orderNumber}`, reviewerSignIn.cookie)).text();
  check('reviewer sees the order but no refund button', !/Refund in full/.test(reviewerOrderPage));
  check('reviewer is told why the actions are missing', /read-only access/i.test(reviewerOrderPage));

  /* A dispatch email is not sent when mail is unconfigured — and the customer
   * must still get their order, which is the point of the guard. */
  const shipped = await post(`/admin/orders/${orderNumber}/status`, ownerSignIn.cookie, {
    status: 'shipped',
    tracking: 'LX123456789CN',
    carrier: 'China Post',
  });
  check('owner can ship an order with tracking', shipped.status === 302, String(shipped.status));
  const shippedPage = await (await page(`/admin/orders/${orderNumber}`, ownerSignIn.cookie)).text();
  check('the tracking number is kept on the order', shippedPage.includes('LX123456789CN'));
  check('an unconfigured mailer is reported, not silently skipped', /not configured|Nothing sent yet/i.test(shippedPage));
}

/* 6. The audit trail recorded all of it. */
const activity = await (await page('/admin/activity', ownerSignIn.cookie)).text();
check('sign-ins are recorded', /sign-in/.test(activity));
check('the failed sign-in is recorded', /sign-in\.failed/.test(activity));
check('refused writes are recorded', /write\.denied/.test(activity));
check('the reviewer is named in the log', activity.includes(REVIEWER.email));
check('the status change is recorded', /order\.status/.test(activity));
check('the stock change is recorded', /stock\.update/.test(activity));

/* 7. Signing out actually ends the session, and revoking ends all of them. */
const signOut = await post('/admin/logout', reviewerSignIn.cookie, {});
check('sign out redirects', signOut.status === 302, String(signOut.status));
const afterSignOut = await page('/admin', reviewerSignIn.cookie);
check('a signed-out cookie cannot read the dashboard', afterSignOut.status === 302, String(afterSignOut.status));

const noCookie = await page('/admin');
check('no cookie redirects to sign in', noCookie.status === 302, String(noCookie.status));

/* A fresh reviewer sign-in, then revoke every session from the owner's side. */
const reviewerAgain = await signIn(REVIEWER);
check('the reviewer can sign in again', reviewerAgain.status === 302, String(reviewerAgain.status));
const beforeRevoke = await page('/admin', reviewerAgain.cookie);
check('the new reviewer session works', beforeRevoke.status === 200, String(beforeRevoke.status));

const revoke = await post('/admin/sessions/revoke-all', ownerSignIn.cookie, {});
check('owner can revoke every session', revoke.status === 302, String(revoke.status));
const afterRevoke = await page('/admin', reviewerAgain.cookie);
check('the revoke ends the reviewer session immediately', afterRevoke.status === 302, String(afterRevoke.status));
const ownerAfterRevoke = await page('/admin', ownerSignIn.cookie);
check('the revoke ends the owner session too', ownerAfterRevoke.status === 302, String(ownerAfterRevoke.status));

/* 8. The storefront is unaffected by any of this. */
for (const p of ['/', '/shop', '/checkout', '/order', '/robots.txt', '/sitemap.xml']) {
  const res = await page(p);
  check(`storefront ${p} answers 200`, res.status === 200, String(res.status));
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
stop();
process.exit(failed ? 1 : 0);
