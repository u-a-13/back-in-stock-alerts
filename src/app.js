'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { renderEmbed, renderAdmin } = require('./views');

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
// 1-64 printable characters, no leading or trailing space (input is trimmed).
const SKU_RE = /^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]{0,62}[^\s\x00-\x1f\x7f])?$/;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length;
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }); }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json', ...headers });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };

function cleanSourceUrl(u) {
  try {
    const x = new URL(String(u));
    return /^https?:$/.test(x.protocol) && x.href.length <= 500 ? x.href : null;
  } catch { return null; }
}

function makeApp({ store, stock, notifier, config, adminPassword, log = console }) {
  async function createRequest(req, res) {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const sku = String(body.sku || '').trim();
    if (!EMAIL_RE.test(email) || email.length > 254) return json(res, 400, { error: 'Please enter a valid email address.' }, CORS);
    if (!SKU_RE.test(sku)) return json(res, 400, { error: 'That product code is not valid.' }, CORS);

    // If it's already in stock there's nothing to wait for. If the stock API
    // is slow or down we store the request anyway: the sweep will sort it out.
    try {
      const s = await stock.check(sku, { attempts: 1, timeoutMs: 1500 });
      if (s.inStock) {
        return json(res, 200, { status: 'in_stock', sku, quantity: s.quantity }, CORS);
      }
    } catch (e) {
      log.warn(`${sku}: stock check during sign-up failed, storing request anyway: ${e.message}`);
    }

    const { request, created } = store.createRequest(email, sku, cleanSourceUrl(body.source_url));
    return json(res, created ? 201 : 200, {
      id: request.id, email: request.email, sku: request.sku, status: request.status,
      created_at: request.created_at, already_requested: !created,
    }, CORS);
  }

  async function stockWebhook(req, res) {
    const given = req.headers['x-webhook-secret'];
    if (!config.webhookSecret || !given || !safeEqual(given, config.webhookSecret)) {
      return json(res, 401, { error: 'Invalid webhook secret' });
    }
    const body = await readJson(req);
    const sku = String(body.sku || '').trim();
    const eventId = String(body.event_id || '').trim().slice(0, 128);
    if (!SKU_RE.test(sku) || !eventId) return json(res, 400, { error: 'event_id and sku are required' });

    const first = store.recordEvent(eventId, sku, Number(body.quantity));
    if (!first) return json(res, 200, { received: true, duplicate: true });

    // Acknowledge now, work after. The event is already stored, and the sweep
    // covers us if this process dies before finishing.
    json(res, 202, { received: true });
    notifier.processSku(sku)
      .then((outcome) => store.setEventOutcome(eventId, outcome))
      .catch((e) => { store.setEventOutcome(eventId, `error: ${e.message}`); log.error(e); });
  }

  function checkAdmin(req, res) {
    const [scheme, b64] = String(req.headers.authorization || '').split(' ');
    const pass = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    if (pass && safeEqual(pass, adminPassword)) return true;
    send(res, 401, 'Password required', { 'www-authenticate': 'Basic realm="Restock alerts admin", charset="UTF-8"' });
    return false;
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (p === '/healthz') return send(res, 200, 'ok');
    if (p === '/') return send(res, 302, '', { location: '/embed' });

    if (p === '/embed' && (m === 'GET' || m === 'HEAD')) {
      const sku = String(url.searchParams.get('sku') || '').trim();
      const valid = SKU_RE.test(sku);
      // Live stock decides which state the form opens in; if the API is slow
      // or down we just show the sign-up form.
      const [product, live] = valid
        ? await Promise.all([stock.product(sku).catch(() => null), stock.check(sku, { attempts: 1, timeoutMs: 1500 }).catch(() => null)])
        : [null, null];
      return send(res, 200, renderEmbed({ sku: valid ? sku : '', product: product || (live && live.name ? live : null), inStock: !!(live && live.inStock), accent: url.searchParams.get('accent') }), {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "frame-ancestors *; default-src 'self'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'referrer-policy': 'strict-origin-when-cross-origin',
      });
    }

    if (p === '/api/requests') {
      if (m === 'OPTIONS') return send(res, 204, '', CORS);
      if (m === 'POST') return createRequest(req, res);
    }

    if (p === '/webhooks/stock' && m === 'POST') return stockWebhook(req, res);

    if (p === '/admin' && m === 'GET') {
      if (!checkAdmin(req, res)) return;
      const status = ['waiting', 'notified', 'failed', 'sending'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      await stock.product('__warm__').catch(() => null); // warm the catalogue cache for names
      return send(res, 200, renderAdmin({
        rows: store.listRequests({ status, q }), counts: store.counts(), events: store.recentEvents(),
        filter: status, q, catalog: stock.catalogList(),
      }), { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store' });
    }

    return json(res, 404, { error: 'Not found' });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!e.status) log.error(e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Internal error' }, CORS);
    });
  });
}

module.exports = { makeApp };
