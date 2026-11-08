# Back-in-stock alerts

Customers ask to be emailed when a sold-out product comes back. This service collects those requests through an embeddable form, listens for stock webhooks, checks the stock API, and sends each customer **one** email when the product is really back.

Node 22, no npm dependencies: the built-in `http`, `fetch` and SQLite (`node:sqlite`).

## Run it

```bash
docker build -t back-in-stock .
docker run -p 3000:3000 -v back-in-stock-data:/data \
  -e STOCK_API_URL=... -e STOCK_API_KEY=... \
  -e RESEND_API_KEY=... -e RESEND_BASE_URL=... \
  -e WEBHOOK_SECRET=... \
  back-in-stock
```

The app listens on `$PORT` (default 3000). The admin password is printed in the logs on start-up (see below).

Without Docker: `npm start` with the same variables (Node 22.13 or newer).

### Environment variables

| Variable | Required | What it does |
|---|---|---|
| `STOCK_API_URL` | yes | `GET {url}/{sku}` returns `{ quantity, in_stock, ... }`, `GET {url}` returns the catalogue |
| `STOCK_API_KEY` | yes | Bearer token for the stock API |
| `RESEND_API_KEY` | yes | Bearer token for the email API |
| `RESEND_BASE_URL` | yes | Emails are sent to `{RESEND_BASE_URL}/emails` in Resend's format |
| `WEBHOOK_SECRET` | yes | Expected value of the `X-Webhook-Secret` header |
| `PORT` | no | Default `3000` |
| `ADMIN_PASSWORD` | no | If unset, a password is generated once, saved in the database and printed in the logs |
| `DATA_DIR` | no | Where the SQLite file lives. `/data` in the image (a volume) |
| `EMAIL_FROM` | no | Sender, default `Restock Alerts <alerts@restock-alerts.dev>` |
| `STORE_NAME` | no | Shown in the email |
| `PRODUCT_URL_TEMPLATE` | no | e.g. `https://shop.example.com/products/{sku}`, for the email button when the page the customer signed up on isn't known |
| `SWEEP_INTERVAL_SECONDS` | no | How often the safety-net sweep runs, default `60` |

## Endpoints

- **`GET /embed?sku=SKU`**: the sign-up form, built to sit in an iframe on a product page (`frame-ancestors *`). It shows the product, opens in an "it's in stock now" state if it already is, and works without a `sku` too. Optional `&accent=1f2a24` sets the button colour. It records the page it was embedded on, so the email's button links back to that product page.
  ```html
  <iframe src="https://your-app/embed?sku=MUG-STN-SAGE" style="border:0;width:100%;max-width:460px;height:320px"></iframe>
  ```
- **`POST /api/requests`** `{ email, sku }`: `201` for a new request, `200` with `already_requested: true` if that email already has an open request for that SKU, `200` with `status: "in_stock"` if there's nothing to wait for, `400` for a bad email or SKU. SKUs match whatever their case (`mug-1` and `MUG-1` are one product). The in-stock check here is capped at 1.5 seconds; if the stock API is slow or down, the request is stored anyway.
- **`POST /webhooks/stock`**: needs `X-Webhook-Secret`. Returns `202` for a new event, `200` with `duplicate: true` for a repeat, `401` for a wrong secret, `400` without an `event_id` or `sku`.
- **`GET /admin`**: HTTP Basic auth (any username, the admin password). Every request with its status, when it was requested and notified, attempts and the last error; filters, search, and the recent webhooks with what each one did.
- **`GET /healthz`**

## How customers get exactly one email (not zero, not two)

**Not two**

