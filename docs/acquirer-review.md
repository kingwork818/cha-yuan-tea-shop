# Giving an acquirer read-only access to the back office

A card acquirer reviewing this account will want to log in to the back office and
look around before enabling live payments. This file is how to do that without
handing over the owner's own password.

## Why not just share the admin login

The owner's account can refund orders, change order statuses and edit stock. Handing
it to a reviewer means handing over all of that, with no way afterwards to say who
did what — and no way to take the access away again without changing the owner's own
password, which breaks nothing for the reviewer but does mean changing it everywhere
it is stored.

The read-only account can read every page and change nothing.

## One-time setup (2 minutes, in Render)

Render → the service → **Environment** → add two variables:

| Key | Value |
| --- | --- |
| `REVIEWER_EMAIL` | the address you want the reviewer to use, e.g. `review@acquirer.com` |
| `REVIEWER_PASSWORD` | a long random password you generate for them |

Save. Render redeploys in about a minute. Nothing else changes, and the storefront
is untouched while it does.

Check it worked: sign in at `https://www.bridgeportglobalinc.com/admin` with those
values. You should see a red **Read-only access** badge in the sidebar and a banner
across the top of every page. The refund and order-status controls will not be there.

## What the reviewer will see

| Page | Contents |
| --- | --- |
| **Dashboard** | revenue, order counts, operating checks (payment mode, unprocessed callbacks, receipts sent), recent staff activity, recent orders, low stock |
| **Orders** | every order, searchable, filterable by status and date range, with an **Export as CSV** button |
| **Order detail** | items, customer and delivery address, payment attempts with card type and last four, gateway references, refund history, emails sent for that order, and a **Receipt** link |
| **Receipt** | a printable, paper-sized receipt for one order with the trading entity, tax line and payment reference |
| **Catalogue** | all products and stock levels (read-only for this account) |
| **Payment callbacks** | every notification the gateway posted, with the decryption result — including any that could not be decrypted |
| **Email** | every message the shop tried to send, with the provider's error where one failed |
| **Activity log** | every staff action: sign-ins, failed sign-ins, status changes, refunds, stock edits, CSV exports, with the account and IP |
| **Settings** | the trading entity, storefront settings, payment integration, email status |

Everything that changes something is refused server-side for this account, not
merely hidden: a reviewer who guesses a form URL gets a 403 page that says why, and
the attempt appears in the activity log.

## Afterwards: revoke it

Either of these, both on the owner's account:

1. **Environment** → remove `REVIEWER_EMAIL` and `REVIEWER_PASSWORD` → save. The
   account stops existing at the next deploy.
2. **Activity log → Revoke all sessions** (sidebar bottom of `/admin/activity` is
   not needed — the button is on the dashboard's activity card). This ends every
   live session immediately, including any signed-in reviewer, without waiting for
   the 12-hour cookie to expire.

Do both if the review was sensitive: removing the account stops future sign-ins,
revoking sessions stops the current one.

## What a reviewer typically checks, and where it is

| They ask | Where it is |
| --- | --- |
| Who is the merchant | `/contact` and the footer; also Settings → Trading entity |
| What is sold, at what price, in what currency | `/shop`, product pages, checkout (`Currency: CAD`) |
| Refund and returns policy, including the returns address | `/refund` — states 30 days, who pays postage, and the Markham address |
| Delivery promise | `/shipping` — dispatched from China within 48 hours, 10–25 / 7–15 business days |
| Where the money goes and how orders are tracked | Orders list, order detail, payment callbacks |
| That refunds are possible and attributable | Order detail → Refund, and the Activity log |
| That customers get a receipt | Email log; and a real receipt per order |
| Card data handling | Settings → Card payments: never stored, last four only |

## Two things that will still say "To be supplied"

`COMPANY_REGISTRATION_NUMBER` and `COMPANY_TAX_NUMBER` are empty, so `/contact`,
`/terms`, `/privacy` and Settings show "To be supplied" next to them. That is
deliberate — an invented registration number is worse than a visible gap — but an
acquirer will ask for them. Set both in Render before the review if you have them:

```
COMPANY_REGISTRATION_NUMBER=Ontario corporation number
COMPANY_TAX_NUMBER=HST registration number
```

The "To be supplied" notices disappear by themselves once those are set.
