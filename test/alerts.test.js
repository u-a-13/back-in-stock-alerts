'use strict';

// Each test names the mechanism it pins. Waits are on a recorded outcome
// (a webhook's stored result, a request's status), never on a fixed sleep,
// so an assertion like "nothing was emailed" can only pass AFTER the event
// was actually processed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, makeStore } = require('../src/db');
const { makeStockClient, makeMailer } = require('../src/clients');
const { makeNotifier, backoffMs } = require('../src/notifier');
const { makeApp } = require('../src/app');

const SECRET = 'whsec_test';
const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(15);
  }
}

// A fake store behaving like the challenge harness: stock lookups fall back
// to the upper-cased SKU, emails are validated like Resend (422 when a
// required field is missing) and deduplicated by Idempotency-Key. Every POST
// is recorded, including the ones the key deduplicated.
function fakeUpstream() {
  const state = {
    stock: {}, inStockOverride: {}, stockDown: false, stockDelayMs: 0, stockChecks: [],
    posts: [], emails: [], dedupeHits: 0, failFor: {}, rejectFor: new Set(), emailDelayMs: 0,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && url.pathname.startsWith('/stock')) {
      if (state.stockDelayMs) await sleep(state.stockDelayMs);
      if (state.stockDown) return send(503, { error: 'down' });
      const sku = decodeURIComponent(url.pathname.slice('/stock/'.length));
      if (!sku) return send(200, { products: [{ sku: 'TEE-1', name: 'Test Tee', price: 20, currency: 'GBP', quantity: state.stock['TEE-1'] || 0, in_stock: (state.stock['TEE-1'] || 0) > 0 }] });
      state.stockChecks.push(sku);
      const q = state.stock[sku] ?? state.stock[sku.toUpperCase()] ?? 0;
      const inStock = sku in state.inStockOverride ? state.inStockOverride[sku] : q > 0;
      return send(200, { sku, quantity: q, in_stock: inStock, name: 'Test Tee', price: 20, currency: 'GBP' });
    }
    if (req.method === 'POST' && url.pathname === '/emails') {
      let raw = '';
      for await (const c of req) raw += c;
      if (state.emailDelayMs) await sleep(state.emailDelayMs);
      const body = JSON.parse(raw);
      const key = req.headers['idempotency-key'] || null;
      const to = (Array.isArray(body.to) ? body.to : [body.to]).filter(Boolean);
      const post = { key, to: to[0], status: 0 };
      state.posts.push(post);
      const missing = ['from', 'subject'].filter((f) => !body[f]);
      if (!to.length) missing.push('to');
      if (!body.html && !body.text) missing.push('html or text');
      if (missing.length) { post.status = 422; return send(422, { message: `Missing ${missing.join(', ')}` }); }
      if (state.rejectFor.has(to[0])) { post.status = 422; return send(422, { message: 'invalid recipient' }); }
      const prev = key && state.emails.find((e) => e.key === key);
      if (prev) { state.dedupeHits++; post.status = 200; return send(200, { id: prev.id }); }
      if (state.failFor[to[0]] > 0) { state.failFor[to[0]]--; post.status = 500; return send(500, { message: 'injected' }); }
      const e = { id: `em_${state.emails.length + 1}`, key, ...body, to: to[0] };
      state.emails.push(e);
      post.status = 200;
      return send(200, { id: e.id });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    state, server, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

function fakeClock() {
  let t = Date.parse('2026-11-08T10:00:00Z');
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

async function setup({ dataDir = ':memory:', upstream, config: extra = {} } = {}) {
  const up = upstream || await fakeUpstream();
  const clock = fakeClock();
  const config = { webhookSecret: SECRET, storeName: 'Test Store', productUrlTemplate: '', sweepSeconds: 60,
    bootSweepMs: 0, emailFrom: 'Alerts <alerts@test.dev>', ...extra };
  const store = makeStore(openDb(dataDir), { clock: clock.now });
  const stock = makeStockClient({ url: `${up.url}/stock`, key: 'k' });
  const mailer = makeMailer({ baseUrl: up.url, key: 'k', from: config.emailFrom });
  const notifier = makeNotifier({ store, stock, mailer, config, log: quiet });
  const server = makeApp({ store, stock, notifier, config, adminPassword: 'pw', log: quiet });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const hook = (body, secret = SECRET) => post('/webhooks/stock', body, { 'x-webhook-secret': secret });
  const signup = async (email, sku) => (await post('/api/requests', { email, sku })).json();
  const outcome = (eventId) => store.db.prepare('SELECT outcome FROM webhook_events WHERE event_id = ?').get(eventId)?.outcome;
  const statusOf = (id) => store.getRequest(id).status;
  let closed = false;
  async function close({ keepUpstream = false } = {}) {
    if (closed) return;
    closed = true;
    await notifier.stop();
    await new Promise((r) => server.close(r));
    store.db.close();
    if (!keepUpstream) await up.close();
  }
  return { up, store, notifier, clock, base, post, hook, signup, outcome, statusOf, close };
}

// ------------------------------------------------------------ sign-up

test('R1: a second request for the same open (email, sku) returns the first, whatever the case of either', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const a = await s.post('/api/requests', { email: 'Ann@Example.com', sku: 'mug-1' });
  const b = await s.post('/api/requests', { email: 'ann@example.com ', sku: 'MUG-1' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal((await b.json()).already_requested, true);
  assert.equal(s.store.counts().waiting, 1);
});

test('R1: the database itself refuses a second open row for the same customer and product', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const ins = s.store.db.prepare(`INSERT INTO requests (email, sku, created_at) VALUES ('a@b.co', 'TEE-1', 'x')`);
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/);
});

test('sign-up validates input, and accepts real-world SKUs with spaces', async (t) => {
  const s = await setup(); t.after(() => s.close());
  assert.equal((await s.post('/api/requests', { email: 'nope', sku: 'TEE-1' })).status, 400);
  assert.equal((await s.post('/api/requests', { email: 'a@b.co', sku: '' })).status, 400);
  assert.equal((await s.post('/api/requests', { email: 'a@b.co', sku: 'TEE 1 XL' })).status, 201);
});

test('signing up for an item that is in stock creates no alert', async (t) => {
  const s = await setup(); t.after(() => s.close());
  s.up.state.stock['TEE-1'] = 5;
  assert.equal((await s.signup('a@b.co', 'TEE-1')).status, 'in_stock');
  assert.equal(s.store.counts().waiting, 0);
});

test('sign-up still stores the request when the stock API is down', async (t) => {
  const s = await setup(); t.after(() => s.close());
  s.up.state.stockDown = true;
  const r = await s.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  assert.equal(r.status, 201);
  assert.equal(s.store.counts().waiting, 1);
});

test('sign-up answers quickly even when the stock API is slow', async (t) => {
  const s = await setup(); t.after(() => s.close());
  s.up.state.stockDelayMs = 5000;
  const t0 = Date.now();
  const r = await s.post('/api/requests', { email: 'a@b.co', sku: 'TEE-1' });
  assert.equal(r.status, 201);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
});

// ------------------------------------------------------------ webhooks

test('R5: webhooks with a wrong or missing secret are refused, and one without an event_id is rejected', async (t) => {
  const s = await setup(); t.after(() => s.close());
  assert.equal((await s.hook({ event_id: 'e1', sku: 'TEE-1', quantity: 3 }, 'wrong')).status, 401);
  assert.equal((await s.post('/webhooks/stock', { event_id: 'e1', sku: 'TEE-1' })).status, 401);
  assert.equal((await s.hook({ sku: 'TEE-1', quantity: 3 })).status, 400);
});

test('R5: a webhook claiming a restock the stock API does not confirm is processed and emails nobody', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  await s.hook({ event_id: 'phantom', sku: 'TEE-1', quantity: 12 });
  const outcome = await waitFor(() => s.outcome('phantom'), 'phantom webhook outcome');
  assert.match(outcome, /stock API says 0/);
  assert.ok(s.up.state.stockChecks.includes('TEE-1'), 'the stock API was consulted');
  assert.equal(s.up.state.posts.length, 0);
  assert.equal(s.statusOf(id), 'waiting');
});

test('R5: quantity above zero with in_stock false is not a restock', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 3;
  s.up.state.inStockOverride['TEE-1'] = false;
  await s.hook({ event_id: 'e-flag', sku: 'TEE-1', quantity: 3 });
  await waitFor(() => s.outcome('e-flag'), 'webhook outcome');
  assert.equal(s.up.state.posts.length, 0);
  assert.equal(s.statusOf(id), 'waiting');
});

