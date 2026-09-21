'use strict';
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const BASE = process.env.EXAMLY_BASE_URL || 'https://api.examly.io';
const SCHOOL_ID = process.env.SCHOOL_ID || '';

// Cache + in-flight dedup for the expensive test-name -> questions
// resolution pipeline below (GET /tests/:name/questions). CONFIRMED live:
// nothing here stopped the same search from being fired multiple times
// concurrently (e.g. a held-down Enter key, or a second click before the
// button's disabled state re-rendered) — each duplicate independently
// re-ran the WHOLE cascade (fast path, tag path, content-library scan,
// full scan), multiplying load against Examly's API (their own 429s,
// visible as "scan of QB X failed -> 429" in logs) and against this
// process's own limited memory, which is what tipped a free-tier
// container into an OOM restart. Also solves a separate, previously-
// raised complaint: re-searching the SAME already-resolved test redid
// the entire pipeline from scratch instead of reusing the result.
var TEST_RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — long enough to skip a quick re-search, short enough not to serve stale data for long
var testResolveCache = new Map();   // normalised name -> { status, payload, expiresAt }
var testResolveInFlight = new Map(); // normalised name -> Promise<{ status, payload }>

// Built-in default department UUIDs (from the live portal request payload).
// Override by creating server/departments.json or setting DEPARTMENT_IDS in .env.
const DEFAULT_DEPARTMENT_IDS = [
  "df128e4a-e75e-426e-9d59-bff816f08a72","988be022-e14d-4662-99c0-8bef716fc826",
  "a6d5352b-4eba-4eab-9d42-53be25022198","09abbbe9-f2f3-4503-aa43-f0785059b0d2",
  "6610561a-f5b2-433c-8dcd-5902a1f71dc8","efa47177-57a4-4b22-9414-d4982a59a3a1",
  "b436748f-f22a-41bb-a760-ae12d76b74a4","59283fa5-e3c5-43d9-9249-c608ce678da0",
  "a2be84c8-7478-465e-b6d0-ce866779fc91","bf7c065e-8d55-4bed-8acb-af1a95921c57",
  "65dea691-1760-44b9-8fa5-d2250d42493b","dd364bb3-7c10-4241-9557-80e002b0001a",
  "19f0d0ea-714e-4de4-b1e8-527e79620893","531a1b18-362d-4868-a3c7-8d40358afed9",
  "e999c4b1-bfe3-4369-b2bf-5ef3458efe94","c5dd9953-15fd-45bb-bec8-f252bf2a89d2",
  "01b622fd-a74c-49f0-ae35-66bfb6eef5ab","69605d3b-2b06-4da6-8836-ab59ce6844f3",
  "b1909585-e394-414e-b5bd-25101ab81c84","955329cb-2d14-4ca4-b665-b1a2a0d5d000",
  "02aaaf75-d6ed-422e-a3e3-bf1889c1b9ae","3151c244-771f-41db-9443-486bde24442c",
  "a6e2f79e-4ff9-4511-a5b8-af62afb2c02e","3ae4ebd3-70bb-4a55-8a42-f7e655fe2e2f",
  "7ac25507-e0b0-473b-a06f-d6093f1f2e41","c1606ab4-a275-4108-b603-208742aeda77",
  "28ab722d-201b-4ae8-a2a6-fe690b13572f","45ac9dcd-9586-4f0a-a48a-6d23f6a7792a",
  "c799f089-a321-47e5-8c24-dcf3dbda2e31","6ab5f6f2-d474-4d75-b3f2-2cde376b9227",
  "c80b12a2-cccb-4040-86e3-9801ab28d422","132c6552-4768-42db-b46f-db52a5ea0cf4",
  "2d85cfc2-5760-4588-b581-50d4f88b17bd","a0dbfb8e-fdf4-4181-a03e-a63e743b6844",
  "b7372175-e687-4dd0-a3fb-09dfbb962a3e"
];

// Department UUIDs: try departments.json (several locations), then DEPARTMENT_IDS
// in .env, then the built-in default above. Always ends up non-empty.
function loadDepartmentIds() {
  var candidates = [
    path.join(__dirname, '..', 'departments.json'),  // server/departments.json
    path.join(__dirname, 'departments.json'),         // server/routes/departments.json
    path.join(process.cwd(), 'departments.json'),     // wherever you launched node
    path.join(process.cwd(), 'server', 'departments.json')
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) {
        var arr = JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
        if (Array.isArray(arr) && arr.length) {
          console.log('[EXAMLY] Departments from file: ' + candidates[i]);
          return arr.map(function(s){ return String(s).trim(); }).filter(Boolean);
        }
      }
    } catch (e) {
      console.error('[EXAMLY] Bad departments.json at ' + candidates[i] + ': ' + e.message);
    }
  }
  var fromEnv = (process.env.DEPARTMENT_IDS || '').split(',')
    .map(function(s){ return s.trim(); })
    .filter(function(s){ return s && s.indexOf('...') === -1; });   // ignore placeholder
  if (fromEnv.length >= 5) {
    console.log('[EXAMLY] Departments from .env DEPARTMENT_IDS');
    return fromEnv;
  }
  console.log('[EXAMLY] Departments from built-in default');
  return DEFAULT_DEPARTMENT_IDS;
}
const DEPARTMENT_IDS = loadDepartmentIds();
console.log('[EXAMLY] Loaded ' + DEPARTMENT_IDS.length + ' department id(s)');

// Default test placement (branch+department) — from the live create-test request.
// Override per-request by sending b_d_id in the body.
const DEFAULT_BD_ID = [
  { label: 'Neo Stark - admin', value: 'df128e4a-e75e-426e-9d59-bff816f08a72',
    branch_id: 'c0d504a1-de25-4a16-a5cf-ce1fd60940de', department_id: 'df128e4a-e75e-426e-9d59-bff816f08a72' },
  { label: 'University - admin', value: '988be022-e14d-4662-99c0-8bef716fc826',
    branch_id: 'd244736d-e58a-4597-a7e0-7f9952de3e66', department_id: '988be022-e14d-4662-99c0-8bef716fc826' }
];

function getToken(req) {
  var token = req.headers['x-auth-token'];
  if (!token) throw new Error('x-auth-token header is required');
  return token;
}

// Pull the display name (and other claims) out of the raw JWT, no verification.
function decodeJwt(token) {
  try {
    var parts = String(token).split('.');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) { return {}; }
}

function headers(token) {
  // Examly/iamneo expects the RAW JWT in Authorization (no "Bearer " prefix).
  var h = { Authorization: token, 'Content-Type': 'application/json' };
  if (SCHOOL_ID) h['school-id'] = SCHOOL_ID;
  return h;
}

// Transient network errors worth retrying — CONFIRMED live: ECONNABORTED
// (axios's own request-timeout code, fired when Examly itself doesn't
// respond within our 25s timeout) does NOT belong here. Retrying a timeout
// with the SAME 25s timeout compounded into 5 x 25s = 125+ seconds of
// silent waiting before finally failing on one slow/hanging Examly search —
// if it didn't respond in 25s once, another attempt at the identical
// timeout essentially never helps, it just multiplies the wait for nothing.
// The other codes here are genuine fast-failing connection blips (a reset,
// DNS hiccup, etc.) where a quick retry can actually help.
function isTransient(e) {
  var c = e && e.code;
  return c === 'ECONNRESET' || c === 'ETIMEDOUT' || c === 'ENOTFOUND' ||
         c === 'EAI_AGAIN' ||
         (e && /socket hang up/i.test(e.message || ''));
}

var REQ_RETRY_DEFAULT_TRIES = 5;

function reqRetry(cfg, tries) {
  tries = tries || REQ_RETRY_DEFAULT_TRIES;
  return axios(cfg).catch(function(e) {
    var status = e.response && e.response.status;
    // 429s are common now that bulk QB scanning (auto-QB resolution) can fire
    // many requests in quick succession — CONFIRMED live: scanning 200 QBs at
    // concurrency 5 got almost every request 429'd, since the old retry logic
    // only covered network-level errors, never HTTP status codes. Back off
    // (increasing each attempt) and retry, honoring Retry-After when the
    // portal sends one.
    if (tries > 1 && status === 429) {
      var retryAfterHeader = Number(e.response.headers && e.response.headers['retry-after']);
      var attemptNum = REQ_RETRY_DEFAULT_TRIES - tries + 1;
      var delayMs = retryAfterHeader > 0 ? retryAfterHeader * 1000 : 1000 * attemptNum;
      return new Promise(function(r) { setTimeout(r, delayMs); }).then(function() {
        return reqRetry(cfg, tries - 1);
      });
    }
    if (tries > 1 && isTransient(e)) {
      return new Promise(function(r) { setTimeout(r, 700); }).then(function() {
        return reqRetry(cfg, tries - 1);
      });
    }
    throw e;
  });
}

