'use strict';

const { renderEmail } = require('./views');

// Backoff for failed sends: 15s, 1m, 4m, 16m, then hourly. Never gives up on
// a retryable error, because "zero emails" is a failure too.
function backoffMs(attempts) {
  return Math.min(15_000 * 4 ** Math.max(0, attempts - 1), 60 * 60_000);
}

function makeNotifier({ store, stock, mailer, config, log = console }) {
  const running = new Map(); // sku -> { promise, again }
  const inFlight = new Set();
  let timer = null;
  let stopping = false;

  // `owed`: a confirmed restock claimed this request, so it gets its email even
  // if the product sells out again before a retry lands.
  async function sendOne(id, product) {
    if (!store.claim(id, { owed: true })) return 'skipped'; // someone else has it, or it's done
    const req = store.getRequest(id);
    try {
      const email = renderEmail({ request: req, product, config });
      const emailId = await mailer.send({
        to: req.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        idempotencyKey: `back-in-stock-request-${req.id}`,
      });
      store.markNotified(id, emailId);
      return 'sent';
    } catch (e) {
      if (e.retryable === false) {
        store.markFailed(id, e.message);
        log.warn(`request ${id}: permanent failure: ${e.message}`);
        return 'failed';
      }
      const retryAt = new Date(store.nowMs() + backoffMs(req.attempts)).toISOString();
      store.markRetry(id, e.message, retryAt);
      log.warn(`request ${id}: send failed, retrying at ${retryAt}: ${e.message}`);
      return 'retry';
    }
  }

  async function sendAll(ids, info) {
    const results = { sent: 0, retry: 0, failed: 0, skipped: 0 };
    const queue = [...ids];
    const worker = async () => {
      while (queue.length && !stopping) {
        const id = queue.shift();
        const p = sendOne(id, typeof info === 'function' ? await info(id) : info);
        inFlight.add(p);
        try { results[await p]++; } finally { inFlight.delete(p); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    return results;
  }

  async function runSku(sku) {
    const ids = store.dueIdsForSku(sku);
    if (!ids.length) return 'no waiting requests';

    // Never trust the webhook: the stock API decides.
    let product;
    try {
      product = await stock.check(sku);
    } catch (e) {
      log.warn(`${sku}: stock check failed, will retry on the next sweep: ${e.message}`);
      return `stock check failed (${e.message}); retry on next sweep`;
    }
    if (!product.inStock) return `stock API says ${product.quantity}; nobody emailed`;

    const info = { ...(await stock.product(sku).catch(() => null)), ...product };
    const results = await sendAll(ids, info);
    log.info(`${sku}: in stock (${product.quantity}); sent ${results.sent}, retry ${results.retry}, failed ${results.failed}`);
    return `in stock (${product.quantity}): sent ${results.sent}` +
      (results.retry ? `, ${results.retry} to retry` : '') + (results.failed ? `, ${results.failed} failed` : '');
  }

  // One run per SKU at a time. A trigger during a run queues exactly one re-run.
  function processSku(sku) {
    const cur = running.get(sku);
    if (cur) { cur.again = true; return cur.promise; }
    const entry = { again: false, promise: null };
    entry.promise = (async () => {
      let outcome;
      try {
        do { entry.again = false; outcome = await runSku(sku); } while (entry.again && !stopping);
      } finally { running.delete(sku); }
      return outcome;
    })();
    running.set(sku, entry);
    return entry.promise;
  }

  // Safety net for lost webhooks, failed stock checks and failed sends.
  // Owed retries go first and skip the stock check: their restock was confirmed.
  async function sweep() {
    const owed = store.dueOwedIds();
    if (owed.length) {
      // No stock count: the cached catalogue's quantity may be stale, and the item may have sold out again.
      await sendAll(owed, async (id) => ({ ...(await stock.product(store.getRequest(id).sku).catch(() => null)), quantity: undefined }));
    }
    for (const sku of store.skusWithWaiting()) {
      if (stopping) break;
      await processSku(sku).catch((e) => log.error(`sweep ${sku}: ${e.message}`));
    }
  }

  return {
    processSku,
    sweep,
    start() {
      const released = store.releaseStuck();
      if (released) log.warn(`Released ${released} request(s) interrupted mid-send; they retry with the same idempotency key.`);
      const tick = () => { timer = setTimeout(async () => { await sweep().catch(() => {}); if (!stopping) tick(); }, config.sweepSeconds * 1000); };
      setTimeout(() => sweep().catch(() => {}), config.bootSweepMs ?? 2000);
      tick();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, 10_000))]);
    },
  };
}

module.exports = { makeNotifier, backoffMs };
