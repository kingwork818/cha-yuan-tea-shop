/**
 * Capture the back office for review.
 *
 *   node server/scripts/shot-admin.mjs [baseUrl]
 *
 * Signs in, then screenshots each admin page. Kept separate from shot-el.mjs
 * because every one of these pages is behind a login: a reviewer — or an owner
 * checking what a reviewer will see — needs the set, not one element.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/chrome.mjs';
import config from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const OUT = path.join(ROOT, '_shots', 'admin');

const email = process.env.ADMIN_EMAIL || config.admin.email;
const password = process.env.ADMIN_PASSWORD || config.admin.password;

const pages = [
  ['dashboard', '/admin'],
  ['orders', '/admin/orders'],
  ['catalogue', '/admin/products'],
  ['callbacks', '/admin/webhooks'],
  ['emails', '/admin/emails'],
  ['activity', '/admin/activity'],
  ['settings', '/admin/settings'],
];

fs.mkdirSync(OUT, { recursive: true });
const browser = await launch({ width: 1440, height: 1000, dpr: 1 });
try {
  await browser.goto(`${BASE}/admin/login`);
  await browser.evaluate(`(() => {
    document.querySelector('#email').value = ${JSON.stringify(email)};
    document.querySelector('#password').value = ${JSON.stringify(password)};
    document.querySelector('form').submit();
  })()`);
  await new Promise((r) => setTimeout(r, 1400));

  for (const [name, url] of pages) {
    const shot = await browser.screenshotFullPage(`${BASE}${url}`);
    fs.writeFileSync(path.join(OUT, `${name}.png`), shot);
    console.log(`  ${name.padEnd(10)} ${url}`);
  }

  /* The printable receipt, on paper-white, from a real order in the list. */
  const orderNumber = await browser.evaluateOn(
    `${BASE}/admin/orders`,
    `(document.body.textContent.match(/CY-\\d{8}-\\d{4}/) || [''])[0]`,
  );
  if (orderNumber) {
    const shot = await browser.screenshotFullPage(`${BASE}/admin/orders/${orderNumber}/receipt`);
    fs.writeFileSync(path.join(OUT, 'receipt.png'), shot);
    console.log(`  receipt    /admin/orders/${orderNumber}/receipt`);
  }
} finally {
  await browser.close();
}
console.log(`\n  ${OUT}`);