function epost(path, body, token) {
  return reqRetry({ method: 'post', url: BASE + path, data: body, headers: headers(token), timeout: 25000 });
}
function eput(path, body, token) {
  return reqRetry({ method: 'put', url: BASE + path, data: body, headers: headers(token), timeout: 25000 });
}
function eget(path, token) {
  return reqRetry({ method: 'get', url: BASE + path, headers: headers(token), timeout: 25000 });
}

// Fields Examly requires on every questionbank payload (matches the live request).
// Shared by both name-matching routes (QB name and test name) so a stray
// double space, underscore run, or leading/trailing whitespace/newline in
// either the search box or the portal's own stored name doesn't cause an
// otherwise-correct name to miss an exact match.
function normName(s) { return (s || '').toLowerCase().replace(/[_\s]+/g, ' ').trim(); }

function baseBody(extra) {
  var b = {
    branch_id: 'all',
    department_id: DEPARTMENT_IDS,
    mainDepartmentUser: true
  };
  return Object.assign(b, extra || {});
}

// Pull the QB array out of whatever shape the API returns, then alias fields
// to id/name so the frontend (which looks for id/name) can read them.
function normalise(raw) {
  var arr = extractArray(raw);
  return arr.map(function(qb) {
    var id   = qb.qb_id || qb.id || qb._id || qb.questionBankId || qb.questionbank_id;
    var name = qb.qb_name || qb.name || qb.title || qb.questionBankName || '';
    return Object.assign({}, qb, {
      id: id,
      name: typeof name === 'string' ? name.trim() : name,
      code: qb.qb_code || qb.code || null,
      questionCount: qb.questionCount != null ? qb.questionCount : (qb.question_count || 0)
    });
  });
}

function extractArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && raw.results) {
    var r = raw.results;
    if (Array.isArray(r)) return r;
    if (Array.isArray(r.questionbanks)) return r.questionbanks;
    if (Array.isArray(r.questions)) return r.questions;
    if (Array.isArray(r.data)) return r.data;
    if (Array.isArray(r.questionfilter)) return r.questionfilter;
  }
  var keys = ['questionbanks','questionfilter','questionData','questionBankData','questionBanks','questions','data','result'];
  for (var i = 0; i < keys.length; i++) {
    if (raw && Array.isArray(raw[keys[i]])) return raw[keys[i]];
  }
  return [];
}

