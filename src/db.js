'use strict';

// SQLite via Node's built-in driver: no native modules, survives restarts,
// and every statement is atomic. All writes happen on the one Node thread,
// so a conditional UPDATE is a safe "claim".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function openDb(dataDir) {
  const file = dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'alerts.db');
  if (file !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT NOT NULL,
      sku             TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'waiting',  -- waiting | sending | notified | failed
      source_url      TEXT,
      created_at      TEXT NOT NULL,
      notified_at     TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error      TEXT,
      email_id        TEXT
    );
    -- At most one open request per customer per product.
    CREATE UNIQUE INDEX IF NOT EXISTS requests_one_open
      ON requests (email, sku) WHERE status IN ('waiting', 'sending');
    CREATE INDEX IF NOT EXISTS requests_by_sku ON requests (sku, status);

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id     TEXT PRIMARY KEY,
      sku          TEXT NOT NULL,
      quantity     INTEGER,
      received_at  TEXT NOT NULL,
      deliveries   INTEGER NOT NULL DEFAULT 1,
      outcome      TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

const now = () => new Date().toISOString();

function makeStore(db) {
  const s = {
    insertRequest: db.prepare(
      `INSERT INTO requests (email, sku, source_url, created_at) VALUES (?, ?, ?, ?)`),
    findOpen: db.prepare(
      `SELECT * FROM requests WHERE email = ? AND sku = ? AND status IN ('waiting','sending')`),
    getRequest: db.prepare(`SELECT * FROM requests WHERE id = ?`),
    dueForSku: db.prepare(
      `SELECT id FROM requests WHERE sku = ? AND status = 'waiting'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id`),
    skusWaiting: db.prepare(
      `SELECT DISTINCT sku FROM requests WHERE status = 'waiting'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`),
    claim: db.prepare(
      `UPDATE requests SET status = 'sending', attempts = attempts + 1
         WHERE id = ? AND status = 'waiting'`),
    markNotified: db.prepare(
      `UPDATE requests SET status = 'notified', notified_at = ?, email_id = ?, last_error = NULL
         WHERE id = ? AND status = 'sending'`),
    markRetry: db.prepare(
      `UPDATE requests SET status = 'waiting', last_error = ?, next_attempt_at = ?
         WHERE id = ? AND status = 'sending'`),
    markFailed: db.prepare(
      `UPDATE requests SET status = 'failed', last_error = ? WHERE id = ? AND status = 'sending'`),
    releaseStuck: db.prepare(
      `UPDATE requests SET status = 'waiting', last_error = 'Interrupted mid-send; retrying (same idempotency key)'
         WHERE status = 'sending'`),
    insertEvent: db.prepare(
      `INSERT INTO webhook_events (event_id, sku, quantity, received_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`),
    bumpEvent: db.prepare(`UPDATE webhook_events SET deliveries = deliveries + 1 WHERE event_id = ?`),
    setOutcome: db.prepare(`UPDATE webhook_events SET outcome = ? WHERE event_id = ?`),
    getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    putSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`),
  };

  return {
    db,
    now,

    // Returns { request, created }. A second request for the same open
    // (email, sku) pair returns the existing one instead of a duplicate.
    createRequest(email, sku, sourceUrl) {
      const existing = s.findOpen.get(email, sku);
      if (existing) return { request: existing, created: false };
      try {
        const r = s.insertRequest.run(email, sku, sourceUrl || null, now());
        return { request: s.getRequest.get(r.lastInsertRowid), created: true };
      } catch (e) {
        // Unique index is the backstop if two inserts ever race.
        if (/UNIQUE/i.test(String(e.message))) return { request: s.findOpen.get(email, sku), created: false };
        throw e;
      }
    },
    getRequest: (id) => s.getRequest.get(id),
    dueIdsForSku: (sku) => s.dueForSku.all(sku, now()).map((r) => r.id),
    skusWithWaiting: () => s.skusWaiting.all(now()).map((r) => r.sku),

    // The exactly-once gate: only one caller can move a request from
    // waiting to sending.
    claim: (id) => s.claim.run(id).changes === 1,
    markNotified: (id, emailId) => s.markNotified.run(now(), emailId || null, id),
    markRetry: (id, error, retryAt) => s.markRetry.run(String(error).slice(0, 500), retryAt, id),
    markFailed: (id, error) => s.markFailed.run(String(error).slice(0, 500), id),
    releaseStuck: () => s.releaseStuck.run().changes,

    // Returns true the first time an event_id is seen.
    recordEvent(eventId, sku, quantity) {
      const r = s.insertEvent.run(eventId, sku, Number.isFinite(quantity) ? quantity : null, now());
      if (r.changes === 1) return true;
      s.bumpEvent.run(eventId);
      return false;
    },
    setEventOutcome: (eventId, outcome) => s.setOutcome.run(String(outcome).slice(0, 300), eventId),

    // Admin password: ADMIN_PASSWORD if set, otherwise generated once and kept.
    adminPassword(fromEnv) {
      if (fromEnv) return { password: fromEnv, generated: false };
      s.putSetting.run('admin_password', crypto.randomBytes(9).toString('base64url'));
      return { password: s.getSetting.get('admin_password').value, generated: true };
    },

    listRequests({ status, q, limit = 300 } = {}) {
      const where = [];
      const args = [];
      if (status) { where.push('status = ?'); args.push(status); }
      if (q) { where.push('(email LIKE ? OR sku LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
      const sql = `SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY id DESC LIMIT ${Math.min(Number(limit) || 300, 1000)}`;
      return db.prepare(sql).all(...args);
    },
    counts() {
      const out = { waiting: 0, sending: 0, notified: 0, failed: 0 };
      for (const r of db.prepare(`SELECT status, COUNT(*) n FROM requests GROUP BY status`).all()) out[r.status] = r.n;
      return out;
    },
    recentEvents: (limit = 25) =>
      db.prepare(`SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?`).all(limit),
  };
}

module.exports = { openDb, makeStore };