test('R2+R3: the same webhook delivered twice at once sends each customer exactly one email', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const ids = [];
  for (const e of ['a@b.co', 'c@d.co', 'e@f.co']) ids.push((await s.signup(e, 'TEE-1')).id);
  s.up.state.stock['TEE-1'] = 4;
  s.up.state.emailDelayMs = 40;
  const body = { event_id: 'evt_dup', sku: 'TEE-1', quantity: 4 };
  const [r1, r2, r3] = await Promise.all([s.hook(body), s.hook(body), s.hook({ ...body, event_id: 'evt_other' })]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 202]);
  assert.equal(r3.status, 202);
  await waitFor(() => ids.every((id) => s.statusOf(id) === 'notified'), 'all three notified');
  await waitFor(() => s.outcome('evt_dup') && s.outcome('evt_other'), 'both outcomes');
  assert.equal(s.up.state.posts.length, 3, 'three POSTs in total: no second send was even attempted');
  assert.equal(s.up.state.dedupeHits, 0);
  assert.deepEqual(s.up.state.emails.map((e) => e.to).sort(), ['a@b.co', 'c@d.co', 'e@f.co']);
  assert.equal(s.store.db.prepare(`SELECT deliveries FROM webhook_events WHERE event_id = 'evt_dup'`).get().deliveries, 2);
});