// ── Question parsing (questionfilter response) ───────────────────────────────
function stripHtml(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function questionCategory(t) {
  t = (t || '').toLowerCase();
  if (t.indexOf('mcq') !== -1 || t.indexOf('multiple') !== -1 || t.indexOf('fillup') !== -1) return 'MCQ';
  if (t.indexOf('debug') !== -1) return 'DEBUG';
  if (t.indexOf('program') !== -1 || t.indexOf('coding') !== -1 || t.indexOf('code') !== -1) return 'COD';
  return 'MCQ';
}

// Decide MCQ / COD / DEBUG primarily from the question_type string.
// Examly types seen: mcq_single_correct, mcq_multiple_correct -> MCQ;
// programming, programming_file_based -> COD; *debug* -> DEBUG.
function categoryOf(q) {
  var t = (q.question_type || '').toLowerCase();
  if (t.indexOf('debug') !== -1) return 'DEBUG';
  if (t.indexOf('mcq') !== -1 || t.indexOf('fillup') !== -1 || t.indexOf('comprehension') !== -1) return 'MCQ';
  if (t.indexOf('program') !== -1 || t.indexOf('coding') !== -1 || t.indexOf('code') !== -1) return 'COD';
  // structural fallback when type string is unknown
  if (q.mcq_questions || q.fillup_questions) return 'MCQ';
  if (q.programming_question || q.block_programming) return 'COD';
  return 'MCQ';
}

// Remember qb_id -> qb_name during search, so the questions route can classify
// by the BANK NAME (your convention: name contains MCQ / COD / DEBUG).
var qbNameById = {};

function typeFromName(name) {
  var n = (name || '').toUpperCase();
  if (n.indexOf('DEBUG') !== -1) return 'DEBUG';
  if (n.indexOf('COD') !== -1 || n.indexOf('CODING') !== -1) return 'COD';
  if (n.indexOf('MCQ') !== -1) return 'MCQ';
  return null;
}

// Regex fallback for questions with NO structured solution object (e.g. an
// MCQ whose code lives inline in question_data's HTML, no programming_question
// at all). Order matters — check the most distinguishing signals first.
function detectLanguage(text) {
  var t = String(text || '');
  if (!t.trim()) return null;

  if (/\bpublic\s+class\b|\bSystem\.out\.print(ln)?\s*\(|\bpublic\s+static\s+void\s+main\b/.test(t)) return 'Java';
  if (/#include\s*<iostream>|\bstd::|\bcout\s*<<|\bcin\s*>>|\busing\s+namespace\s+std\b/.test(t)) return 'C++';
  if (/\bdef\s+\w+\s*\(.*\)\s*:|\bprint\s*\(|\belif\b|\bself\.\w+|\b__init__\b/.test(t)) return 'Python';
  if (/#include\s*<stdio\.h>|\bprintf\s*\(|\bscanf\s*\(|\bint\s+main\s*\(/.test(t)) return 'C';

  if (/\bjava\b/i.test(t)) return 'Java';
  if (/\bc\+\+|\bcpp\b/i.test(t)) return 'C++';
  if (/\bpython\b/i.test(t)) return 'Python';
  if (/\bc\s+program|\bin\s+c\b|\bc\s+language\b/i.test(t)) return 'C';
  return null;
}

// Examly's own per-solution language codes, mapped to our 4-language set.
function normaliseLanguage(code) {
  var c = String(code || '').toLowerCase();
  if (!c) return null;
  if (c.indexOf('java') !== -1) return 'Java';
  if (c.indexOf('py') !== -1) return 'Python';
  if (c.indexOf('cpp') !== -1 || c.indexOf('c++') !== -1) return 'C++';
  if (c === 'c' || c.indexOf('gcc') !== -1) return 'C';
  return code || null;
}

// Real shape (confirmed against a live questionfilter response):
// q.programming_question.solution: [{ language, solutiondata: [{ solution }] }]
function extractSolution(q) {
  var pq = q.programming_question;
  if (!pq || !Array.isArray(pq.solution)) return { code: '', language: null };
  var parts = [];
  var language = null;
  pq.solution.forEach(function(sol) {
    if (Array.isArray(sol.solutiondata)) {
      sol.solutiondata.forEach(function(sd) {
        if (sd.solution) {
          parts.push(sd.solution);
          if (!language) language = normaliseLanguage(sol.language);
        }
      });
    }
  });
  return { code: parts.join('\n\n'), language: language };
}

// Real shape: q.tags: [{ name }] — not the guessed field names from before.
function extractPortalTags(q) {
  if (!Array.isArray(q.tags)) return [];
  return q.tags.map(function(t) { return t && t.name; }).filter(Boolean);
}

// Sample I/O + hidden test cases, for the QC prompt's "constraints" context.
function extractConstraintsBlock(q) {
  var pq = q.programming_question;
  if (!pq) return '';
  var parts = [];
  if (pq.sample_io) {
    try {
      var samples = JSON.parse(pq.sample_io);
      parts.push('Sample I/O:\n' + samples.map(function(s) {
        return 'Input: ' + s.input + '\nOutput: ' + s.output;
      }).join('\n---\n'));
    } catch (e) { parts.push('Sample I/O (raw): ' + pq.sample_io); }
  }
  if (pq.testcases) {
    try {
      var tcs = JSON.parse(pq.testcases);
      parts.push('Hidden Test Cases (' + tcs.length + '):\n' + tcs.map(function(t, i) {
        return '#' + (i + 1) + ' [' + (t.difficulty || '-') + ', score ' + (t.score || '-') + ']\nInput: ' + t.input + '\nOutput: ' + t.output;
      }).join('\n---\n'));
    } catch (e) { parts.push('Test cases (raw): ' + pq.testcases); }
  }
  return parts.join('\n\n');
}

function mapQuestion(q, forcedType) {
  var promptRaw = String(q.question_data || '').split('$$$examly')[0];
  var title = stripHtml(promptRaw).slice(0, 240) || '(no text)';
  var opts = [];
  try {
    if (q.mcq_questions && q.mcq_questions.options) {
      opts = JSON.parse(q.mcq_questions.options).map(function(o) { return stripHtml(o.text); });
    }
  } catch (e) {}
  var cat = forcedType || categoryOf(q);
  // "Quality rating" (if the portal has one) is a distinct field from
  // manual_difficulty — try common names, keep both separate downstream.
  var rating = q.rating != null ? q.rating : (q.quality_rating != null ? q.quality_rating : null);

  var solved = extractSolution(q);
  // Prefer the solution's own declared language; only fall back to regex
  // sniffing when there's no structured solution to read from at all.
  var language = solved.language || detectLanguage(solved.code) || detectLanguage(promptRaw);

  return Object.assign({}, q, {
    id: q.q_id || q.question_id || q.id,
    // Stamp the clean category into EVERY field the frontend might read,
    // so it can't re-derive MCQ from the raw "programming" string.
    type: cat,
    questionType: cat,
    category: cat,
    rawQuestionType: q.question_type,
    title: title,
    options: opts,
    difficulty: q.manual_difficulty || q.automatic_difficulty || null,
    rating: rating,
    language: language,
    portalTags: extractPortalTags(q),
    solution: solved.code,
    inputFormat: stripHtml((q.programming_question && q.programming_question.input_format) || ''),
    outputFormat: stripHtml((q.programming_question && q.programming_question.output_format) || ''),
    constraintsBlock: extractConstraintsBlock(q),
    multilanguage: (q.programming_question && q.programming_question.multilanguage) || null,
    subject: (q.subject && q.subject.name) || null,
    topicName: (q.topic && q.topic.name) || null,
    subTopic: (q.sub_topic && q.sub_topic.name) || null
  });
}

function handleErr(err, res) {
  var status = (err.response && err.response.status) || 500;
  var detail = (err.response && err.response.data) || null;
  console.error('[EXAMLY ' + status + ']', err.message);
  if (detail) console.error('[EXAMLY detail]', JSON.stringify(detail));
  res.status(status).json({ error: err.message, detail: detail });
}

// GET /api/examly/questionbanks
router.get('/questionbanks', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  // The portal's own validation rejects an empty "search" key outright
  // ("search is not allowed to be empty") — omit it entirely rather than
  // sending '', instead of treating blank as "no filter".
  var extra = {
    page: parseInt(req.query.page) || 1,
    limit: parseInt(req.query.limit) || 100,
    visibility: 'All'
  };
  if (req.query.search) extra.search = req.query.search;
  var body = baseBody(extra);

  console.log('[EXAMLY] POST /api/v2/questionbanks', JSON.stringify(body));

  epost('/api/v2/questionbanks', body, token)
    .then(function(response) {
      var raw = response.data;
      var data = normalise(raw);
      var total = (raw.results && raw.results.count) || raw.total || data.length;
      console.log('[EXAMLY] ✓ questionbanks returned ' + data.length + ' QBs (total: ' + total + ')');
      res.json({ success: true, data: data, total: total, raw: raw });
    })
    .catch(function(err) { handleErr(err, res); });
});

// GET /api/examly/questionbanks/search   (?names=a,b,c)
router.get('/questionbanks/search', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var raw = req.query.names || req.query.topics || '';
  var terms = raw.split(',').map(function(t) { return t.trim(); }).filter(Boolean);

  if (terms.length === 0) {
    // No "search: ''" here either — the portal rejects an empty search key.
    var listBody = baseBody({ page: 1, limit: 200, visibility: 'All' });
    return epost('/api/v2/questionbanks', listBody, token)
      .then(function(r) { res.json({ success: true, data: normalise(r.data) }); })
      .catch(function(err) { handleErr(err, res); });
  }

  // Mirror the portal UI: one search request per term using the `search` field.
  var promises = terms.map(function(term) {
    var body = baseBody({ page: 1, limit: 25, visibility: 'All', search: term });
    console.log('[EXAMLY search] term="' + term + '" departments=' + (Array.isArray(body.department_id) ? body.department_id.length : body.department_id));
    return epost('/api/v2/questionbanks', body, token)
      .then(function(r) {
        var hits = normalise(r.data);
        var total = (r.data.results && r.data.results.count);
        console.log('[EXAMLY search] term="' + term + '" -> ' + hits.length + ' hits (portal count: ' + total + ')');
        if (hits.length) console.log('  first hit: name="' + hits[0].name + '" code="' + hits[0].code + '"');
        var nt = normName(term);
        var exact = hits.filter(function(qb) { return normName(qb.name) === nt || normName(qb.code) === nt; });
        var chosen = exact.length ? exact : hits;
        return { term: term, hits: chosen };
      })
      .catch(function(e) {
        console.error('[EXAMLY search] "' + term + '" failed:', (e.response && e.response.status) || e.message);
        if (e.response && e.response.data) console.error('  detail:', JSON.stringify(e.response.data));
        return { term: term, hits: [] };
      });
  });

  Promise.all(promises).then(function(results) {
    var seen = new Set();
    var data = [];
    var missing = [];
    results.forEach(function(r) {
      if (!r.hits.length) { missing.push(r.term); return; }
      r.hits.forEach(function(qb) {
        if (qb.id && !seen.has(qb.id)) { seen.add(qb.id); data.push(qb); qbNameById[qb.id] = qb.name; }
      });
    });
    console.log('[EXAMLY] Search matched ' + (terms.length - missing.length) + '/' + terms.length +
                (missing.length ? ' — missing: ' + missing.join(' | ') : ''));
    res.json({ success: true, data: data, missing: missing });
  });
});

// GET /api/examly/questionbanks/lookup?q=<name>
// Search by ONE QB name and return every hit (unfiltered), so the caller can
// show a picker when several QBs match instead of silently guessing one.
router.get('/questionbanks/lookup', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var term = String(req.query.q || req.query.name || '').trim();
  if (!term) return res.status(400).json({ error: '"q" (QB name) is required' });

  var body = baseBody({ page: 1, limit: 50, visibility: 'All', search: term });
  console.log('[EXAMLY] lookup QB name="' + term + '"');

  epost('/api/v2/questionbanks', body, token)
    .then(function(r) {
      var hits = normalise(r.data);
      hits.forEach(function(qb) { if (qb.id) qbNameById[qb.id] = qb.name; });
      console.log('[EXAMLY] lookup "' + term + '" -> ' + hits.length + ' hit(s)');
      res.json({ success: true, data: hits });
    })
    .catch(function(err) { handleErr(err, res); });
});

// GET /api/examly/questionbanks/:id/report
// Question count + topic + difficulty breakdown for ONE question bank.
router.get('/questionbanks/:id/report', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var id = req.params.id;
  var nameForType = req.query.qbName || qbNameById[id] || '';
  var forcedType = typeFromName(nameForType);
  var body = { qb_id: id, type: 'Single', page: 1, limit: 1000 };

  console.log('[EXAMLY] report qb_id=' + id + (nameForType ? ' name="' + nameForType + '"' : ''));

  epost('/api/v2/questionfilter', body, token)
    .then(function(r) {
      var raw = r.data || {};
      var list = [].concat(raw.non_group_questions || [], raw.group_questions || []);
      var mapped = list.map(function(q) { return mapQuestion(q, forcedType); });

      var byType = { MCQ: 0, COD: 0, DEBUG: 0 };
      var topicCounts = {};
      var difficultyCounts = {};
      var languageCounts = {};
      var unknownLanguageCount = 0;

      mapped.forEach(function(q) {
        byType[q.type] = (byType[q.type] || 0) + 1;

        var topic = q.topicName || 'Uncategorized';
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;

        var diff = q.difficulty || 'Unrated';
        difficultyCounts[diff] = (difficultyCounts[diff] || 0) + 1;

        if (q.language) {
          languageCounts[q.language] = (languageCounts[q.language] || 0) + 1;
        } else {
          unknownLanguageCount++;
        }
      });

      var topics = Object.keys(topicCounts)
        .map(function(name) { return { topic: name, count: topicCounts[name] }; })
        .sort(function(a, b) { return b.count - a.count; });

      var difficulty = Object.keys(difficultyCounts)
        .map(function(level) { return { level: level, count: difficultyCounts[level] }; })
        .sort(function(a, b) { return b.count - a.count; });

      var languages = Object.keys(languageCounts)
        .map(function(name) { return { language: name, count: languageCounts[name] }; })
        .sort(function(a, b) { return b.count - a.count; });

      // Per-question detail — one row per question so the caller can render
      // a full table (topic / language / rating), not just the aggregates above.
      var questionDetails = mapped.map(function(q, i) {
        return {
          n: i + 1,
          id: q.id,
          title: q.title,
          solution: q.solution,
          inputFormat: q.inputFormat,
          outputFormat: q.outputFormat,
          constraintsBlock: q.constraintsBlock,
          type: q.type,
          subject: q.subject || null,
          topic: q.topicName || 'Uncategorized',
          subTopic: q.subTopic || null,
          language: q.language || 'Unknown',
          difficulty: q.difficulty || 'Unrated',
          rating: q.rating != null ? q.rating : null,
          portalTags: q.portalTags || []
        };
      });

      var report = {
        qbId: id,
        qbName: nameForType || null,
        totalQuestions: mapped.length,
        reportedTotal: raw.number_of_questions != null ? raw.number_of_questions : mapped.length,
        byType: byType,
        topicCount: topics.length,
        topics: topics,
        difficulty: difficulty,
        languageCount: languages.length,
        languages: languages,
        unknownLanguageCount: unknownLanguageCount,
        questions: questionDetails
      };

      console.log('[EXAMLY] ✓ report qb_id=' + id + ' total=' + report.totalQuestions +
                  ' topics=' + report.topicCount + ' languages=' + report.languageCount +
                  ' MCQ/COD/DEBUG=' + byType.MCQ + '/' + byType.COD + '/' + byType.DEBUG);
      res.json({ success: true, report: report });
    })
    .catch(function(err) { handleErr(err, res); });
});

// POST /api/examly/questionbanks/create  { name, code?, description? }
// Creates a new (empty) question bank in the portal — for when no existing QB
// covers a topic and new questions need a home.
// Confirmed from the live "Add Question Bank" request: POST /api/questionbank/create
router.post('/questionbanks/create', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var name = String((req.body && (req.body.name || req.body.qb_name)) || '').trim();
  if (!name) return res.status(400).json({ error: '"name" is required' });
  var code = (req.body && (req.body.code || req.body.qb_code)) || null;
  var description = (req.body && (req.body.description || req.body.qb_description)) || null;

  var b_d_id = (req.body && req.body.b_d_id) || DEFAULT_BD_ID;
  var body = {
    qb_name: name,
    qb_code: code,
    qb_description: description,
    tags: [],
    b_d_id: b_d_id,
    departmentChanged: true,
    visibility: req.body.visibility || 'Within Department',
    price: 0,
    mainDepartmentUser: true
  };

  console.log('[EXAMLY] create QB "' + name + '" — POST /api/questionbank/create');

  epost('/api/questionbank/create', body, token)
    .then(function(r) {
      var payload = r.data || {};
      var inner = payload.data || {};
      var created = inner.data || inner;
      var msg = inner.message || payload.message || 'Questionbank Created';
      console.log('[EXAMLY] ✓ ' + msg + ' — "' + name + '"');
      res.json({ success: true, message: msg, data: created });
    })
    .catch(function(err) { handleErr(err, res); });
});

