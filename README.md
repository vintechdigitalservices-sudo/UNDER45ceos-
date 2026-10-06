# UNDER45ceos — website + Selar/payment API

Static site for the Under 45 CEOs Business & Leadership Summit (Onitsha),
plus Vercel serverless functions that own ticket inventory.

> **Note on this file:** the merge-conflict markers that were previously in
> `README.md` have been resolved. If you were reading the old version, the
> env-var and support sections below are unchanged in substance.

---

## 🔑 Environment variables (Vercel → Settings → Environment Variables)

Never put these in frontend code.

| Key | Required | Purpose |
|-----|----------|---------|
| `FIREBASE_PRIVATE_KEY` | yes | Service account key. Serverless functions use it to write `ticket_inventory` (Admin SDK bypasses Firestore rules). Escaped `\n` is accepted. |
| `FIREBASE_CLIENT_EMAIL` | yes | Service account email. |
| `FIREBASE_PROJECT_ID` | recommended | Defaults to `under45ceos-submit`. |
| `ADMIN_EMAILS` | yes for admin features | Comma-separated allowlist. Only these Firebase Auth users can deduct stock or edit inventory. |
| `SELAR_API_KEY` | yes | Verifies Selar payments. |
| `SELAR_WEBHOOK_SECRET` | yes for the webhook | Shared secret sent by Selar in the `x-webhook-secret` header. |

---

## 🗄️ Ticket inventory

### Where it lives

Firestore collection **`ticket_inventory`**, one document per tier:

```
ticket_inventory/essential              { ticketType, initialQuantity: 49, remainingQuantity, price, updatedAt }
ticket_inventory/growth                 { ticketType, initialQuantity: 25, remainingQuantity, price, updatedAt }
ticket_inventory/executive              { ticketType, initialQuantity: 18, remainingQuantity, price, updatedAt }
ticket_inventory/founders_inner_circle  { ticketType, initialQuantity: 10, remainingQuantity, price, updatedAt }
```

Two supporting collections, both server-only:

- **`ticket_inventory_ledger/{orderId}`** — the idempotency ledger. The document ID *is* the payment reference.
- **`ticket_inventory_claims/{claimId}`** — in-flight checkout holds with a 20-minute TTL.

`tickets_sold` is never stored. It is always derived as
`initial_quantity - remaining_quantity` (see `readInventory()` in
`api/_lib/ticket-inventory.js`), so the two numbers cannot drift.

The docs are created lazily on first read, so there is no migration step.

### What triggers the deduction

A **confirmed** payment. In this project that is one of:

| Path | Trigger |
|------|---------|
| Bank transfer (the main flow) | An admin approves the order in `admin.html` → `commitInventoryForOrder()` → `POST /api/tickets/review-order`, which sets the status and moves the stock in one admin-gated request. |
| Selar card payment | Selar calls `POST /api/selar/webhook` with the shared secret. |

The browser cannot perform that status change itself. `firestore.rules`
only lets a client move an order between `pending` and
`awaiting_verification`, so a buyer can never approve their own payment —
and the rule checks the order's *current* status too, so a buyer cannot
revert an already-approved order back to `pending`. Only the Admin SDK,
through `review-order.js` behind `ADMIN_EMAILS`, can set `approved`.

The server does not take the admin's word for it either: `confirm-order.js`
re-reads the order from Firestore and requires `paymentStatus` (or
`status`) to be `approved` or `verified` before it will move stock.
Calling it with a valid admin token on an unpaid order returns
`409 PAYMENT_NOT_CONFIRMED` and leaves inventory untouched.

Nothing else moves stock. Opening the ticket page, choosing a tier,
starting checkout, entering details, refreshing, abandoning, or a failed
payment all leave `remaining_quantity` untouched.

### How duplicate payment processing is prevented

`commitDeduction()` runs a Firestore transaction that **creates
`ticket_inventory_ledger/{orderId}`** in the same atomic commit as the
decrement. Replaying the same reference finds the existing ledger
document and returns `{ alreadyProcessed: true }` without touching stock.
Concurrent duplicates hit Firestore's `ALREADY_EXISTS` and are treated the
same way.

The quantity is read from the order document in Firestore on the admin
path — a client cannot post `remaining_quantity` and have it believed.