test('R1: a webhook in one case reaches requests stored in another', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'mug-1');
  s.up.state.stock['MUG-1'] = 2;
  await s.hook({ event_id: 'e-case', sku: 'MUG-1', quantity: 2 });
  await waitFor(() => s.outcome('e-case'), 'webhook outcome');
  assert.equal(s.statusOf(id), 'notified');
});

// ------------------------------------------------------------ the send

test('R3: only one caller can claim a request', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  assert.equal(s.store.claim(id), true);
  assert.equal(s.store.claim(id), false);
  s.store.markNotified(id, 'em_1');
  assert.equal(s.store.claim(id), false);
});

test('R3: concurrent runs for one product are coalesced into one stock check', async (t) => {
  const s = await setup(); t.after(() => s.close());
  await s.signup('a@b.co', 'TEE-1');
  s.up.state.stockChecks.length = 0;
  s.up.state.stock['TEE-1'] = 2;
  s.up.state.stockDelayMs = 50;
  await Promise.all([s.notifier.processSku('TEE-1'), s.notifier.processSku('TEE-1')]);
  assert.equal(s.up.state.stockChecks.filter((x) => x === 'TEE-1').length, 1);
  assert.equal(s.up.state.posts.length, 1);
});

test('R7: a trigger during a run queues a re-run that picks up the new request', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const first = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 2;
  s.up.state.stockDelayMs = 150;
  const run = s.notifier.processSku('TEE-1');
  await sleep(40); // the first run is now inside its stock check
  const { request } = s.store.createRequest('late@b.co', 'TEE-1');
  await Promise.all([run, s.notifier.processSku('TEE-1')]);
  assert.equal(s.statusOf(first.id), 'notified');
  assert.equal(s.statusOf(request.id), 'notified');
});

test('M5: the email is sent in Resend format, with the product, subject, HTML and text', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 2;
  await s.notifier.processSku('TEE-1');
  assert.equal(s.statusOf(id), 'notified');
  const [e] = s.up.state.emails;
  assert.equal(e.from, 'Alerts <alerts@test.dev>');
  assert.equal(e.to, 'a@b.co');
  assert.equal(e.subject, 'Back in stock: Test Tee');
  assert.match(e.html, /^<!doctype html>/i);
  assert.match(e.html, /Test Tee/);
  assert.match(e.text, /Test Tee/);
  assert.equal(e.key, `back-in-stock-request-${id}`);
});

// ------------------------------------------------------------ retries