// GET /api/examly/questionbanks/:id/questions
// Real endpoint: POST /api/v2/questionfilter  { qb_id, type:"Single", page, limit }
// Response: { non_group_questions:[...], group_questions:[...], number_of_questions:N }
router.get('/questionbanks/:id/questions', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var id = req.params.id;
  var limit = parseInt(req.query.limit) || 500;
  var body = { qb_id: id, type: 'Single', page: 1, limit: limit };

  // Classify by BANK NAME (your convention). Priority: ?qbName= query,
  // else the name we cached during search, else per-question fallback.
  var nameForType = req.query.qbName || qbNameById[id] || '';
  var forcedType = typeFromName(nameForType);

  console.log('[EXAMLY] questionfilter qb_id=' + id +
              (forcedType ? ' (type ' + forcedType + ' from "' + nameForType + '")' : ''));

  epost('/api/v2/questionfilter', body, token)
    .then(function(r) {
      var raw = r.data || {};
      var list = [].concat(raw.non_group_questions || [], raw.group_questions || []);
      var mapped = list.map(function(q) { return mapQuestion(q, forcedType); });
      console.log('[EXAMLY] ✓ questionfilter returned ' + mapped.length + ' questions for qb ' + id +
                  ' (reported: ' + (raw.number_of_questions != null ? raw.number_of_questions : '?') + ')');
      // Show the raw question_type distribution + how we classified it (diagnostic).
      var dist = {};
      mapped.forEach(function(q) {
        var k = (q.questionType || 'unknown') + ' -> ' + q.type;
        dist[k] = (dist[k] || 0) + 1;
      });
      console.log('[EXAMLY]   types: ' + Object.keys(dist).map(function(k){ return k + ' x' + dist[k]; }).join(', '));
      res.json({ success: true, data: mapped, total: raw.number_of_questions || mapped.length });
    })
    .catch(function(err) { handleErr(err, res); });
});

// POST /api/examly/tests  — create a test the way the portal does.
// Flow: generate a test id, then PUT /api/test/:id with the full body
// (sections + questions[{sectionName, questionList:[q_ids]}]).
//
// Frontend may send: { testName, duration, questionIds:[...], sections:[{sectionName,questionList}], b_d_id, createdBy }
router.post('/tests', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var b = req.body || {};
  var testName = b.testName || b.name || 'Untitled Test';
  var duration = String(b.duration || 20);
  var jwt = decodeJwt(token);
  var createdBy = b.createdBy || jwt.name || jwt.email || 'TestPack';

  // Build sections + questions. Section name = question type (e.g. "mcq", "COD").
  var sections, questions;
  if (Array.isArray(b.sections) && b.sections.length) {
    sections = b.sections.map(function(s) {
      return { name: s.name || s.sectionName || 'mcq', duration: Number(s.duration) || Number(duration) || 20, additionalinfo: null };
    });
    questions = b.sections.map(function(s) {
      return { sectionName: s.name || s.sectionName || 'mcq', questionList: (s.questionList || s.questionIds || []) };
    });
  } else {
    // Flat list: items may be {id,type} objects or plain id strings. Group by type.
    var raw = b.questionIds || b.questionList || (Array.isArray(b.questions) ? b.questions : []);
    var byType = {};
    raw.forEach(function(q) {
      var id = (q && typeof q === 'object') ? (q.id || q.q_id || q.question_id) : q;
      if (!id) return;
      var t = ((q && typeof q === 'object' && (q.type || q.questionType)) || 'mcq');
      t = String(t).toUpperCase() === 'MCQ' ? 'mcq' : String(t).toUpperCase(); // mcq lowercase, COD/DEBUG upper
      (byType[t] = byType[t] || []).push(id);
    });
    var types = Object.keys(byType);
    if (!types.length) types = ['mcq'];
    sections = types.map(function(t) { return { name: t, duration: Number(duration) || 20, additionalinfo: null }; });
    questions = types.map(function(t) { return { sectionName: t, questionList: byType[t] || [] }; });
  }
  var group = questions.map(function(q) { return { sectionName: q.sectionName, groupList: [] }; });

  var b_d_id = b.b_d_id || DEFAULT_BD_ID;
  var testType = b.testType || 'Manual Assessment Test';
  var visibility = b.visibility || 'Within Department';
  var totalQs = questions.reduce(function(n, s) { return n + (s.questionList ? s.questionList.length : 0); }, 0);

  function extractTestId(data) {
    if (!data) return null;
    // Confirmed live shape: {success, message, data: "<uuid>"} — data.data IS the id.
    if (typeof data.data === 'string' && data.data) return data.data;
    return data.t_id || data.id ||
           (data.test && data.test.t_id) ||
           (data.results && (data.results.t_id || data.results.id)) ||
           (data.data && data.data.t_id) || null;
  }
  function extractUpdatedAt(data) {
    if (!data) return null;
    return data.updatedAt || (data.test && data.test.updatedAt) ||
           (data.results && data.results.updatedAt) || null;
  }

  // Step 1: POST /api/test — create the empty test (no sections/questions).
  var createBody = {
    testName: testName,
    testType: testType,
    visibility: visibility,
    publishStatus: 'draft',
    createdBy: createdBy,
    mainDepartmentUser: true,
    b_d_id: b_d_id,
    import: 'original_test',
    oldUpdatedAt: new Date().toISOString()
  };

  console.log('[EXAMLY] create test "' + testName + '" (' + totalQs + ' questions) — POST /api/test');
  var savedId, ts;
  epost('/api/test', createBody, token)
    .then(function(cr) {
      savedId = extractTestId(cr.data) || b.t_id;
      ts = extractUpdatedAt(cr.data) || new Date().toISOString();
      // Diagnostic: show the create response shape so we can locate id/updatedAt.
      try {
        var keys = cr.data && typeof cr.data === 'object' ? Object.keys(cr.data) : [];
        console.log('[EXAMLY] create resp keys=' + JSON.stringify(keys) +
                    ' id=' + savedId + ' updatedAt=' + ts);
        console.log('[EXAMLY] create resp (first 600): ' + JSON.stringify(cr.data).slice(0, 600));
      } catch (e) {}

      // A made-up id would just 500 on the PUT below with no useful error —
      // fail loudly here instead so the real response shape shows up in logs.
      if (!savedId) {
        throw new Error('Could not find the new test\'s id in the create response — see [EXAMLY] create resp log above.');
      }

      // PUT questions directly (sections + questions together) — confirmed
      // against a real "Add Test" -> "Add Questions" -> Save capture:
      // import stays "original_test" throughout, and the portal only shows/
      // uses a test once publishStatus is "published" (not left as "draft").
      var putBody = {
        testName: testName,
        testType: testType,
        tags: [],
        visibility: visibility,
        publishStatus: b.publishStatus || 'published',
        createdBy: createdBy,
        sections: sections,
        questions: questions,
        group: group,
        mainDepartmentUser: true,
        import: 'original_test',
        oldUpdatedAt: ts
      };
      console.log('[EXAMLY] PUT /api/test/' + savedId + ' sections=' +
                  sections.map(function(s){return s.name;}).join(',') + ' Q=' + totalQs);
      return eput('/api/test/' + savedId, putBody, token);
    })
    .then(function(r) {
      console.log('[EXAMLY] ✓ test saved: ' + savedId);
      res.json({ success: true, t_id: savedId, response: r.data });
    })
    .catch(function(err) { handleErr(err, res); });
});