1. **One open request per customer per product.** A partial unique index on `(email, sku)` for open requests (SKU compared case-insensitively) is the one guard: the insert is `ON CONFLICT … DO NOTHING`, and asking twice returns the existing request.
2. **Duplicate webhooks are recognised.** Each `event_id` is stored. A repeat, including two copies arriving at the same moment, is acknowledged and ignored.
3. **Sending starts with an atomic claim.** A request moves from `waiting` to `sending` with `UPDATE … WHERE status = 'waiting'`. Only one caller can win that, so two webhooks, a webhook and the sweep, or two sweeps can never both email the same person. Runs for the same product (whatever the SKU's case) are also coalesced, so they don't even race.
4. **Every send carries an `Idempotency-Key`** of `back-in-stock-request-{id}`, and the email is rendered once, at the first claim, and stored on the request. Every retry (after a 500, a timeout or a crash after the email API accepted it) sends exactly the same bytes under the same key, so the email API returns the original instead of sending again. Real Resend rejects a reused key with a different payload (409); that can't happen here.

**Not zero**

5. **The webhook is a hint, not the truth.** It must have the right secret, and before anyone is first emailed, from a webhook or from the sweep, the stock API is checked. A webhook claiming a restock the stock API doesn't confirm sends nothing, and the requests keep waiting.
6. **Failed sends are retried** after at least 15s, 1m, 4m, 16m, then hourly (a retry goes out on the first sweep or webhook after its wait), and a new webhook during the wait does not bypass it. A request that a confirmed restock claimed is *owed* its email: its retries resend the stored email without re-checking stock, so a product selling out again before the retry lands can't leave that customer with zero emails. That is also why the email states no stock count: it is sent byte-for-byte as first rendered, so a count could be stale. Sends are only given up on when the email API says the email itself is invalid (400/422), and those show as "Failed" in the admin.
7. **A sweep catches what webhooks miss.** Every minute, each product with waiting requests is checked against the stock API. That covers lost webhooks, stock API outages during a webhook, and backed-off retries.
8. **It survives a restart.** Everything is in SQLite (WAL, `synchronous=FULL`, on the `/data` volume). On start-up, requests interrupted mid-send go back to `waiting` and are retried with the same idempotency key. Webhooks are stored before they're acknowledged, and on `SIGTERM` the app finishes in-flight sends before exiting.

Trade-off: a customer the app never got to (the product sold out again before any webhook or sweep reached them) keeps waiting for the next restock, rather than getting an email for stock that was already gone.

## Tests

```bash
npm test       # 40 tests, about 10s
npm run soak   # ~40s end-to-end run against the real process (SEED=<n> replays a run)
npm run mutate # ~7 min: breaks each guarantee in turn and checks the test named for it catches it
```

**Every guarantee above has a test that was seen failing when that guarantee was broken.** `test/mutations.json` lists 47 deliberate breakages of the production code, each with the test that must catch it: the claim (as a function and where it is used), the idempotency key and the byte-stable resend, the event dedupe, the unique index, the backoff's steps and its growth with attempts, the sweep's stock check and schedule, boot recovery, the shutdown drain, the email payload and links, the admin password and status labels, the embed form's target and in-stock state, the time budgets on pages a person waits for, and more. `npm run mutate` applies each one, runs the suite, confirms THAT test goes red, and restores the file byte-for-byte. All 47 are caught by the test named for them.

Two independent reviews named most of these breakages: 19 in the first round, none of which the first version of the tests caught, and 12 more in the second.

How the tests avoid passing for the wrong reason:
- **The fakes behave like the real services.** The fake stock API falls back to the upper-cased SKU like the challenge harness does. The fake email API validates the Resend payload (422 when a field is missing), honours `Idempotency-Key` and, like real Resend, answers a reused key with a different payload with 409. It records every POST, including the ones it deduplicated, so tests count send *attempts*, not just outcomes. It can also accept an email and never answer, so the crash test is a real crash after acceptance, not a hand-built database row.
- **No fixed sleeps before "nothing happened".** A test that asserts nobody was emailed first waits for that webhook's stored outcome, so it can only pass after the event was actually processed.
- **The clock is injected.** Backoffs are tested by moving the clock, not by waiting or editing the database.
- **The real entry points are driven:** `start()` (boot recovery, the boot sweep, the periodic sweep) and `stop()` (the drain), not the functions they call.

The soak test runs the server as a separate process against a fake store with the same API shapes as the challenge harness. It sends a few hundred sign-ups, restocks (30% delivered twice, concurrently), sell-outs, phantom restocks and bad-secret webhooks, fails 15% of email sends and 5% of stock checks, and kills the app with `SIGKILL` halfway through. It then checks that no request was emailed twice, every notified request has exactly one accepted email, and nobody is left waiting for a product that's in stock (other than sends still in their retry backoff).

## What I'd add for production

Schema migrations (`PRAGMA user_version`) before the first deploy with real data: today the schema is created fresh. Postgres instead of SQLite if it runs on more than one instance (the claim becomes `UPDATE … RETURNING` under row locks), a cancel link in the email, rate limiting on `POST /api/requests`, double opt-in where the law requires it, and HMAC-signed webhooks instead of a shared secret header.