test('R6: the retry backoff starts at 15s, never decreases, and is capped at one hour', () => {
  const values = Array.from({ length: 30 }, (_, i) => backoffMs(i + 1));
  assert.equal(values.length, 30);
  assert.equal(values[0], 15_000);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], `attempt ${i + 1} decreased`);
  assert.ok(values.every((v) => v <= 3_600_000));
  assert.equal(values.at(-1), 3_600_000);
});

test('R6: a failed send waits out its backoff, then sends exactly once', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 2;
  s.up.state.failFor['a@b.co'] = 1;
  await s.notifier.processSku('TEE-1');
  assert.equal(s.statusOf(id), 'waiting');
  assert.match(s.store.getRequest(id).last_error, /500/);
  assert.equal(s.up.state.posts.length, 1);

  await s.notifier.sweep(); // still inside the backoff
  assert.equal(s.up.state.posts.length, 1, 'no retry before the backoff ends');

  s.clock.advance(backoffMs(1));
  await s.notifier.sweep();
  assert.equal(s.statusOf(id), 'notified');
  assert.equal(s.up.state.emails.length, 1);
});

test('R6: a new webhook during a retry backoff does not bypass it', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 2;
  s.up.state.failFor['a@b.co'] = 1;
  await s.notifier.processSku('TEE-1');
  assert.equal(s.up.state.posts.length, 1);
  await s.hook({ event_id: 'e-during-backoff', sku: 'TEE-1', quantity: 2 });
  await waitFor(() => s.outcome('e-during-backoff'), 'webhook outcome');
  assert.equal(s.up.state.posts.length, 1, 'no send while the backoff runs');
  assert.equal(s.statusOf(id), 'waiting');
});

test('R6: a customer whose send failed after a confirmed restock is still emailed if it sells out again', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 1;
  s.up.state.failFor['a@b.co'] = 1;
  await s.notifier.processSku('TEE-1');
  assert.equal(s.statusOf(id), 'waiting');
  s.up.state.stock['TEE-1'] = 0; // sold out before the retry
  s.clock.advance(backoffMs(1));
  await s.notifier.sweep();
  assert.equal(s.statusOf(id), 'notified');
  assert.equal(s.up.state.emails.length, 1);
});

test('R6: an email the API rejects as invalid fails permanently and is not retried', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('bad@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 2;
  s.up.state.rejectFor.add('bad@b.co');
  await s.notifier.processSku('TEE-1');
  assert.equal(s.statusOf(id), 'failed');
  s.clock.advance(3_600_000);
  await s.notifier.sweep();
  assert.equal(s.up.state.posts.length, 1);
});

// ------------------------------------------------------------ sweep, restart, shutdown

test('R7: a lost webhook is caught by the sweep', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 3;
  await s.notifier.sweep();
  assert.equal(s.statusOf(id), 'notified');
});

test('R7: the sweep runs on its own schedule after start-up', async (t) => {
  const s = await setup({ config: { sweepSeconds: 0.05 } }); t.after(() => s.close());
  s.notifier.start();
  await sleep(30); // the boot sweep has run over an empty database
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 3; // restocked with no webhook
  await waitFor(() => s.statusOf(id) === 'notified', 'notified by the periodic sweep');
});

test('stock API down during a webhook: nothing is sent, nothing is lost', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 3;
  s.up.state.stockDown = true;
  await s.hook({ event_id: 'e-down', sku: 'TEE-1', quantity: 3 });
  assert.match(await waitFor(() => s.outcome('e-down'), 'webhook outcome'), /stock check failed/);
  assert.equal(s.up.state.posts.length, 0);
  assert.equal(s.statusOf(id), 'waiting');
  s.up.state.stockDown = false;
  await s.notifier.sweep();
  assert.equal(s.statusOf(id), 'notified');
});