// ── Add-solutions feature: find a test by name, read its questions, push a
// translated solution back per question.

// CONFIRMED impossible: /api/v2/questionfilter requires qb_id no matter what
// (tried 4 different id-list field names alongside it, all 400'd with
// "qb_id is required"), and a QB-independent GET (/api/programming_question/:id)
// exists but is missing several fields the push endpoint needs (subject_id,
// topic_id, sub_topic_id, blooms_taxonomy, manual_difficulty,
// pcm_combination_ids, createdBy, real tags) — using it for push risks
// silently erasing those on the portal.
//
// A test can span questions from several different QBs, so asking the user
// to type "the QB name" doesn't even make sense as a UI concept once a test
// has questions from more than one QB. The fix: derive each question's QB
// automatically instead of asking for it. List every QB the user can see
// (confirmed endpoint, no search term needed), then check each QB's full
// question list (same confirmed, full-metadata pipeline as the QB-name flow)
// for the ids this test needs. Zero QB name input required, and nothing about
// push-required metadata is lost, since it's still the same QB pipeline
// underneath — just resolved automatically instead of asked for.
function mapWithConcurrency(items, limit, fn) {
  var results = [];
  var idx = 0;
  function next() {
    if (idx >= items.length) return Promise.resolve();
    var i = idx++;
    return fn(items[i], i).then(function(r) { results[i] = r; return next(); });
  }
  var workers = [];
  for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(next());
  return Promise.all(workers).then(function() { return results; });
}

