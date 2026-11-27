# Website platform and hosting declaration

**Merchant:** Bridgeport Global Inc.
**Website:** https://www.bridgeportglobalinc.com
**Prepared:** for submission to the acquiring bank / payment provider
**Contact for technical questions:** support@bridgeportglobalinc.com · +1 (942) 380-9665

---

## 1. Platform declaration

The website is **not** built on a third-party e-commerce platform, CMS or website
builder. It is a **bespoke (custom-developed) online store**, commissioned for and
owned by the merchant.

| Item | Detail |
| --- | --- |
| Platform / CMS | **None.** Custom-built application, no Shopify, WooCommerce, WordPress, Wix, Squarespace, Magento or similar |
| Application | Node.js 24 application, server-rendered templates (Express 4 + EJS) |
| Database | SQLite, held on an encrypted persistent disk attached to the hosting service |
| Front end | Hand-written HTML, CSS and JavaScript. No client-side framework |
| Hosting provider | **Render** (Render Services, Inc.) — managed application platform, US-West region |
| DNS and CDN | **Cloudflare, Inc.** |
| TLS certificate | Issued and renewed automatically; HTTPS enforced with HSTS |
| Source control | Private GitHub repository; every change is versioned and deploys on push |
| Back office | Custom administrative console at `/admin`, behind an authenticated session |

If a "platform provider" field is mandatory in your form, the correct entries are:

- **Platform type:** Custom / bespoke development (no platform vendor)
- **Hosting provider:** Render
- **DNS / CDN:** Cloudflare

## 2. Maintenance and responsibility

The merchant owns the source code, the hosting account and the database. There is no
platform vendor, no app marketplace and no third party with standing access to
customer data. Security patches and dependency updates are applied by the merchant
through the same versioned deployment process.

## 3. Payment integration

Card payments are integrated directly with the acquirer's own card gateway
(local card, 3-D Secure 2), not through a third-party checkout overlay or hosted
storefront.

Flow for every transaction:

1. The cardholder enters card details on the merchant's own checkout page over HTTPS.
2. The application validates the input (card number check digit, expiry, CVV length)
   and relays it to the acquirer's gateway over TLS for authorisation.
3. Where 3-D Secure 2 requires it, the cardholder completes the issuer's
   authentication challenge.
4. The authorisation result is received by callback and reconciled against the order.

**Card data is never stored.** The database and the application logs contain no card
number and no CVV at any point. The order record retains only: card brand, last four
digits, amount, currency, and the acquirer's payment and order identifiers — the
minimum needed to reconcile a transaction, answer a customer query and issue a refund.

Because the card is captured on a page served by the merchant's own application and
relayed by it, this is a **direct-post integration**, and the merchant's PCI DSS
self-assessment category is **SAQ A-EP**. The website copy has been aligned with this
and makes no SAQ A claim.

## 4. Security controls in place

- HTTPS end to end; HTTP requests redirect to HTTPS; HSTS enabled
- Content Security Policy, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` and `Permissions-Policy` set on every response
- No card data in the database, in logs or in error reports; request bodies are
  redacted before logging
- Back-office login rate-limited (8 attempts per 5 minutes per IP); sessions signed,
  server-side revocable, and expire after 12 hours
- Every back-office action (refund, status change, stock change, export, sign-in,
  failed sign-in) recorded in an append-only audit trail with the account and source IP
- Automated test suite run on every deployment, covering access control, the payment
  callback pipeline, mail delivery and the accuracy of published policy copy
- Health-checked deployment with automatic restart; database on a persistent disk
  separate from the application container

## 5. Business and policy content on the site

| Page | Content |
| --- | --- |
| `/contact` | Registered entity, registered address, telephone, email, registration numbers |
| `/terms` | Terms of service, contract formation, pricing, liability |
| `/privacy` | Privacy policy, data controller, lawful basis, retention, data subject rights |
| `/shipping` | Dispatch from the warehouse in China within 48 hours; delivery 10–25 business days (standard) or 7–15 (express) |
| `/refund` | 30-day returns, who pays return postage, the returns address, refund timing to the original card |
| `/checkout` | Prices and settlement currency in **CAD**, Ontario HST 13%, card marks, 3-D Secure 2 |

## 6. Access for review

A **read-only** back-office account can be issued for your review. It can open every
page — orders, order detail with payment references and refund history, gateway
callback log, email log, audit trail, settings — and it cannot change, refund or
delete anything. Access can be revoked immediately after the review.

Request it at support@bridgeportglobalinc.com and it will be issued the same working
day.

## 7. Outstanding items, stated openly

- Company registration number and HST registration number are not yet entered. The
  pages above display "to be supplied" rather than a fabricated number.
- The card gateway is in its test mode until credentials are issued; the back office
  displays "Test mode" while that remains true.

Both will be updated as soon as the information is available, and this document will
be reissued with them included.
