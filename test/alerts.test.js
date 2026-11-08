'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, makeStore } = require('../src/db');
const { makeStockClient, makeMailer } = require('../src/clients');
const { makeNotifier } = require('../src/notifier');
const { makeApp } = require('../src/app');

const SECRET = 'whsec_test';
const quiet = { info() {}, warn() {}, error() {} };

// A fake stock API + Resend, with failure injection and idempotency keys.
function fakeUpstream() {
  const state = { stock: {}, emails: [], failNext: 0, stockDown: false, delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && url.pathname.startsWith('/stock')) {
      if (state.stockDown) return send(503, { error: 'down' });
      const sku = decodeURIComponent(url.pathname.slice('/stock/'.length));
      if (!sku) return send(200, { products: [{ sku: 'TEE-1', name: 'Test Tee', price: 20, currency: 'GBP' }] });
      const q = state.stock[sku] || 0;
      return send(200, { sku, quantity: q, in_stock: q > 0, name: 'Test Tee', price: 20 });
    }
    if (req.method === 'POST' && url.pathname === '/emails') {
      let body = '';
      for await (const c of req) body += c;
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const key = req.headers['idempotency-key'];
      const prev = state.emails.find((e) => e.key === key && e.ok);
      if (prev) return send(200, { id: prev.id });
      if (state.failNext > 0) { state.failNext--; return send(500, { message: 'injected' }); }
      const e = { id: `em_${state.emails.length + 1}`, key, ok: true, ...JSON.parse(body) };
      state.emails.push(e);
      return send(200, { id: e.id });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function setup(dataDir = ':memory:', upstream) {
  const up = upstream || await fakeUpstream();
  const config = { webhookSecret: SECRET, storeName: 'Test Store', productUrlTemplate: '', sweepSeconds: 60, emailFrom: 'a@b.co' };
  const store = makeStore(openDb(dataDir));
  const stock = makeStockClient({ url: `${up.url}/stock`, key: 'k' });
  const mailer = makeMailer({ baseUrl: up.url, key: 'k', from: config.emailFrom });
  const notifier = makeNotifier({ store, stock, mailer, config, log: quiet });
  const server = makeApp({ store, stock, notifier, config, adminPassword: 'pw', log: quiet });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const hook = (body, secret = SECRET) => post('/webhooks/stock', body, { 'x-webhook-secret': secret });
  const close = () => { server.close(); store.db.close(); };
  return { up, store, notifier, base, post, hook, close };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('a second request for the same open (email, sku) is not duplicated', async () => {
  const t = await setup();
  const a = await t.post('/api/requests', { email: 'Ann@Example.com', sku: 'TEE-1' });
  const b = await t.post('/api/requests', { email: 'ann@example.com ', sku: 'TEE-1' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal((await b.json()).already_requested, true);
  assert.equal(t.store.counts().waiting, 1);
  t.close(); t.up.server.close();
});

test('bad input is rejected', async () => {
  const t = await setup();
  assert.equal((await t.post('/api/requests', { email: 'nope', sku: 'TEE-1' })).status, 400);
  assert.equal((await t.post('/api/requests', { email: 'a@b.co', sku: '' })).status, 400);
  t.close(); t.up.server.close();
});

test('signing up for an item that is in stock does not create an alert', async () => {
  const t = await setup();
  t.up.state.stock['TEE-1'] = 5;
  const r = await t.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  assert.equal((await r.json()).status, 'in_stock');
  assert.equal(t.store.counts().waiting, 0);
  t.close(); t.up.server.close();
});

test('webhooks with a wrong or missing secret are refused', async () => {
  const t = await setup();
  assert.equal((await t.hook({ event_id: 'e1', sku: 'TEE-1', quantity: 3 }, 'wrong')).status, 401);
  assert.equal((await t.post('/webhooks/stock', { event_id: 'e1', sku: 'TEE-1' })).status, 401);
  t.close(); t.up.server.close();
});

test('a webhook that claims a restock the stock API does not confirm sends nothing', async () => {
  const t = await setup();
  await t.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  await t.hook({ event_id: 'phantom', sku: 'TEE-1', quantity: 12 });
  await settle();
  assert.equal(t.up.state.emails.length, 0);
  assert.equal(t.store.counts().waiting, 1);
  t.close(); t.up.server.close();
});

test('the same webhook delivered twice at once sends each customer exactly one email', async () => {
  const t = await setup();
  for (const e of ['a@b.co', 'c@d.co', 'e@f.co']) await t.post('/api/requests', { email: e, sku: 'TEE-1' });
  t.up.state.stock['TEE-1'] = 4;
  t.up.state.delayMs = 50;
  const body = { event_id: 'evt_dup', sku: 'TEE-1', quantity: 4 };
  const [r1, r2] = await Promise.all([t.hook(body), t.hook(body)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 202]);
  // And a different event for the same restock arriving at the same time.
  await t.hook({ event_id: 'evt_other', sku: 'TEE-1', quantity: 4 });
  await settle(500);
  assert.equal(t.up.state.emails.length, 3);
  assert.deepEqual(t.up.state.emails.map((e) => e.to[0]).sort(), ['a@b.co', 'c@d.co', 'e@f.co']);
  assert.equal(t.store.counts().notified, 3);
  t.close(); t.up.server.close();
});

test('a failed send is retried and the customer still gets exactly one email', async () => {
  const t = await setup();
  await t.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  t.up.state.stock['TEE-1'] = 2;
  t.up.state.failNext = 1;
  await t.hook({ event_id: 'e-fail', sku: 'TEE-1', quantity: 2 });
  await settle();
  assert.equal(t.up.state.emails.length, 0);
  const [row] = t.store.listRequests();
  assert.equal(row.status, 'waiting');
  assert.match(row.last_error, /500/);
  t.store.db.prepare(`UPDATE requests SET next_attempt_at = NULL`).run(); // skip the backoff wait
  await t.notifier.sweep();
  assert.equal(t.up.state.emails.length, 1);
  assert.equal(t.store.counts().notified, 1);
  t.close(); t.up.server.close();
});

test('a lost webhook is caught by the sweep', async () => {
  const t = await setup();
  await t.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  t.up.state.stock['TEE-1'] = 3; // restocked, but no webhook ever arrives
  await t.notifier.sweep();
  assert.equal(t.up.state.emails.length, 1);
  t.close(); t.up.server.close();
});

test('stock API down: nothing is sent and nothing is lost', async () => {
  const t = await setup();
  await t.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  t.up.state.stock['TEE-1'] = 3;
  t.up.state.stockDown = true;
  await t.hook({ event_id: 'e-down', sku: 'TEE-1', quantity: 3 });
  await settle(800);
  assert.equal(t.up.state.emails.length, 0);
  t.up.state.stockDown = false;
  await t.notifier.sweep();
  assert.equal(t.up.state.emails.length, 1);
  t.close(); t.up.server.close();
});

test('state survives a restart, including a crash mid-send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-'));
  const up = await fakeUpstream();
  let t = await setup(dir, up);
  await t.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  await t.post('/api/requests', { email: 'z@y.co', sku: 'TEE-1' });
  // Simulate a crash after Resend accepted the email but before we recorded it.
  const id = t.store.listRequests().find((r) => r.email === 'a@b.co').id;
  t.store.claim(id);
  up.state.emails.push({ id: 'em_pre', key: `back-in-stock-request-${id}`, ok: true, to: ['a@b.co'] });
  t.close();

  t = await setup(dir, up);
  assert.equal(t.store.counts().sending, 1);
  t.store.releaseStuck(); // what start() does on boot
  up.state.stock['TEE-1'] = 1;
  await t.notifier.sweep();
  assert.equal(up.state.emails.filter((e) => e.to[0] === 'a@b.co').length, 1, 'idempotency key prevented a second email');
  assert.equal(up.state.emails.filter((e) => e.to[0] === 'z@y.co').length, 1);
  assert.equal(t.store.counts().notified, 2);
  t.close(); up.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admin needs the password', async () => {
  const t = await setup();
  assert.equal((await fetch(`${t.base}/admin`)).status, 401);
  const ok = await fetch(`${t.base}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Restock alerts/);
  t.close(); t.up.server.close();
});

test('the embed form can be framed by other sites', async () => {
  const t = await setup();
  const r = await fetch(`${t.base}/embed?sku=TEE-1`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(r.headers.get('x-frame-options'), null);
  t.close(); t.up.server.close();
});