// GET /api/examly/tests/:name/questions
// Test-name-ONLY pipeline, QB auto-resolved — see comment above.
router.get('/tests/:name/questions', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var term = String(req.params.name || '').trim();
  if (!term) return res.status(400).json({ error: '"name" is required' });

  var cacheKey = normName(term);

  var cached = testResolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[EXAMLY] auto-QB: serving cached resolution for "' + term + '" (no re-scan)');
    return res.status(cached.status).json(cached.payload);
  }

  var inFlight = testResolveInFlight.get(cacheKey);
  if (inFlight) {
    console.log('[EXAMLY] auto-QB: "' + term + '" already resolving — joining that instead of starting a duplicate scan');
    return inFlight.then(function(r) { res.status(r.status).json(r.payload); })
      .catch(function() { res.status(500).json({ error: 'Resolution failed — try again.' }); });
  }

  var resolveInFlight;
  var inFlightPromise = new Promise(function(resolve) { resolveInFlight = resolve; });
  testResolveInFlight.set(cacheKey, inFlightPromise);
  // Safety net: if something ends this response without ever going through
  // the wrapped res.json below (shouldn't happen — every exit path in this
  // route funnels through res.json/handleErr — but a crash mid-request is
  // still possible), don't let the in-flight entry wedge future searches
  // for this name forever.
  var inFlightTimeout = setTimeout(function() {
    testResolveInFlight.delete(cacheKey);
    resolveInFlight({ status: 500, payload: { error: 'Resolution timed out.' } });
  }, 5 * 60 * 1000);

  var realJson = res.json.bind(res);
  res.json = function(payload) {
    clearTimeout(inFlightTimeout);
    var status = res.statusCode || 200;
    var result = { status: status, payload: payload };
    if (status === 200) {
      // Don't cache errors/not-found — a typo'd search that gets corrected
      // should hit fresh, not a stale 404.
      testResolveCache.set(cacheKey, { status: status, payload: payload, expiresAt: Date.now() + TEST_RESOLVE_CACHE_TTL_MS });
    }
    testResolveInFlight.delete(cacheKey);
    resolveInFlight(result);
    return realJson(payload);
  };

  var searchBody = {
    page: 1, limit: 25, search: term,
    branch_id: 'All', department_id: DEPARTMENT_IDS, mainDepartmentUser: true
  };
  console.log('[EXAMLY] auto-QB: resolving test "' + term + '"');

  epost('/api/v2/tests/filter', searchBody, token)
    .then(function(r) {
      var raw = r.data || {};
      var arr = Array.isArray(raw.data) ? raw.data : [];
      var allMatches = arr.map(function(t) {
        var questionIds = [];
        var sectionNames = [];
        (t.questions || []).forEach(function(sectionObj) {
          Object.keys(sectionObj || {}).forEach(function(sectionName) {
            sectionNames.push(sectionName);
            (sectionObj[sectionName] || []).forEach(function(qid) { questionIds.push(qid); });
          });
        });
        return {
          id: t.testId || t.t_id || t.id || null, name: t.testName || '', questionIds: questionIds,
          sectionNames: sectionNames, sectionsRaw: t.sections || []
        };
      }).filter(function(t) { return t.id; });

      if (!allMatches.length) return res.status(404).json({ error: 'No test found matching "' + term + '"' });

      // Diagnostic: dump every fuzzy match the portal returned, with its name
      // JSON-stringified so any stray leading/trailing space, double space,
      // or embedded newline in the STORED name is actually visible in logs
      // (invisible in a plain console.log string). Also dump section names
      // AND the raw `sections` field (a field this route never previously
      // even looked at) — if either turns out to carry each section's source
      // QB, that's a fast targeted lookup instead of scanning every QB the
      // user can see.
      console.log('[EXAMLY] auto-QB: portal fuzzy-matched ' + allMatches.length + ' test(s) for "' + term + '":');
      allMatches.forEach(function(t) {
        console.log('  - name=' + JSON.stringify(t.name) + ' id=' + t.id + ' questionIds=' + t.questionIds.length +
                    ' sectionNames=' + JSON.stringify(t.sectionNames));
        if (t.sectionsRaw.length) console.log('    sections (raw)=' + JSON.stringify(t.sectionsRaw));
      });

      // Mirror the QB-name route: when the fuzzy search returns more than
      // one hit, prefer only the one(s) that match EXACTLY once whitespace/
      // underscores/case are normalised — otherwise an unrelated near-match
      // test (possibly with zero or different questions) gets unioned in
      // alongside — or instead of — the real one, which is exactly how a
      // stray space/newline in the stored test name turns "matched" into
      // "returned no questions".
      var nt = normName(term);
      var exactMatches = allMatches.filter(function(t) { return normName(t.name) === nt; });
      var tests = exactMatches.length ? exactMatches : allMatches;
      if (exactMatches.length && exactMatches.length !== allMatches.length) {
        console.log('[EXAMLY] auto-QB: narrowed to ' + exactMatches.length + ' exact-name match(es), ignored ' +
                    (allMatches.length - exactMatches.length) + ' other fuzzy match(es)');
      }

      var wantedIds = new Set();
      tests.forEach(function(t) { t.questionIds.forEach(function(qid) { wantedIds.add(qid); }); });
      if (!wantedIds.size) {
        console.log('[EXAMLY] auto-QB: matched test(s) but extracted 0 question id(s) from them — ' +
                    'either the test genuinely has no questions, or its "questions" field has an unexpected shape.');
        return res.json({
          success: true, data: [], tests: tests.map(function(t){return t.name;}), total: 0,
          // Surfaced to the UI so this failure mode (0 ids extracted) reads
          // differently from "ids extracted but none found in any visible QB".
          zeroQuestionIds: true
        });
      }
      // Captured BEFORE any scanning — `remaining` below is the SAME Set
      // object as wantedIds (not a copy), so wantedIds.size drains right
      // along with it as matches are found. Confirmed live: this bug made
      // status logs/responses report "found 10/0" instead of the real
      // requested count.
      var requestedTotal = wantedIds.size;

      console.log('[EXAMLY] auto-QB: test(s) ' + tests.map(function(t){return t.name;}).join(', ') +
                  ' -> ' + requestedTotal + ' question id(s) needed');

      var found = [];
      var remaining = wantedIds;

      function scanQb(qb) {
        if (remaining.size === 0 || !qb.id) return Promise.resolve();
        var body = { qb_id: qb.id, type: 'Single', page: 1, limit: 500 };
        return epost('/api/v2/questionfilter', body, token)
          .then(function(qfr) {
            var qraw = qfr.data || {};
            var list = [].concat(qraw.non_group_questions || [], qraw.group_questions || []);
            list.forEach(function(q) {
              var qid = q.q_id || q.question_id || q.id;
              if (remaining.has(qid)) {
                var mapped = mapQuestion(q);
                mapped.qbId = qb.id;
                mapped.qbName = qb.name;
                found.push(mapped);
                remaining.delete(qid);
              }
            });
          })
          .catch(function(err) {
            console.log('[EXAMLY] auto-QB: scan of QB "' + qb.name + '" failed -> ' + ((err.response && err.response.status) || err.message));
          });
      }

      function respond() {
        console.log('[EXAMLY] auto-QB: found ' + found.length + '/' + requestedTotal + ' question(s)' +
                    (remaining.size ? (' — ' + remaining.size + ' id(s) NOT found: ' + Array.from(remaining).join(',')) : ''));
        res.json({
          success: true, data: found, tests: tests.map(function(t){return t.name;}),
          total: found.length, requested: requestedTotal, notFound: Array.from(remaining)
        });
      }

      // CONFIRMED via a full live dump: GET /api/programming_question/:id
      // returns { data: { success, entity: { answer: {...programming_question
      // fields, flat...}, learning: {...question_data, tags, difficulty,
      // etc, flat...} } } } — genuinely NO qb/questionbank reference field
      // anywhere in it (checked exhaustively, both answer and learning). So
      // it can't resolve which QB a question lives in — but it DOES give us
      // everything needed to VIEW/GENERATE a solution for that question
      // without ever finding its QB at all. Cached here per id so the final
      // fallback below (if a question truly can't be matched to any QB) can
      // reuse it instead of a second round-trip.
      var directLookupCache = {};
      function directLookup(qid) {
        return eget('/api/programming_question/' + qid, token)
          .then(function(qr) {
            var body = qr.data || {};
            var level1 = body.data || body;
            var entity = level1.entity || level1;
            directLookupCache[qid] = entity;
            return entity;
          })
          .catch(function(err) {
            console.log('[EXAMLY] auto-QB: direct lookup q=' + qid + ' failed -> ' + ((err.response && err.response.status) || err.message));
            return null;
          });
      }
      // Builds a mapQuestion()-compatible raw object from a direct-lookup
      // entity. Missing vs. the QB pipeline: subject_id/topic_id/
      // blooms_taxonomy/pcm_combination_ids/createdBy — genuinely absent
      // from this endpoint (CONFIRMED, matches an already-documented finding
      // above this route). Fine for viewing/generating; NOT safe to push
      // from directly (risks silently clearing those on the portal), so
      // every question built this way is marked qbUnresolved — the client
      // gates Push on that flag until the real QB is found.
      function mapFromDirectLookup(qid, entity) {
        var answer = (entity && entity.answer) || {};
        var learning = (entity && entity.learning) || {};
        var rawLike = Object.assign({}, learning, { q_id: answer.q_id || qid, programming_question: answer });
        var mapped = mapQuestion(rawLike);
        mapped.qbId = null;
        mapped.qbName = null;
        mapped.qbUnresolved = true;
        return mapped;
      }

      // PRIMARY PATH — CONFIRMED live against a real account, real 65-
      // question test: GET /api/questions/test/:testId returns EVERY
      // question in a test with its real qb_id attached directly (plus
      // subject/topic/blooms_taxonomy/pcm_combination_ids), no name-
      // guessing needed at all. This replaced an entire cascade of QB-
      // NAME-based guessing (fast path / segment path / content-library
      // path / full scan) that could only ever find a QB whose NAME shared
      // vocabulary with the test's name — CONFIRMED it silently missed a
      // real QB ("NeoColab_Assessment_Java_COD_File reader and writer")
      // that shared literally zero words with its test's name
      // ("VIT_Assessment_4_COD_File Handling_Checking"). This endpoint
      // doesn't include createdBy/tags (CONFIRMED, checked exhaustively),
      // so it's used only to learn each question's real qb_id — the
      // existing trusted /api/v2/questionfilter scan (the SAME pipeline
      // already used for pushing) then fetches the full pushable object,
      // now against a small, EXACT set of QBs (usually 2-4) instead of
      // hundreds of guessed candidates.
      function fetchQbIdsForTest(testId) {
        return eget('/api/questions/test/' + testId, token)
          .then(function(r) {
            var buckets = Array.isArray(r.data) ? r.data : [r.data];
            var list = [];
            buckets.forEach(function(b) {
              list = list.concat((b && b.non_group_questions) || [], (b && b.group_questions) || []);
            });
            return list;
          })
          .catch(function(err) {
            console.log('[EXAMLY] auto-QB: GET /api/questions/test/' + testId + ' failed -> ' +
                        ((err.response && err.response.status) || err.message));
            return [];
          });
      }

      console.log('[EXAMLY] auto-QB: pre-fetching ' + remaining.size + ' question(s) directly (for view/generate, and as a guaranteed fallback if no QB is ever found)...');
      return Promise.all(Array.from(remaining).map(directLookup))
        .then(function() {
          return Promise.all(tests.map(function(t) { return fetchQbIdsForTest(t.id); }));
        })
        .then(function(perTestLists) {
          var qidToQbId = {};
          perTestLists.forEach(function(list) {
            list.forEach(function(q) {
              var qid = q.q_id || q.question_id || q.id;
              if (qid && q.qb_id && remaining.has(qid)) qidToQbId[qid] = q.qb_id;
            });
          });
          var distinctQbIds = Array.from(new Set(Object.keys(qidToQbId).map(function(qid) { return qidToQbId[qid]; })));
          console.log('[EXAMLY] auto-QB: direct test->QB lookup mapped ' + Object.keys(qidToQbId).length + '/' + remaining.size +
                      ' question(s) to ' + distinctQbIds.length + ' distinct QB(s): ' + distinctQbIds.join(', '));

          if (!distinctQbIds.length) return;

          // Resolve id -> name for logging/display (CONFIRMED working
          // endpoint from an earlier capture of the portal's own "Preview
          // Test" action — same shape reused here). NOT built with
          // baseBody() — CONFIRMED live this endpoint's schema is strict
          // and 400s on an unexpected "branch_id" field (which baseBody()
          // always adds); this one genuinely only takes these four.
          var nameLookupBody = {
            department_id: DEPARTMENT_IDS, mainDepartmentUser: true,
            isTestPreview: true, qb_id_list: distinctQbIds
          };
          return epost('/api/questionbanks/all', nameLookupBody, token)
            .then(function(nr) {
              var qbNames = {};
              ((nr.data && nr.data.questionbanks) || []).forEach(function(qb) { qbNames[qb.qb_id] = qb.qb_name; });
              var qbList = distinctQbIds.map(function(id) { return { id: id, name: qbNames[id] || id }; });
              return mapWithConcurrency(qbList, 3, scanQb);
            })
            .catch(function(err) {
              console.log('[EXAMLY] auto-QB: QB name resolution failed (' + ((err.response && err.response.status) || err.message) +
                          ') — scanning by id anyway, name will show as the raw id');
              var qbList = distinctQbIds.map(function(id) { return { id: id, name: id }; });
              return mapWithConcurrency(qbList, 3, scanQb);
            });
        })
        .then(function() {
          if (remaining.size === 0) { respond(); return; }

          // FALLBACK — only reached if GET /api/questions/test/:id itself
          // failed, or a scanned QB errored mid-request. Kept intentionally
          // small (one name search, then the guaranteed direct-lookup
          // fallback) since the primary path above now handles the
          // overwhelming majority of cases the old multi-tier cascade
          // existed to cover.
          console.log('[EXAMLY] auto-QB: ' + remaining.size + ' id(s) still unresolved after direct QB lookup — trying a name search...');
          var fastSearchBody = baseBody({ page: 1, limit: 10, visibility: 'All', search: term });
          return epost('/api/v2/questionbanks', fastSearchBody, token)
            .then(function(fastR) {
              var candidates = normalise(fastR.data);
              return mapWithConcurrency(candidates, 3, scanQb);
            })
            .catch(function(err) {
              console.log('[EXAMLY] auto-QB: name search failed (' + ((err.response && err.response.status) || err.message) + ')');
            })
            .then(function() {
              if (remaining.size === 0) { respond(); return; }

              // GUARANTEED FALLBACK: no scan tier above found these
              // question(s)' QB — rather than reporting "found nothing"
              // (the old behavior), build them straight from the
              // already-fetched direct-lookup cache above. View/generate
              // works fully; Push is gated client-side on qbUnresolved
              // until the real QB turns up (e.g. via a QB-name search).
              console.log('[EXAMLY] auto-QB: ' + remaining.size + ' id(s) never matched any scanned QB — ' +
                          'building them from direct lookup instead (view/generate only, push blocked until QB is found).');
              Array.from(remaining).forEach(function(qid) {
                var entity = directLookupCache[qid];
                if (entity && (entity.answer || entity.learning)) {
                  found.push(mapFromDirectLookup(qid, entity));
                  remaining.delete(qid);
                }
              });
              respond();
            });
        });
    })
    .catch(function(err) { handleErr(err, res); });
});

