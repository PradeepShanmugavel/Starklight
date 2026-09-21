'use strict';
// ---------------------------------------------------------------------------
// Topic Alignment report history.
//
// Backed by Postgres, addressed purely through DATABASE_URL — so Neon, Render
// Postgres, Supabase or a local server are all interchangeable with no code
// change. Pick whichever is free/convenient and paste the connection string.
//
// DEGRADES CLEANLY: with no DATABASE_URL the app still runs, history is
// simply unavailable and every endpoint says so. That matters because the
// other two sections don't need a database at all, and a missing one must
// never take the whole tool down.
// ---------------------------------------------------------------------------
const { Pool } = require('pg');

let pool = null;
let initPromise = null;
let lastError = null;

function isEnabled() {
  return !!process.env.DATABASE_URL;
}

function getPool() {
  if (!isEnabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Hosted Postgres (Neon, Render, Supabase) requires TLS but presents a
      // cert this client has no CA for. Local servers usually have no TLS at
      // all, hence the opt-out.
      ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
      max: 3,                      // free tiers cap connections tightly
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', err => { lastError = err.message; });
  }
  return pool;
}

// Created on first use rather than at boot, so a database that's temporarily
// unreachable doesn't stop the server from starting.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS topic_reports (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_label TEXT        NOT NULL,
  source_kind  TEXT,
  scope        TEXT,
  total        INTEGER     NOT NULL DEFAULT 0,
  flagged      INTEGER     NOT NULL DEFAULT 0,
  created_by   TEXT,
  report       JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS topic_reports_created_at_idx ON topic_reports (created_at DESC);
`;

function init() {
  if (!isEnabled()) return Promise.resolve(false);
  if (!initPromise) {
    initPromise = getPool().query(SCHEMA)
      .then(() => { lastError = null; return true; })
      .catch(err => {
        lastError = err.message;
        initPromise = null; // let the next call retry rather than failing forever
        throw err;
      });
  }
  return initPromise;
}

async function saveReport({ sourceLabel, sourceKind, scope, total, flagged, createdBy, report }) {
  await init();
  const { rows } = await getPool().query(
    `INSERT INTO topic_reports (source_label, source_kind, scope, total, flagged, created_by, report)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      String(sourceLabel || 'Untitled'),
      sourceKind || null,
      scope || null,
      Number(total) || 0,
      Number(flagged) || 0,
      createdBy || null,
      JSON.stringify(report ?? {})
    ]
  );
  return rows[0];
}

// The list view deliberately does NOT select `report` — those payloads are
// large and the history table only needs the summary columns.
async function listReports({ limit = 50, offset = 0 } = {}) {
  await init();
  const { rows } = await getPool().query(
    `SELECT id, created_at, source_label, source_kind, scope, total, flagged, created_by
       FROM topic_reports
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    [Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0)]
  );
  return rows;
}

async function getReport(id) {
  await init();
  const { rows } = await getPool().query(
    `SELECT id, created_at, source_label, source_kind, scope, total, flagged, created_by, report
       FROM topic_reports WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function deleteReport(id) {
  await init();
  const { rowCount } = await getPool().query(`DELETE FROM topic_reports WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function status() {
  if (!isEnabled()) {
    return { enabled: false, connected: false, error: 'DATABASE_URL is not set — report history is disabled.' };
  }
  try {
    await init();
    const { rows } = await getPool().query('SELECT COUNT(*)::int AS n FROM topic_reports');
    return { enabled: true, connected: true, count: rows[0].n, error: null };
  } catch (err) {
    return { enabled: true, connected: false, count: 0, error: err.message };
  }
}

module.exports = { isEnabled, init, saveReport, listReports, getReport, deleteReport, status, get lastError() { return lastError; } };