### How concurrent purchases are handled

Firestore transactions with optimistic locking. The read of
`remainingQuantity`, the availability check, the decrement, and the ledger
write all happen inside one transaction, so two buyers racing for the last
ticket are serialised: the loser re-runs the transaction, re-reads the
now-zero stock, and receives `409 SOLD_OUT`. `remaining_quantity` can never
go negative because the check runs against the locked read.

### How the frontend gets the current quantity

`js/ticket-availability.js` calls `GET /api/tickets/inventory` and renders
`N Tickets Left` / `SOLD OUT` on each card. It refetches on load, on
`pageshow`, on tab focus, on `visibilitychange`, and every 30 s. No value
is stored in `localStorage`/`sessionStorage`, and no counter is decremented
in the browser.

---

## ⏱️ Event countdown

`js/event-countdown.js` + `js/event-countdown.css`. Self-contained: the
script injects its own stylesheet, builds the banner, and appends it to
`<body>`. Pages need one line and no markup:

```html
<script src="/js/event-countdown.js" defer></script>
```

### Correctness

- Fixed target: **`2026-10-10T09:00:00+01:00`** (Africa/Lagos, UTC+1, no DST).
- The four digits are **one additive decomposition** of the milliseconds
  remaining. `D + H + M + S` always equals the real wait, so the display
  can never claim more time than exists. This was verified at 3am, 8pm,
  10am and midnight across the days before the event.
- Recomputed from `Date.now()` on every 1 s tick and on every
  `pageshow` / `visibilitychange` / `focus`, so navigation cannot carry a
  stale value. Nothing is persisted.
- Calendar-day counting (in WAT) is used only for the **EVENT DAY**
  framing and the label text, never for the digits.
- Past the target: **EVENT DAY**, then **THE SUMMIT IS LIVE**. Never
  negative.
- `sessionStorage` is used for exactly one thing — remembering that you
  dismissed the banner for the rest of the session.

### Behaviour

- Fixed to the top of the viewport, hidden until the hero scrolls past.
  Hero detection is structural (`.hero`, `.hero-section`, `.hero-wrapper`,
  `[data-hero]`) with a 260px minimum height, so a short lead-in section
  is not mistaken for a hero and new pages work without edits.
- ✕ dismisses it with an animated slide-up; the dismissal lasts the
  session.
- `prefers-reduced-motion` disables the slide and the pulse.

### Brand colours and behaviour

Colours are read from the site's own design tokens — `--orange`,
`--orange-deep`, `--teal`, `--teal-light`, `--nav-bg`, `--text`,
`--text-muted`, `--border-strong` — so the banner is on-brand in both
the dark and the light theme with no hardcoded palette. Type uses the
site's `--font-display` (Bebas Neue) for the digits and `--font-body`
(DM Sans) for labels. Digits are white with the days figure in brand
orange, the CTA is a brand-orange button, and there is a 2px orange
underline plus a gradient edge stripe.

The banner **slides down over the site header and covers it** until the
✕ is pressed. It does not push the header down. `z-index` is 30000,
above every header on the site (`.nav` up to 10000, `.site-header`
1000), which is asserted by a test. Banner height is a fixed CSS
variable (`--u45-cd-h`: 76px, 64px under 640px) and is never
content-derived, so covering the header cannot change the page layout.

### Page-level options

Set on `<body>` or `<html>`:

| Attribute | Effect |
|-----------|--------|
| `data-cd-no-hero` | Show immediately, skip the scroll gate |
| `data-cd-hide-text` | Hide the descriptive sentence |
| `data-cd-cta` / `data-cd-href` | CTA label and target |
| `data-cd-title` | Label before the digits |

Mounted on: `index`, `summit`, `impact`, `sponsor`, `gallery`, `media`,
`faqs`, `contact`, `terms`, `privacy-policy`, `award-nominations`, `ticket`.

Deliberately **not** mounted on: `checkout`, `payment`, `ticket-view`,
`login`, `dashboard`, `admin`, `status`, `thanks`, `thank-you`, `whatsapp`,
`I`.

---

