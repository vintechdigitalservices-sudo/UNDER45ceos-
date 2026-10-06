# UNDER45ceos — website + Selar/payment API

Static site for the Under 45 CEOs Business & Leadership Summit (Onitsha),
Ticket availability is derived in the browser from submitted checkouts;
the `/api/*` serverless functions are present but not required for it.

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

### Where the number comes from

There is nothing to configure and no admin step. Each tier has a fixed
opening allocation written into the code:

```
Essential             49
Growth                25
Executive             18
Founders Inner Circle 10
```

The remaining count is derived from the orders themselves:

```
remaining = opening - sum(quantity of submitted checkouts for that tier)
```

Because it is computed from `checkouts`, the number is always consistent
with the orders that actually exist, and every ticket type has its own
independent counter. `tickets_sold` is never stored separately — it is
just `opening - remaining`.

The `ticket_inventory` / `ticket_inventory_ledger` collections and the
`api/_lib/ticket-inventory.js` helpers still exist for the (currently
unused) Admin-SDK path, but the public site does not depend on them.

### What triggers the deduction

Submitting the checkout form. `checkout.html` writes the order to
`checkouts/{orderId}`; that new document is what the ticket page counts.
It is the only thing that moves the number.

Opening the ticket page, selecting a tier, opening the drawer, entering
details, refreshing, payment, uploading a receipt, and an admin approving
the payment all leave the count untouched. Because the order id is the
document id, a double click, retry or refresh cannot count the same order
twice.

### How the frontend gets the current quantity

`js/ticket-availability.js` reads the `checkouts` collection with a
real-time Firestore `onSnapshot` (`window.u45db`), sums the tickets per
tier, subtracts them from each opening allocation, and paints
`N Tickets Left` / `SOLD OUT` onto every card. Every open device updates
the moment a checkout is created.

The opening figures are painted immediately on load, so the page always
shows real numbers. There is no "unavailable" state: if the snapshot
cannot be reached, the opening figures simply stay on screen. No value is
stored in `localStorage` / `sessionStorage`.

The badge is informational only. A tier at zero shows `SOLD OUT`, but the
card and its button stay live — the count never blocks a registration.

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
| `/api/tickets/inventory` | GET | none | Remaining counts for the (currently unused) Admin-SDK path. Needs Admin credentials to respond. The public page does not call it. |
| `/api/tickets/confirm-order` | POST | admin ID token, or webhook secret | Legacy paid-order deduction. Requires the order to already be `approved`/`verified` in Firestore; rejects unpaid orders with `409 PAYMENT_NOT_CONFIRMED`. Idempotent on `orderId`, so an order already reserved at checkout is a no-op here. |
| `/api/tickets/review-order` | POST | admin ID token | The admin approve/reject transition. Flips the order to `approved`/`rejected` via the Admin SDK and commits the deduction in the same request, so stock cannot be left un-deducted behind a failed browser write. Rejection never touches stock. |
| `/api/tickets/admin/inventory` | GET/POST | admin ID token | Admin read/adjust, clamped to `[0, initial]`. |
| `/api/selar/webhook` | POST | `x-webhook-secret` | Selar payment callback → deduction. |
| `/api/selar/verify`, `/api/selar/verify-pending` | — | — | Routed but **handlers not present in this repo**; they 404. |

### Ticket availability badge

Each ticket card shows a pill pinned to its top edge (`48 Tickets Left`, or
`SOLD OUT` at zero). The count is derived in the browser from the
`checkouts` collection (`js/ticket-availability.js` + `window.u45db`), so
every open device updates the moment a checkout is submitted.

The count moves **when the checkout form is submitted** — the order
document `checkout.html` writes to `checkouts/{orderId}` is what the page
counts. This is independent of payment, receipt and approval, and because
the order id is the document id a double click, retry or refresh can only
ever count once.

The badge is an urgency cue only: a tier at zero shows `SOLD OUT` but its
card and button stay fully clickable, and no code path disables a purchase
based on the count.

> **Deployment note.** The `/api/tickets/*` serverless functions need
> `FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PROJECT_ID`.
> Those credentials are absent on this deployment, so the availability
> feature reads the `checkouts` collection directly from the browser and
> none of the `/api/tickets/*` functions are involved.

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

If a ticket count looks wrong:
1. It is derived from the orders in the `checkouts` collection — confirm
   the expected order document exists and its `tickets` field holds the
   right tier/quantity.
2. Reload the ticket page; it reads the collection in real time.

Payment orders are polled from Selar every 5 minutes. If an order has not
appeared after 30 minutes, contact support.