test('R4+R8: after a crash mid-send, start-up resends with the same key and nobody gets two emails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const up = await fakeUpstream();
  t.after(() => up.close());
  let s = await setup({ dataDir: dir, upstream: up });
  const a = await s.signup('a@b.co', 'TEE-1');
  const z = await s.signup('z@y.co', 'TEE-1');
  // The crash: the email API accepted a@b.co's email, but the process died
  // before recording it, so the row is still "sending".
  assert.equal(s.store.claim(a.id), true);
  up.state.emails.push({ id: 'em_pre', key: `back-in-stock-request-${a.id}`, to: 'a@b.co' });
  await s.close({ keepUpstream: true });

  s = await setup({ dataDir: dir, upstream: up });
  t.after(() => s.close({ keepUpstream: true }));
  assert.equal(s.statusOf(a.id), 'sending');
  up.state.stock['TEE-1'] = 1;
  s.notifier.start();
  await waitFor(() => s.statusOf(a.id) === 'notified' && s.statusOf(z.id) === 'notified', 'both notified after restart');
  assert.equal(up.state.emails.filter((e) => e.to === 'a@b.co').length, 1);
  assert.equal(up.state.dedupeHits, 1, 'the resend reused the key and was deduplicated');
  assert.equal(up.state.emails.filter((e) => e.to === 'z@y.co').length, 1);
});

test('R8: stopping waits for an in-flight send to be recorded', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 2;
  s.up.state.emailDelayMs = 200;
  const run = s.notifier.processSku('TEE-1');
  await waitFor(() => s.statusOf(id) === 'sending', 'send in flight');
  await s.notifier.stop();
  assert.equal(s.statusOf(id), 'notified');
  await run;
});

// ------------------------------------------------------------ pages

test('M4: admin refuses a missing or wrong password and lists requests with status and notified time', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const auth = (pw) => ({ authorization: 'Basic ' + Buffer.from(`admin:${pw}`).toString('base64') });
  assert.equal((await fetch(`${s.base}/admin`)).status, 401);
  assert.equal((await fetch(`${s.base}/admin`, { headers: auth('wrong') })).status, 401);
  const done = await s.signup('done@b.co', 'TEE-1');
  await s.signup('wait@b.co', 'MUG-1');
  s.clock.advance(3 * 3_600_000); // so the notified time cannot be mistaken for the requested time
  s.up.state.stock['TEE-1'] = 1;
  await s.notifier.processSku('TEE-1');
  const { notified_at: notifiedAt, created_at: createdAt } = s.store.getRequest(done.id);
  assert.ok(notifiedAt);
  assert.notEqual(notifiedAt.slice(0, 16), createdAt.slice(0, 16));
  const ok = await fetch(`${s.base}/admin`, { headers: auth('pw') });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /done@b\.co[\s\S]*?Notified/);
  assert.ok(html.includes(notifiedAt.slice(0, 16).replace('T', ' ')), 'notified time shown');
  assert.match(html, /wait@b\.co[\s\S]*?Waiting/);
});

test('M1: the embed form can be framed, and its script posts to an endpoint that exists, with or without a trailing slash', async (t) => {
  const s = await setup(); t.after(() => s.close());
  for (const p of ['/embed?sku=TEE-1', '/embed/?sku=TEE-1']) {
    const r = await fetch(`${s.base}${p}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors \*/);
    assert.equal(r.headers.get('x-frame-options'), null);
    const target = (await r.text()).match(/fetch\('([^']+)'/)[1];
    const res = await fetch(new URL(target, `${s.base}${p}`), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f@b.co', sku: 'TEE-1' }),
    });
    assert.ok([200, 201].includes(res.status), `${p} posts to ${target}: HTTP ${res.status}`);
  }
});

test('an owed resend after a sell-out does not claim a stock count it cannot know', async (t) => {
  const s = await setup(); t.after(() => s.close());
  const { id } = await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 3;
  s.up.state.failFor['a@b.co'] = 1;
  await s.notifier.processSku('TEE-1');
  s.up.state.stock['TEE-1'] = 0;
  s.clock.advance(backoffMs(1));
  await s.notifier.sweep();
  assert.equal(s.statusOf(id), 'notified');
  const [e] = s.up.state.emails;
  assert.ok(e, 'the owed email was sent');
  assert.doesNotMatch(e.html, /left</);
  assert.doesNotMatch(e.text, / left\./);
});

test('a first send with a confirmed low count says how many are left', async (t) => {
  const s = await setup(); t.after(() => s.close());
  await s.signup('a@b.co', 'TEE-1');
  s.up.state.stock['TEE-1'] = 3;
  await s.notifier.processSku('TEE-1');
  const [e] = s.up.state.emails;
  assert.match(e.html, /Only 3 left/);
  assert.match(e.text, /Only 3 left\./);
});