## 🔐 API routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/tickets/inventory` | GET | none | Public remaining counts. |
| `/api/tickets/claim` | GET/POST | none | Availability check / release a checkout hold. Never reduces stock. |
| `/api/tickets/reserve` | POST | none | **The checkout-time deduction trigger.** Called by `checkout.html` immediately after the `checkouts/{orderId}` document is written, so the count drops at submission — independent of payment, receipt and approval. Reads the quantities back from Firestore (never trusts the request), and is idempotent on `orderId`. |
| `/api/tickets/confirm-order` | POST | admin ID token, or webhook secret | Legacy paid-order deduction. Requires the order to already be `approved`/`verified` in Firestore; rejects unpaid orders with `409 PAYMENT_NOT_CONFIRMED`. Idempotent on `orderId`, so an order already reserved at checkout is a no-op here. |
| `/api/tickets/review-order` | POST | admin ID token | The admin approve/reject transition. Flips the order to `approved`/`rejected` via the Admin SDK and commits the deduction in the same request, so stock cannot be left un-deducted behind a failed browser write. Rejection never touches stock. |
| `/api/tickets/admin/inventory` | GET/POST | admin ID token | Admin read/adjust, clamped to `[0, initial]`. |
| `/api/selar/webhook` | POST | `x-webhook-secret` | Selar payment callback → deduction. |
| `/api/selar/verify`, `/api/selar/verify-pending` | — | — | Routed but **handlers not present in this repo**; they 404. |

### Ticket availability badge

Each ticket card shows a compact pill at the very top (`[ 48 Tickets Left ]`,
or `SOLD OUT` at zero), driven by `/api/tickets/inventory`. The number is
always the backend value — nothing is counted client-side. Stock is deducted
**when the checkout form is submitted** (`/api/tickets/reserve`), not on page
view, tier selection, payment or approval. The badge is an urgency cue only:
a tier at zero shows `SOLD OUT` but its card and button stay fully clickable,
and payment approval never deducts a second time because the shared
`ticket_inventory_ledger/{orderId}` makes every later call idempotent.

### Ticket page layout

The grid is 2×2 on desktop. Descriptions, the discount ribbons
(`-25% OFF`) and the `MOST POPULAR` / `FOUNDER'S EXCLUSIVE` badges were
removed, and the feature list renders two per row so each card fits
within the viewport instead of running past the fold. Cards stretch to a
common height with the CTA pinned to the bottom via `margin-top:auto`, so
the buttons line up across a row.

> `api/selar/verify.js` and `api/selar/verify-pending.js` are referenced by
> `vercel.json` but were never committed. If your Selar verification flow
> depends on them, they still need to be written.

---

## 🧪 Tests

```bash
npm test
```

- `tests/countdown.test.js` — the fixed target, additive decomposition
  across the whole day, calendar framing, midnight rollover, no-persistence
  and timer-cleanup assertions, plus checks that every colour comes from a
  brand token, that the banner overlays the header rather than pushing it,
  and that a dismissed session never mounts or leaks listeners.
- `tests/countdown-hero.test.js` — the hero reveal gate: hidden while the
  hero is on screen, slides in once past it, short sections are not
  mistaken for heroes, hero-less pages show immediately.
- `tests/inventory.test.js` — all 12 required scenarios plus the
  payment-confirmation gate, non-admin rejection, unsuccessful-webhook
  handling, malformed input, derived counts, admin clamping, tier
  normalisation, and the admin review endpoint (approve+deduct in one
  call, idempotency, non-admin refusal, reject never deducting, and
  delivery metadata being non-quantity). Runs against an in-memory
  Firestore double (`tests/helpers/memory-firestore.js`) that implements
  transactional locking and conflict retry.

56 tests, all passing: 21 countdown, 6 hero gate, 29 inventory.

---

## 📞 Support

**Technical Lead / System Admin**
- Immanuel — 09021773508 — vintechdigitalservices@gmail.com

If ticket counts look stuck or a payment is not reflected:
1. Check Vercel logs.
2. Confirm `FIREBASE_PRIVATE_KEY` and `ADMIN_EMAILS` are set.
3. In the admin dashboard open **Ticket Inventory** and hit Refresh.

Payment orders are polled from Selar every 5 minutes. If an order has not
appeared after 30 minutes, contact support.