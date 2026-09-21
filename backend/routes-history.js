'use strict';
// ---------------------------------------------------------------------------
// Topic Alignment report history — save, list, re-download, delete.
//
// Every completed Topic Alignment run is stored so a report can be pulled
// back and re-exported later without re-running the analysis (which costs AI
// calls and several minutes).
//
// A 503 here means "no database configured", which is a setup state rather
// than a fault — the client shows the history panel as unavailable and the
// rest of the app carries on.
// ---------------------------------------------------------------------------
const express = require('express');
const db = require('./db');

const router = express.Router();

function requireDb(_req, res, next) {
  if (!db.isEnabled()) {
    return res.status(503).json({
      ok: false,
      enabled: false,
      error: 'Report history is not configured. Set DATABASE_URL to enable it.'
    });
  }
  next();
}

// GET /api/history/status — whether history is available at all. Called on
// page load so the UI can hide or explain the panel rather than erroring.
router.get('/history/status', async (_req, res) => {
  res.json({ ok: true, ...(await db.status()) });
});

// POST /api/history/topic-reports — store one completed run.
router.post('/history/topic-reports', requireDb, async (req, res) => {
  try {
    const { sourceLabel, sourceKind, scope, total, flagged, createdBy, report } = req.body || {};
    if (!report) return res.status(400).json({ ok: false, error: '"report" is required' });
    const saved = await db.saveReport({ sourceLabel, sourceKind, scope, total, flagged, createdBy, report });
    res.json({ ok: true, id: saved.id, created_at: saved.created_at });
  } catch (err) {
    console.error('[HISTORY] save failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not save the report: ' + err.message });
  }
});

// GET /api/history/topic-reports — summaries only, newest first.
router.get('/history/topic-reports', requireDb, async (req, res) => {
  try {
    const rows = await db.listReports({ limit: req.query.limit, offset: req.query.offset });
    res.json({ ok: true, reports: rows });
  } catch (err) {
    console.error('[HISTORY] list failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load history: ' + err.message });
  }
});

// GET /api/history/topic-reports/:id — the full stored report, for re-export.
router.get('/history/topic-reports/:id', requireDb, async (req, res) => {
  try {
    const row = await db.getReport(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'No report with that id.' });
    res.json({ ok: true, report: row });
  } catch (err) {
    console.error('[HISTORY] fetch failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load that report: ' + err.message });
  }
});

router.delete('/history/topic-reports/:id', requireDb, async (req, res) => {
  try {
    const gone = await db.deleteReport(req.params.id);
    if (!gone) return res.status(404).json({ ok: false, error: 'No report with that id.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[HISTORY] delete failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not delete that report: ' + err.message });
  }
});

module.exports = router;
