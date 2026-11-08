'use strict';

// End-to-end soak test against the real server process.
// A fake store (stock API + Resend, same shapes as the challenge harness)
// throws sign-ups, restocks, duplicate and concurrent webhooks, phantom
// restocks and failing email sends at the app, kills it with SIGKILL halfway
// through, restarts it, then checks the invariants:
//   1. nobody got two emails for the same request
//   2. every notified request has exactly one accepted email
//   3. every request still waiting is for a product that really is sold out
//
//   node test/soak.js            (about 40 seconds)

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SECRET = 'whsec_soak';
const KEY = 're_test_soak';
const SKUS = ['TEE-ORG-WHT-M', 'HOOD-FLC-GRY-M', 'MUG-STN-SAGE', 'KNF-CHF-20', 'BAG-LTH-TAN', 'NB-DOT-A5'];
const stock = Object.fromEntries(SKUS.map((s) => [s, 0]));
const emails = [];
let failRate = 0.15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if ((req.headers.authorization || '') !== `Bearer ${KEY}`) return send(401, { message: 'bad key' });
  if (req.method === 'GET' && url.pathname.startsWith('/api/stock')) {
    if (Math.random() < 0.05) return send(503, { error: 'flaky' }); // don't trust the network
    const sku = decodeURIComponent(url.pathname.slice('/api/stock/'.length));
    if (!sku) return send(200, { products: SKUS.map((s) => ({ sku: s, name: s.toLowerCase(), price: 25, currency: 'GBP', image: `https://picsum.photos/seed/${s}/600/600` })) });
    const q = stock[sku] || 0;
    return send(200, { sku, name: sku.toLowerCase(), price: 25, currency: 'GBP', quantity: q, in_stock: q > 0 });
  }
  if (req.method === 'POST' && url.pathname === '/emails') {
    let raw = '';
    for await (const c of req) raw += c;
    await sleep(Math.random() * 80);
    const key = req.headers['idempotency-key'];
    const prev = emails.find((e) => e.key === key && e.status === 'accepted');
    if (prev) return send(200, { id: prev.id });
    const body = JSON.parse(raw);
    if (Math.random() < failRate) { emails.push({ key, to: body.to[0], status: 'failed' }); return send(500, { message: 'injected' }); }
    const e = { id: crypto.randomUUID(), key, to: body.to[0], subject: body.subject, status: 'accepted' };
    emails.push(e);
    return send(200, { id: e.id });
  }
  send(404, {});
});

let app;
let appUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-soak-'));

