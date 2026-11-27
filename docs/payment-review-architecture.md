# How this website is built — for an acquirer's technical review

A one-page, factual description of the shop's platform. Written to be sent as-is to
a payment provider's onboarding or risk team when they ask what the site is built
with, who maintains it, and how card data is handled.

## The short answer

> The storefront is custom-built for this business: a server-rendered Node.js
> application (Express) with a SQLite database, hosted on Render, with DNS and TLS
> at Cloudflare. It is not built on Shopify, WooCommerce, WordPress or any other
> e-commerce platform, and no CMS or page builder is involved. Card data is never
> stored: it is relayed to the acquirer's gateway over TLS, and only the card brand
> and last four digits are retained.

## What the site is

| | |
| --- | --- |
| Type | Custom-built storefront. No CMS, no e-commerce platform, no page builder |
| Language / runtime | JavaScript, Node.js 24 |
| Framework | Express 4, server-rendered EJS templates |
| Database | SQLite (`node:sqlite`), file on a persistent disk |
| Front end | Hand-written HTML/CSS/vanilla JavaScript. No client-side framework, no bundler |
| Hosting | Render (managed platform, US-West region), automatic TLS, health-checked |
| DNS / CDN | Cloudflare |
| Source control | Private GitHub repository, one branch, deploy on push |
| Admin back office | Custom, at `/admin`, behind an authenticated session |

## Who maintains it

The business owns the code and the deployment. There is no third-party platform
vendor in the chain: no monthly platform fee, no app marketplace, and no vendor with
access to the customer database. Server-side dependencies are three well-known
libraries (`express`, `ejs`, `sharp`) plus their transitive dependencies, pinned by
lockfile.

## How card data is handled

This is the part reviewers test, so it is stated plainly:

1. The cardholder enters the card on **our checkout page**, over HTTPS.
2. The form posts to **our server**, which validates the input (Luhn check, expiry,
   CVV length), then relays it to the payment provider's API over TLS for
   authorisation.
3. The provider returns the result, and where 3-D Secure 2 requires a challenge the
   cardholder is shown the issuer's authentication step.
4. **Card data is never written to the database and never written to the logs.** The
   order stores only: card brand, last four digits, amount, currency, and the
   provider's payment and order identifiers.
5. Card data is not retained for future payments: there is no stored-card or
   one-click flow.

Because the card is captured on a page served by this application and relayed by it,
this is a **direct-post integration**, which falls under **SAQ A-EP** rather than
SAQ A. The site copy now states the facts and no longer claims SAQ A — that claim was
in the earlier draft of the marketing copy and has been removed.

Compensating controls in place:

- HTTPS end to end; HTTP redirects to HTTPS; TLS certificates issued automatically
- Content Security Policy, `X-Content-Type-Options`, `Referrer-Policy`, frame
  protection and HSTS headers on every response
- Admin login rate-limited (8 attempts / 5 minutes / IP), sessions signed and
  server-side revocable, sign-ins and failed sign-ins logged with the source IP
- Every back-office action recorded in an append-only audit trail
- Card fields validated server-side and discarded; only brand and last four persist

## What is on the back office

Order management (search, date filters, status changes, tracking numbers), full and
partial refunds issued to the original card, payment-status reconciliation against
the gateway, a log of every gateway callback with its decryption result, a log of
every email sent, a printable receipt per order, CSV export for reconciliation, and
an audit trail of staff actions.

Access can be granted read-only: a separate account can see every page and change
nothing. See `docs/acquirer-review.md` for how to set that up and revoke it.

## Public pages a reviewer will want

`/contact` (registered entity, address, telephone, email, registration numbers) ·
`/terms` · `/privacy` · `/shipping` (dispatch and delivery windows) ·
`/refund` (30 days, who pays return postage, returns address) · `/checkout` (currency
`CAD`, card marks, 3-D Secure 2) · `/about`

## Still outstanding, stated plainly

- Company registration number and HST number are not yet entered; those pages say
  "to be supplied" rather than showing a made-up number.
- Card payments are in test mode until the acquirer's credentials are issued. The
  back office shows "Test mode" while that is true.
