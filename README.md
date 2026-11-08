# Back-in-stock alerts

Customers ask to be emailed when a sold-out product comes back. This service collects those requests through an embeddable form, listens for stock webhooks, checks the stock API, and sends each customer **one** email when the product is really back.

Node 22, no npm dependencies: the built-in `http`, `fetch` and SQLite (`node:sqlite`).

## Run it

```bash
docker build -t back-in-stock .
docker run -p 3000:3000 \
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
- **`POST /api/requests`** `{ email, sku }`: `201` for a new request, `200` with `already_requested: true` if that email already has an open request for that SKU, `200` with `status: "in_stock"` if there's nothing to wait for, `400` for a bad email or SKU.
- **`POST /webhooks/stock`**: needs `X-Webhook-Secret`. Returns `202` for a new event, `200` with `duplicate: true` for a repeat, `401` for a wrong secret.
- **`GET /admin`**: HTTP Basic auth (any username, the admin password). Every request with its status, when it was requested and notified, attempts and the last error; filters, search, and the recent webhooks with what each one did.
- **`GET /healthz`**

## How customers get exactly one email (not zero, not two)

**Not two**

1. **One open request per customer per product.** A partial unique index on `(email, sku)` for open requests. Asking twice returns the existing request.
2. **Duplicate webhooks are recognised.** Each `event_id` is stored. A repeat, including two copies arriving at the same moment, is acknowledged and ignored.
3. **Sending starts with an atomic claim.** A request moves from `waiting` to `sending` with `UPDATE … WHERE status = 'waiting'`. Only one caller can win that, so two webhooks, or a webhook and the sweep, can never both email the same person.
4. **Every send carries an `Idempotency-Key`** of `back-in-stock-request-{id}`. If the process dies after the email API accepted the email but before the database recorded it, the retry reuses the key and the email API returns the original instead of sending again.

**Not zero**

5. **The webhook is a hint, not the truth.** It must have the right secret, and before anyone is emailed the stock API is checked. A webhook claiming a restock the stock API doesn't confirm sends nothing, and the requests keep waiting.
6. **Failed sends are retried** with backoff (30s, 2m, 8m, 30m, then hourly). They are only given up on when the email API says the email itself is invalid (400/422), and those show as "Failed" in the admin.
7. **A sweep catches what webhooks miss.** Every minute, each product with waiting requests is checked against the stock API. That covers lost webhooks, stock API outages during a webhook, and backed-off retries.
8. **It survives a restart.** Everything is in SQLite (WAL, `synchronous=FULL`, on the `/data` volume). On start-up, requests interrupted mid-send go back to `waiting` and are retried with the same idempotency key. Webhooks are stored before they're acknowledged, and on `SIGTERM` the app finishes in-flight sends before exiting.

Trade-off: if a product sells out again before the sweep or webhook gets to it, those customers keep waiting for the next restock rather than getting an email for stock that's already gone.

## Tests

```bash
npm test     # 12 tests: duplicates, concurrency, phantom restocks, failed sends, outages, restart mid-send, auth
npm run soak # ~40s end-to-end run against the real process
```

The soak test runs the server as a separate process against a fake store with the same API shapes as the challenge harness. It sends a few hundred sign-ups, restocks (30% delivered twice, concurrently), sell-outs, phantom restocks and bad-secret webhooks, fails 15% of email sends and 5% of stock checks, and kills the app with `SIGKILL` halfway through. It then checks that no request was emailed twice, every notified request has exactly one accepted email, and nobody is left waiting for a product that's in stock (other than sends still in their retry backoff).

## What I'd add for production

Postgres instead of SQLite if it runs on more than one instance (the claim becomes `UPDATE … RETURNING` under row locks), a cancel link in the email, rate limiting on `POST /api/requests`, double opt-in where the law requires it, and HMAC-signed webhooks instead of a shared secret header.