function startApp(port, upstreamUrl) {
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SWEEP_INTERVAL_SECONDS: '3', ADMIN_PASSWORD: 'soak',
      STOCK_API_URL: `${upstreamUrl}/api/stock`, STOCK_API_KEY: KEY, RESEND_API_KEY: KEY, RESEND_BASE_URL: upstreamUrl, WEBHOOK_SECRET: SECRET },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  app.stderr.on('data', (d) => { if (/Error|TypeError/.test(String(d))) process.stderr.write(`[app] ${d}`); });
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${appUrl}/healthz`)).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('app did not start');
}

async function post(p, body, headers = {}) {
  try {
    const r = await fetch(appUrl + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.status;
  } catch { return 0; }
}
const hook = (sku, quantity, eventId) => post('/webhooks/stock', { event_id: eventId, type: 'stock.updated', sku, quantity, occurred_at: new Date().toISOString() }, { 'x-webhook-secret': SECRET });

const stats = { signups: 0, restocks: 0, doubled: 0, phantoms: 0, sellouts: 0, badSecret: 0 };

async function step() {
  const roll = Math.random();
  const out = SKUS.filter((s) => !stock[s]);
  if (roll < 0.5) {
    const sku = Math.random() < 0.85 && out.length ? pick(out) : pick(SKUS);
    await post('/api/requests', { email: `${pick(['amira', 'ben', 'chloe', 'dev', 'ella', 'finn'])}.${pick(['khan', 'smith', 'ito'])}@example.com`, sku });
    stats.signups++;
  } else if (roll < 0.72 && out.length) {
    const sku = pick(out);
    stock[sku] = 1 + Math.floor(Math.random() * 20);
    const id = `evt_${crypto.randomBytes(4).toString('hex')}`;
    const twice = Math.random() < 0.3;
    await Promise.all([hook(sku, stock[sku], id), ...(twice ? [hook(sku, stock[sku], id)] : [])]);
    stats.restocks++; if (twice) stats.doubled++;
  } else if (roll < 0.88) {
    const inStock = SKUS.filter((s) => stock[s] > 0);
    if (inStock.length) { const sku = pick(inStock); stock[sku] = 0; await hook(sku, 0, `evt_${crypto.randomBytes(4).toString('hex')}`); stats.sellouts++; }
  } else if (roll < 0.96 && out.length) {
    await hook(pick(out), 12, `evt_${crypto.randomBytes(4).toString('hex')}`); // phantom: stock API still says 0
    stats.phantoms++;
  } else {
    await post('/webhooks/stock', { event_id: 'evil', sku: pick(SKUS), quantity: 99 }, { 'x-webhook-secret': 'nope' });
    stats.badSecret++;
  }
}

(async () => {
  await new Promise((r) => upstream.listen(0, r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const port = 3900 + Math.floor(Math.random() * 90);
  appUrl = `http://127.0.0.1:${port}`;
  startApp(port, upstreamUrl);
  await waitUp();

  const t0 = Date.now();
  let killed = false;
  while (Date.now() - t0 < 24_000) {
    await Promise.all([step(), step(), step()]);
    if (!killed && Date.now() - t0 > 11_000) {
      killed = true;
      app.kill('SIGKILL'); // hard crash, possibly mid-send
      await sleep(300);
      startApp(port, upstreamUrl);
      await waitUp();
    }
    await sleep(60);
  }

  // Let retries and sweeps finish with a reliable network.
  failRate = 0;
  await sleep(14_000);

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'alerts.db'), { readOnly: true });
  const rows = db.prepare('SELECT * FROM requests').all();
  db.close();
  app.kill('SIGTERM');
  upstream.close();

  const accepted = emails.filter((e) => e.status === 'accepted');
  const byKey = new Map();
  for (const e of accepted) byKey.set(e.key, (byKey.get(e.key) || 0) + 1);
  const dupes = [...byKey.values()].filter((n) => n > 1).length;
  const notified = rows.filter((r) => r.status === 'notified');
  const missing = notified.filter((r) => byKey.get(`back-in-stock-request-${r.id}`) !== 1).length;
  const waiting = rows.filter((r) => r.status !== 'notified');
  // A failed send waits out its backoff (30s, then 2m...), so it counts as
  // stranded only if it is in stock and not scheduled for a retry.
  // (allowing one sweep interval plus a margin for a retry that just came due)
  const nowIso = new Date(Date.now() - 6000).toISOString();
  const inStockWaiting = waiting.filter((r) => stock[r.sku] > 0);
  const scheduled = inStockWaiting.filter((r) => r.next_attempt_at && r.next_attempt_at > nowIso);
  const strandedInStock = inStockWaiting.length - scheduled.length;
  if (strandedInStock) console.log(inStockWaiting.filter((r) => !scheduled.includes(r)).slice(0, 5));
  stats.retriesScheduled = scheduled.length;
  const orphanEmails = [...byKey.keys()].filter((k) => !notified.some((r) => `back-in-stock-request-${r.id}` === k)).length;

  console.log('Soak run:', JSON.stringify({ ...stats, requests: rows.length, notified: notified.length, waiting: waiting.length,
    emailsAccepted: accepted.length, sendFailuresInjected: emails.filter((e) => e.status === 'failed').length }));
  const checks = [
    ['no duplicate emails', dupes === 0, `${dupes} request(s) emailed twice`],
    ['every notified request has exactly one email', missing === 0, `${missing} mismatch(es)`],
    ['no email without a notified request', orphanEmails === 0, `${orphanEmails} orphan(s)`],
    ['nobody left waiting for an in-stock product', strandedInStock === 0, `${strandedInStock} stranded`],
  ];
  for (const [name, ok, why] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${why}`}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
})().catch((e) => { console.error(e); try { app.kill('SIGKILL'); } catch { /* */ } process.exit(1); });