// GET /api/examly/tests/search?name=X
// CONFIRMED against a live capture: POST /api/v2/tests/filter. The response
// already includes each test's full sections + questions (question ids per
// section, keyed by section name) — no separate "get test detail" call needed.
router.get('/tests/search', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var term = String(req.query.name || '').trim();
  if (!term) return res.status(400).json({ error: '"name" is required' });

  var body = {
    page: 1,
    limit: 25,
    search: term,
    branch_id: 'All', // confirmed casing — differs from the lowercase 'all' used elsewhere
    department_id: DEPARTMENT_IDS,
    mainDepartmentUser: true
  };
  console.log('[EXAMLY] POST /api/v2/tests/filter search="' + term + '"');

  epost('/api/v2/tests/filter', body, token)
    .then(function(r) {
      var raw = r.data || {};
      var arr = Array.isArray(raw.data) ? raw.data : [];
      var tests = arr.map(function(t) {
        // questions: [{ "<sectionName>": [qid, qid, ...] }, ...] — flatten to one id list.
        var questionIds = [];
        (t.questions || []).forEach(function(sectionObj) {
          Object.keys(sectionObj || {}).forEach(function(sectionName) {
            (sectionObj[sectionName] || []).forEach(function(qid) { questionIds.push(qid); });
          });
        });
        return {
          id: t.testId || t.t_id || t.id || null,
          name: t.testName || '',
          code: t.testCode || null,
          publishStatus: t.publishStatus || null,
          sections: t.sections || [],
          questionIds: questionIds,
          questionCount: questionIds.length
        };
      }).filter(function(t) { return t.id; });
      console.log('[EXAMLY] tests/filter "' + term + '" -> ' + tests.length + ' hit(s), ' +
                  (tests[0] ? tests[0].questionIds.length + ' question id(s) on first hit' : ''));
      res.json({ success: true, data: tests });
    })
    .catch(function(err) { handleErr(err, res); });
});

// Reading question detail no longer goes through a guessed "get by id" route —
// getQBQuestions (below, via the CONFIRMED /questionbanks/:id/questions ->
// /api/v2/questionfilter pipeline already used by Test Packing) returns full
// detail for every question in a QB, including solution + language. The
// frontend resolves the QB name(s) the user gives, fetches that QB's full
// question list, and cross-references it against the test's question ids —
// no per-question guess needed at all.

// POST /api/examly/questions/:id/solution  { language, code }
// Still a guess — but narrower and safer than before: a small
// {q_id, solution:[{language, solutiondata}]} patch rather than a full-object
// replace, since we no longer have (or need) the complete original object.
// CONFIRMED against a live capture: PUT /api/update_programming_question/:id
// -> 200 OK. (Every guess before this one 404'd — the real path uses a
// snake_case action verb, not "programmingquestion" concatenated.)
var SOLUTION_PUSH_CANDIDATES = [
  { method: 'put', path: '/api/update_programming_question/' }
];

function pushSolutionWithFallback(id, body, token, idx) {
  idx = idx || 0;
  if (idx >= SOLUTION_PUSH_CANDIDATES.length) {
    return Promise.reject(new Error('all candidate push paths failed for id ' + id));
  }
  var c = SOLUTION_PUSH_CANDIDATES[idx];
  var url = c.path.charAt(c.path.length - 1) === '/' ? c.path + id : c.path; // id-in-body variants don't need it in the URL
  var call = c.method === 'put' ? eput(url, body, token) : epost(url, body, token);
  return call
    .then(function(r) {
      console.log('[EXAMLY] (GUESS) ✓ solution push path confirmed: ' + c.method.toUpperCase() + ' ' + url);
      return r;
    })
    .catch(function(err) {
      var status = err.response && err.response.status;
      console.log('[EXAMLY] (GUESS) push candidate ' + (idx + 1) + '/' + SOLUTION_PUSH_CANDIDATES.length +
                  ' (' + c.method.toUpperCase() + ' ' + url + ') -> ' + (status || err.message));
      if (status === 404) return pushSolutionWithFallback(id, body, token, idx + 1);
      throw err;
    });
}

