'use strict';

// Outbound calls: the stock API (source of truth for stock) and Resend.
// Neither is trusted to be up, fast, or well-formed.

const TIMEOUT_MS = 8000;

class HttpError extends Error {
  constructor(message, { status = 0, retryable = true } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new HttpError(`Network error: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { res, body, text };
}

function makeStockClient({ url, key }) {
  const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
  let catalog = { at: 0, bySku: new Map() };

  return {
    // { sku, quantity, inStock, name?, price?, currency?, image? }
    async check(sku) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { res, body } = await request(`${url}/${encodeURIComponent(sku)}`, { headers });
          if (!res.ok) throw new HttpError(`Stock API HTTP ${res.status}`, { status: res.status, retryable: res.status >= 500 || res.status === 429 });
          if (!body || typeof body !== 'object') throw new HttpError('Stock API returned a non-JSON body');
          const quantity = Number(body.quantity);
          if (!Number.isFinite(quantity)) throw new HttpError('Stock API response has no numeric quantity');
          // Only call it "in stock" when both fields agree (in_stock may be absent).
          const inStock = quantity > 0 && body.in_stock !== false;
          return { ...body, sku, quantity, inStock };
        } catch (e) {
          lastErr = e;
          if (e.retryable === false) break;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
        }
      }
      throw lastErr;
    },

    // Cached product info for the form, emails and admin. Never blocks on failure.
    async product(sku) {
      if (Date.now() - catalog.at > 10 * 60_000) {
        try {
          const { res, body } = await request(url, { headers });
          const list = res.ok && body && Array.isArray(body.products) ? body.products : null;
          if (list) catalog = { at: Date.now(), bySku: new Map(list.map((p) => [String(p.sku).toUpperCase(), p])) };
          else catalog.at = Date.now() - 9 * 60_000; // retry in a minute
        } catch { catalog.at = Date.now() - 9 * 60_000; }
      }
      return catalog.bySku.get(String(sku).toUpperCase()) || null;
    },
    catalogList: () => [...catalog.bySku.values()],
  };
}

function makeMailer({ baseUrl, key, from }) {
  return {
    // Resend's API format. The idempotency key makes retries safe: if a send
    // succeeded but we crashed before recording it, the retry is deduplicated.
    async send({ to, subject, html, text, idempotencyKey }) {
      const { res, body, text: raw } = await request(`${baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });
      if (res.ok) {
        if (!body || !body.id) throw new HttpError('Email API returned success without an id');
        return body.id;
      }
      const msg = (body && body.message) || raw.slice(0, 200) || 'no body';
      // 400/422: the email itself is invalid, retrying won't help.
      // Everything else (401 config, 409 idempotency in flight, 429, 5xx) is retried.
      const permanent = res.status === 400 || res.status === 422;
      throw new HttpError(`Email API HTTP ${res.status}: ${msg}`, { status: res.status, retryable: !permanent });
    },
  };
}

module.exports = { makeStockClient, makeMailer, HttpError };