router.post('/questions/:id/solution', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var id = req.params.id;
  var language = req.body.language;
  var code = req.body.code;
  var qbId = req.body.qbId || null;
  if (!language || !code) return res.status(400).json({ error: '"language" and "code" are required' });

  // Body shape CONFIRMED against a real captured "edit solution" request from
  // the portal's own UI (Network tab, 200 OK response) to this exact endpoint.
  // Turns out this was never a narrow "add a solution" patch — it's the SAME
  // full-object save the edit form always does, just with the solution /
  // multilanguage arrays changed. So instead of hand-picking a few fields, we
  // take the ENTIRE raw fetched question object (forwarded untouched by the
  // client as rawQuestion — mapQuestion spreads the raw portal fields
  // through, so it's all still there, both top-level and under
  // programming_question) and rebuild the flat PUT shape from it, changing
  // only the solution-related pieces. Anything we don't recognize defaults to
  // exactly what the confirmed-working capture sent for an untouched field
  // (null / false / [] — never an invented value).
  var raw = req.body.rawQuestion || {};
  var pq = raw.programming_question || {};

  var existingSolution = Array.isArray(pq.solution) ? pq.solution.slice()
    : (Array.isArray(req.body.existingSolution) ? req.body.existingSolution.slice() : []);
  var idx = -1;
  for (var i = 0; i < existingSolution.length; i++) {
    if (String(existingSolution[i].language).toLowerCase() === String(language).toLowerCase()) { idx = i; break; }
  }
  var existingEntry = idx !== -1 ? existingSolution[idx] : null;

  // Whichever solution the user is updating/pushing right now becomes the
  // best solution — "Best Solution" is a single choice across the WHOLE
  // question (confirmed via a live capture: only one language was ever true
  // at once), so every OTHER language's flag must be cleared first, or the
  // portal ends up with more than one "best" solution simultaneously (seen
  // live before this fix: pushing Java left Java AND the pre-existing Python
  // both marked best).
  existingSolution.forEach(function(sol) {
    if (Array.isArray(sol.solutiondata)) {
      sol.solutiondata.forEach(function(sd) { sd.solutionbest = false; });
    }
  });

  // "Code snippet" questions (CONFIRMED via a real captured question object):
  // some solution entries carry codeStub/header/footer alongside
  // solutiondata[0].solution. CONFIRMED via a SECOND real capture: hasSnippet
  // can be false even while codeStub holds real content — the two are
  // independent, so detection here is on actual header/footer/codeStub
  // CONTENT, never the hasSnippet flag alone. These fields are never
  // AI-generated by the server — the client already translated them into
  // THIS language (see /api/groq/translate-fragment and /translate-stub)
  // before calling this route, gated on real content so a plain question never gets them
  // invented. hasSnippet itself is just carried through as an independent
  // pass-through flag from the client (defaulting to the existing entry's
  // own flag when the client didn't say), never derived from content.
  var incomingSnippet = req.body.snippet || {};
  var hasSnippetContent = !!(incomingSnippet.header || incomingSnippet.footer || incomingSnippet.codeStub) ||
    !!(existingEntry && (existingEntry.header || existingEntry.footer || existingEntry.codeStub));

  var entry = {
    language: language,
    solutiondata: [{
      solution: code, solutionExp: null, solutionbest: true,
      isSolutionExp: false, solutionDebug: null
    }]
  };
  if (hasSnippetContent) {
    entry.hasSnippet = incomingSnippet.hasSnippet != null
      ? !!incomingSnippet.hasSnippet
      : !!(existingEntry && existingEntry.hasSnippet);
    var h = incomingSnippet.header != null ? incomingSnippet.header : ((existingEntry && existingEntry.header) || '');
    var f = incomingSnippet.footer != null ? incomingSnippet.footer : ((existingEntry && existingEntry.footer) || '');
    if (h) entry.header = h;
    if (f) entry.footer = f;
    entry.codeStub = incomingSnippet.codeStub != null ? incomingSnippet.codeStub : ((existingEntry && existingEntry.codeStub) || '');
    entry.hideHeader = existingEntry ? !!existingEntry.hideHeader : false;
    entry.hideFooter = existingEntry ? !!existingEntry.hideFooter : false;
  } else {
    // Never invent this structure for a question that never had it.
    entry.hasSnippet = false;
    entry.codeStub = '';
    entry.hideHeader = false;
    entry.hideFooter = false;
  }
  if (idx === -1) existingSolution.push(entry);
  else existingSolution[idx] = Object.assign({}, existingSolution[idx], entry);

  // CONFIRMED root cause of a long-standing bug (via a raw key-listing
  // diagnostic): /api/v2/questionfilter — the endpoint used for EVERY
  // question fetch — never returns a `multilanguage` field inside
  // programming_question at all. So `pq.multilanguage` was always undefined,
  // every single push (for every question, this entire session) merged
  // against an empty array, and multilanguage silently collapsed down to just
  // the one language being pushed on every save — even though the actual
  // solution code for every other language was correctly preserved in the
  // solution array the whole time (verified: nothing was ever lost except
  // this one metadata field). Fix: derive multilanguage from the solution
  // array's own languages instead of a field that was never actually there.
  // Self-healing — the very next push for an affected question rebuilds the
  // full list from existingSolution (which already has every language), no
  // manual portal fix needed.
  var seenLang = {};
  var multilanguage = existingSolution
    .map(function(s) { return s.language; })
    .filter(function(l) {
      if (!l) return false;
      var k = String(l).toLowerCase();
      if (seenLang[k]) return false;
      seenLang[k] = true;
      return true;
    });

  // testcases comes back from the LIST endpoint as a JSON *string*
  // (q.programming_question.testcases) but the real edit-form PUT sends the
  // same data already parsed into an array — confirmed via the live capture.
  var testcases = [];
  if (Array.isArray(pq.testcases)) testcases = pq.testcases;
  else if (typeof pq.testcases === 'string' && pq.testcases) {
    try { testcases = JSON.parse(pq.testcases); } catch (e) { testcases = []; }
  }

  // question_editor_type: forward the real value untouched when we have it
  // (CONFIRMED correct via a live push: the real value was 1, auto-forwarded,
  // not a guess). Only guess when the fetched question genuinely lacks it —
  // and guess 1 (this question's own confirmed real value) rather than the
  // old 'Program' string guess.
  var questionEditorType = raw.question_editor_type != null ? raw.question_editor_type
    : (req.body.questionEditorType != null ? req.body.questionEditorType : req.body.question_editor_type);
  var editorTypeGuessed = questionEditorType == null;
  if (editorTypeGuessed) questionEditorType = 1;

  var tags = extractPortalTags(raw);
  if (!tags.length && Array.isArray(raw.tags)) tags = raw.tags;

  // The portal's schema for this endpoint is strict (.unknown(false)-style) —
  // confirmed via a live 400: 'q_id/question_id/qb_id/questionbank_id "is not
  // allowed"'. The id lives in the URL only; none of these belong in the body.
  // Every other field/shape/default below is copied 1:1 from a real captured
  // PUT to this same endpoint for this same question.
  var body = {
    question_data: raw.question_data != null ? raw.question_data : (req.body.questionData || undefined),
    manual_difficulty: raw.manual_difficulty || req.body.difficulty || undefined,
    inputformat: pq.input_format || req.body.inputFormat || '',
    outputformat: pq.output_format || req.body.outputFormat || '',
    // CONFIRMED via a diagnostic dump of the raw fetched question: the real
    // field is `code_constraints` (underscored) nested under
    // programming_question — NOT `codeconstraints`/`pq.codeconstraints`,
    // which never existed and silently fell through to a generated
    // placeholder every time, overwriting the question's real text. Only
    // fall back to the generated summary if this question genuinely has no
    // real value at all.
    codeconstraints: (pq.code_constraints || raw.codeconstraints || raw.constraintsBlock ||
      'See sample I/O and test cases for this question\'s constraints.'),
    sample_io: pq.sample_io != null ? pq.sample_io : '[]',
    testcases: testcases,
    multilanguage: multilanguage,
    question_editor_type: questionEditorType,
    solution: existingSolution,

    blooms_taxonomy: raw.blooms_taxonomy != null ? raw.blooms_taxonomy : null,
    codesize: raw.codesize != null ? raw.codesize : null,
    course_outcome: raw.course_outcome != null ? raw.course_outcome : null,
    createdBy: raw.createdBy || raw.created_by || undefined,
    enable_api: raw.enable_api != null ? raw.enable_api : false,
    enablecustominput: raw.enablecustominput != null ? raw.enablecustominput : true,
    hint: Array.isArray(raw.hint) ? raw.hint : [],
    line_token_evaluation: raw.line_token_evaluation != null ? raw.line_token_evaluation : false,
    linked_concepts: raw.linked_concepts != null ? raw.linked_concepts : '',
    memorylimit: raw.memorylimit != null ? raw.memorylimit : null,
    outputLimit: raw.outputLimit != null ? raw.outputLimit : null,
    pcm_combination_ids: Array.isArray(raw.pcm_combination_ids) ? raw.pcm_combination_ids : [],
    program_outcome: raw.program_outcome != null ? raw.program_outcome : null,
    question_media: Array.isArray(raw.question_media) ? raw.question_media : [],
    setLimit: raw.setLimit != null ? raw.setLimit : false,
    sub_topic_id: raw.sub_topic_id || (raw.sub_topic && raw.sub_topic.id) || undefined,
    subject_id: raw.subject_id || (raw.subject && raw.subject.id) || undefined,
    tags: tags.length ? tags : [''],
    timelimit: raw.timelimit != null ? raw.timelimit : null,
    topic_id: raw.topic_id || (raw.topic && raw.topic.id) || undefined
  };
  console.log('[EXAMLY] pushing solution q_id=' + id + ' qb_id=' + qbId + ' lang=' + language +
              ' (merged into ' + existingSolution.length + ' solution entries, multilanguage=' + multilanguage.join(',') + ')' +
              ' question_editor_type=' + questionEditorType + (editorTypeGuessed ? ' (GUESSED)' : ' (from fetched question)') +
              (req.body.rawQuestion ? ' [rawQuestion forwarded]' : ' [NO rawQuestion — client is stale, most fields defaulted null]'));
  // Full outgoing body — diff against a fresh capture if anything still fails.
  console.log('[EXAMLY] full outgoing body: ' + JSON.stringify(body));

  pushSolutionWithFallback(id, body, token)
    .then(function(r) {
      res.json({ success: true, data: r.data });
    })
    .catch(function(err) { handleErr(err, res); });
});

// POST /api/examly/probe
router.post('/probe', function(req, res) {
  var token;
  try { token = getToken(req); } catch(e) { return res.status(401).json({ error: e.message }); }

  var path = req.body.path;
  if (!path) return res.status(400).json({ error: '"path" is required' });

  var body = Object.assign({ branch_id: 'all', mainDepartmentUser: true }, req.body.extra || {});
  console.log('[EXAMLY PROBE] POST ' + BASE + path);

  epost(path, body, token)
    .then(function(r) { res.json({ path: path, sentBody: body, response: r.data }); })
    .catch(function(err) { handleErr(err, res); });
});

module.exports = router;