const express = require('express');
const fs = require('fs');
const path = require('path');

// Minimal .env reader — deliberately not the `dotenv` package, because this
// backend's whole dependency list is `express` and that's worth keeping.
// Only fills variables that aren't already set, so real environment
// variables (Render's, or an inline `KEY=... node server.js`) always win.
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return; // no .env — normal in production, where the host supplies them
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so values with spaces work.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const app = express();
app.use(express.json());

// ── QBForge's Solution Manager — its own backend, unchanged ────────────────
// Mounted at its ORIGINAL paths (/api/examly, /api/groq, /api/execute) —
// confirmed these don't collide with any of Starlight's own /api/* routes
// above/below, so nothing else here needed to change. QBForge's own
// examly.js/groq.js/execute.js read GROQ_API_KEY/OPENROUTER_API_KEY (already
// in this backend's .env) plus EXAMLY_BASE_URL/SCHOOL_ID (added alongside
// them) directly from process.env — loadDotEnv() above already populated it
// before this point, so no separate dotenv/config call is needed here.
app.use('/api/examly', require('./qbforge-routes/examly'));
app.use('/api/groq', require('./qbforge-routes/groq'));
app.use('/api/execute', require('./qbforge-routes/execute'));

// NOTE: there used to be `app.use(express.static(__dirname))` here, serving
// the whole backend directory. Two problems, both live in production:
//   1. backend/index.html (the old standalone tool) was returned at "/",
//      shadowing the React app entirely — the deployed site showed the
//      legacy page instead of Starklight.
//   2. It served the backend source itself (/server.js, /db.js, …) to
//      anyone who asked. No secrets in it, but nothing should be serving
//      a server's own source directory.
// The client build is served near the bottom of this file instead.

const EXAMLY_QB_API = 'https://api.examly.io/api/v2/questionbanks';
const EXAMLY_QUESTIONS_API = 'https://api.examly.io/api/v2/questionfilter';
const EXAMLY_TEST_API = 'https://api.examly.io/api/test';
const EXAMLY_TEST_FILTER_API = 'https://api.examly.io/api/v2/tests/filter';
// Confirmed via a live Network-tab capture of "open test" in the portal:
const EXAMLY_TEST_DETAIL_API = 'https://api.examly.io/api/v2/test'; // GET /{id} -> sections + bare question IDs
const EXAMLY_QUESTIONS_BY_TEST_API = 'https://api.examly.io/api/questions/test'; // GET /{id} -> full question objects grouped by section (best source)

// How long to wait for api.examly.io before giving up. Without this the
// fetch waits forever: if the portal never answers, the browser spinner
// never stops and there is nothing on screen to explain why. That is exactly
// what happened on Render, which cannot reach api.examly.io at all — every
// search hung indefinitely instead of reporting a network failure.
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30000);

// One place for every call to the portal, so timeout handling and response
// parsing can't drift between the GET/POST/PUT paths.
//
// `upstreamRes.json()` used to be called blind, which throws whenever the
// portal replies with HTML (a WAF block page, a gateway error, a login
// redirect) and surfaced as a bare "Proxy request failed" with no clue that
// the body wasn't even JSON. The raw text is now kept and reported.
async function callUpstream(upstreamUrl, options) {
  const started = Date.now();
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      ...options,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (err) {
    const elapsed = Date.now() - started;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error('[PROXY] ' + (timedOut ? 'TIMEOUT' : 'NETWORK ERROR') +
      ' after ' + elapsed + 'ms -> ' + upstreamUrl + ' :: ' + err.message);
    return {
      failed: true,
      status: timedOut ? 504 : 502,
      body: {
        error: timedOut
          ? 'The Examly API did not respond within ' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + 's.'
          : 'Could not reach the Examly API.',
        detail: err.message,
        upstream: upstreamUrl,
        hint: 'If this server is hosted (e.g. Render), the portal may be refusing connections from ' +
              'its IP range. The same request usually works from a machine on your own network.'
      }
    };
  }

  const text = await upstreamRes.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // Non-JSON from the portal is itself the diagnosis — surface a snippet
    // rather than a parse error.
    return {
      failed: true,
      status: upstreamRes.status >= 400 ? upstreamRes.status : 502,
      body: {
        error: 'The Examly API returned a non-JSON response (HTTP ' + upstreamRes.status + ').',
        detail: text.slice(0, 300),
        upstream: upstreamUrl
      }
    };
  }
  return { failed: false, status: upstreamRes.status, body: data };
}

async function proxyPost(upstreamUrl, req, res) {
  try {
    const token = req.headers['authorization'];
    if (!token) {
      return res.status(400).json({ error: 'Missing Authorization header' });
    }
    const r = await callUpstream(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': token
      },
      body: JSON.stringify(req.body)
    });
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Proxy request failed', details: err.message });
  }
}

async function proxyPut(upstreamUrl, req, res) {
  try {
    const token = req.headers['authorization'];
    if (!token) {
      return res.status(400).json({ error: 'Missing Authorization header' });
    }

    const r = await callUpstream(upstreamUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': token
      },
      body: JSON.stringify(req.body)
    });
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Proxy request failed', details: err.message });
  }
}

// ---- Generic GET proxy (used for fetching a single test's detail) ----
async function proxyGet(upstreamUrl, req, res) {
  try {
    const token = req.headers['authorization'];
    if (!token) {
      return res.status(400).json({ error: 'Missing Authorization header' });
    }

    const r = await callUpstream(upstreamUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': token
      }
    });
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Proxy GET request failed', details: err.message });
  }
}

app.post('/api/questionbanks', (req, res) => proxyPost(EXAMLY_QB_API, req, res));
app.post('/api/questions', (req, res) => proxyPost(EXAMLY_QUESTIONS_API, req, res));

// ---- Test creation proxy ----
app.post('/api/test', (req, res) => proxyPost(EXAMLY_TEST_API, req, res));
app.put('/api/test/:id', (req, res) => proxyPut(EXAMLY_TEST_API + '/' + req.params.id, req, res));

// ---- Test QC: search tests by name, then fetch one test's detail ----
// Search endpoint confirmed from a live Network-tab capture (POST /api/v2/tests/filter,
// same body shape as the question-bank search: page/limit/search/branch_id/department_id).
app.post('/api/tests/filter', (req, res) => proxyPost(EXAMLY_TEST_FILTER_API, req, res));
// Sections + bare question-ID summary for a test (confirmed shape).
app.get('/api/test/:id', (req, res) => proxyGet(EXAMLY_TEST_DETAIL_API + '/' + req.params.id, req, res));
// Full question objects for a test, already grouped by section (confirmed shape) — this is
// the primary source the Test QC feature uses, since it needs no extra per-question fetch.
app.get('/api/questions/test/:id', (req, res) => proxyGet(EXAMLY_QUESTIONS_BY_TEST_API + '/' + req.params.id, req, res));

// ---- Multi-provider AI fallback chain ----
// Tries Groq first (fastest, generous free tier), then OpenRouter free-tagged
// models, then Gemini's free tier, then HuggingFace.
//
// KEYS COME FROM THE ENVIRONMENT ONLY. They used to be literals right here,
// which made this file unshareable and would have published four live keys on
// the first `git push`. Set them in a local `.env` (gitignored) or, on Render,
// as service environment variables. `loadDotEnv()` at the top of this file
// reads `.env` without any dependency.
//
// A missing key is not fatal: that provider is skipped and the chain falls
// through to the next one, so the app still runs with only one configured.
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant'
];

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Only ":free"-suffixed models — these are OpenRouter's no-cost tier and will
// never bill against the key even if it has credits attached.
// Nemotron 3 Ultra listed first — larger, stronger reasoning model, better suited to the
// structured QC/rectification prompts this app sends. Confirmed model ID via OpenRouter's
// own listing: nvidia/nemotron-3-ultra-550b-a55b:free (1M context, no response_format
// enforcement — fine here since JSON is parsed manually with markdown-fence stripping).
const OPENROUTER_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-2-9b-it:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'deepseek/deepseek-chat-v3.1:free'
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash']; // free-tier models

const HF_API_KEY = process.env.HF_API_KEY || '';
const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';
// Free-tier-friendly instruct models on HF's Inference Providers router.
const HF_MODELS = [
  'meta-llama/Llama-3.1-8B-Instruct',
  'Qwen/Qwen2.5-7B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'google/gemma-2-9b-it'
];

let lastWorkingProvider = null; // remembered across calls: 'groq' | 'openrouter' | 'gemini' | 'huggingface'
let lastWorkingModel = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Some free/small models occasionally wrap the JSON in a sentence or two despite instructions
// not to. Try strict parsing first (fast path), then fall back to pulling out the first
// balanced {...} block from the raw text before giving up — this alone fixes a meaningful
// share of "Could not parse AI response as JSON" failures without needing a retry call.
function parseAiJson(rawContent) {
  const cleaned = (rawContent || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// Guards against the model saying "no errors" in checks while still listing a fix (or vice
// versa) — whichever side is more informative wins, so the badge column and the Fix Needed
// list can never visibly disagree with each other.
// Renders the locally-computed duplicate-case scan for the prompt. This is deterministic
// string comparison done in the client, not something the model should re-derive — it's fed
// in as established fact so the verdict can't drift.
function describeRepeats(rep) {
  if (!rep || typeof rep !== 'object') return '(not provided)';
  const lines = [];
  if (Array.isArray(rep.sampleReusedInHidden) && rep.sampleReusedInHidden.length) {
    lines.push('REPEATED — these hidden test cases are identical to a sample case: ' +
      rep.sampleReusedInHidden.map(function (r) {
        return 'hidden #' + r.hiddenIndex + ' == sample #' + r.sampleIndex;
      }).join(', '));
  }
  if (Array.isArray(rep.duplicateHidden) && rep.duplicateHidden.length) {
    lines.push('DUPLICATED — these hidden test cases repeat an earlier hidden case: ' +
      rep.duplicateHidden.map(function (r) {
        return 'hidden #' + r.hiddenIndex + ' == hidden #' + r.firstIndex;
      }).join(', '));
  }
  return lines.length ? lines.join('\n') : 'No repeated or duplicated test cases found.';
}

function reconcileAnalysis(analysis, repeats) {
  if (!analysis || typeof analysis !== 'object') return analysis;
  const checks = analysis.checks && typeof analysis.checks === 'object' ? analysis.checks : {};
  const fixes = Array.isArray(analysis.fix_needed) ? analysis.fix_needed.slice() : [];

  // Fillup explanations are, by house style, the complete filled-in solution code with no
  // prose. The model still occasionally fails them for "no reasoning" despite the prompt
  // saying not to — override that specific verdict here so it can't cost a rating point.
  if (analysis.category === 'fillup' && checks.explanation_check) {
    const note = String(checks.explanation_check.note || '').toLowerCase();
    const styleComplaint = /no reasoning|just the solution|just solution code|lacks reasoning|only the code|restatement|no explanation of why/.test(note);
    if (checks.explanation_check.verdict === 'fail' && styleComplaint) {
      checks.explanation_check = { verdict: 'pass', note: '' };
      if (typeof analysis.rating === 'number' && analysis.rating < 5) analysis.rating += 1;
    }
  }

  // A response with a rating but no checks at all renders as a row of blank dashes, which
  // reads like a silent pass. Surface it as an explicit problem instead, so it's obvious the
  // question needs re-running rather than appearing to have been checked and approved.
  if (Object.keys(checks).length === 0) {
    analysis.checks = {};
    analysis.rating = 0;
    analysis.incomplete = true;
    analysis.fix_needed = [{
      area: 'statement_code',
      severity: 'must-fix',
      issue: 'The AI returned no checks for this question — use the re-QC button to run it again.'
    }];
    return analysis;
  }

  // A fix_needed entry naming an area that checks says is fine (or doesn't mention at all) —
  // escalate that check to match the fix's severity instead of silently dropping the fix.
  fixes.forEach(function(f) {
    if (!f || !f.area) return;
    const existing = checks[f.area];
    if (!existing || existing.verdict === 'pass' || existing.verdict === undefined) {
      checks[f.area] = {
        verdict: f.severity === 'must-fix' ? 'fail' : 'warn',
        note: (existing && existing.note) || f.issue || ''
      };
    }
  });

  // A check flagged fail/warn with nothing in fix_needed — synthesize an entry so it's never
  // invisible in the "what do I actually need to change" list.
  Object.keys(checks).forEach(function(area) {
    const check = checks[area];
    if (!check || (check.verdict !== 'fail' && check.verdict !== 'warn')) return;
    const alreadyListed = fixes.some(function(f) { return f && f.area === area; });
    if (!alreadyListed) {
      fixes.push({
        area: area,
        severity: check.verdict === 'fail' ? 'must-fix' : 'should-fix',
        issue: check.note || ('Flagged as ' + check.verdict + ' but no detail was provided.')
      });
    }
  });

  // The duplicate-case scan is exact string comparison done in code, so if it found repeats
  // the test_cases verdict is forced to fail regardless of what the model returned.
  if (repeats && repeats.hasAny) {
    const bits = [];
    (repeats.sampleReusedInHidden || []).forEach(function (r) {
      bits.push('hidden #' + r.hiddenIndex + ' repeats sample #' + r.sampleIndex);
    });
    (repeats.duplicateHidden || []).forEach(function (r) {
      bits.push('hidden #' + r.hiddenIndex + ' duplicates hidden #' + r.firstIndex);
    });
    const detail = 'Repeated test case(s): ' + bits.join('; ') + '.';
    const existing = checks.test_cases || {};
    checks.test_cases = {
      verdict: 'fail',
      note: existing.note && existing.note.indexOf('Repeated test case') === -1
        ? existing.note + ' ' + detail
        : detail
    };
    if (!fixes.some(function (f) { return f && f.area === 'test_cases'; })) {
      fixes.push({ area: 'test_cases', severity: 'must-fix', issue: detail });
    }
  }

  // HARD OVERRIDE, enforced here (not just via prompt): a debug question whose buggy code has
  // ZERO syntax errors is a critical setup failure — rating is forced to 0 no matter what the
  // model returned, and a must-fix entry is guaranteed to exist explaining why.
  const debugCheck = checks.debug_analysis;
  if (debugCheck && debugCheck.verdict !== 'na' && debugCheck.syntax_error_count === 0) {
    analysis.rating = 0;
    checks.debug_analysis = Object.assign({}, debugCheck, { verdict: 'fail' });
    const hasDebugFix = fixes.some(function(f) { return f && f.area === 'debug_analysis'; });
    if (!hasDebugFix) {
      fixes.push({
        area: 'debug_analysis',
        severity: 'must-fix',
        issue: 'Buggy code has 0 syntax errors — a debug question must actually be broken; rating forced to 0.'
      });
    }
  }

  analysis.checks = checks;
  analysis.fix_needed = fixes;
  return analysis;
}

function toOpenAiMessages(messages) {
  return messages; // Groq, OpenRouter & HF router all use the same {role, content} shape
}

async function tryGroq(messages) {
  const models = lastWorkingProvider === 'groq' && lastWorkingModel
    ? [lastWorkingModel].concat(GROQ_MODELS.filter(m => m !== lastWorkingModel))
    : GROQ_MODELS;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
          body: JSON.stringify({ model, messages: toOpenAiMessages(messages), temperature: 0.3 })
        });
        if (res.ok) {
          const data = await res.json();
          const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
          return { ok: true, content, provider: 'groq', model };
        }
        const errText = await res.text();
        if (res.status === 401 || res.status === 403) {
          return { ok: false, provider: 'groq', fatal: true, error: { status: res.status, body: errText, model } };
        }
        if (res.status === 429 && attempt === 0) {
          await sleep(1500);
          continue; // retry same model once after a short backoff
        }
        break; // move to next model
      } catch (err) {
        break; // network error, try next model
      }
    }
  }
  return { ok: false, provider: 'groq', fatal: false, error: { status: 0, body: 'All Groq models failed or rate-limited' } };
}

async function tryOpenRouter(messages) {
  const models = lastWorkingProvider === 'openrouter' && lastWorkingModel
    ? [lastWorkingModel].concat(OPENROUTER_MODELS.filter(m => m !== lastWorkingModel))
    : OPENROUTER_MODELS;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'Examly QC Tool'
          },
          body: JSON.stringify({ model, messages: toOpenAiMessages(messages), temperature: 0.3 })
        });
        if (res.ok) {
          const data = await res.json();
          const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
          return { ok: true, content, provider: 'openrouter', model };
        }
        const errText = await res.text();
        if (res.status === 401 || res.status === 403) {
          return { ok: false, provider: 'openrouter', fatal: true, error: { status: res.status, body: errText, model } };
        }
        if (res.status === 429 && attempt === 0) {
          await sleep(1500);
          continue;
        }
        break;
      } catch (err) {
        break;
      }
    }
  }
  return { ok: false, provider: 'openrouter', fatal: false, error: { status: 0, body: 'All OpenRouter free models failed or rate-limited' } };
}

async function tryGemini(messages) {
  const models = lastWorkingProvider === 'gemini' && lastWorkingModel
    ? [lastWorkingModel].concat(GEMINI_MODELS.filter(m => m !== lastWorkingModel))
    : GEMINI_MODELS;

  // Gemini uses a different request shape: merge system+user into "contents"
  const systemMsg = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');
  const combinedText = (systemMsg ? systemMsg.content + '\n\n' : '') + userMsgs.map(m => m.content).join('\n\n');

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_API_KEY;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: combinedText }] }],
            generationConfig: { temperature: 0.3 }
          })
        });
        if (res.ok) {
          const data = await res.json();
          const content = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
            ? data.candidates[0].content.parts.map(p => p.text || '').join('')
            : '';
          return { ok: true, content, provider: 'gemini', model };
        }
        const errText = await res.text();
        if (res.status === 401 || res.status === 403) {
          return { ok: false, provider: 'gemini', fatal: true, error: { status: res.status, body: errText, model } };
        }
        if (res.status === 429 && attempt === 0) {
          await sleep(1500);
          continue;
        }
        break;
      } catch (err) {
        break;
      }
    }
  }
  return { ok: false, provider: 'gemini', fatal: false, error: { status: 0, body: 'All Gemini models failed or rate-limited' } };
}

async function tryHuggingFace(messages) {
  const models = lastWorkingProvider === 'huggingface' && lastWorkingModel
    ? [lastWorkingModel].concat(HF_MODELS.filter(m => m !== lastWorkingModel))
    : HF_MODELS;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(HF_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HF_API_KEY },
          body: JSON.stringify({ model, messages: toOpenAiMessages(messages), temperature: 0.3 })
        });
        if (res.ok) {
          const data = await res.json();
          const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
          return { ok: true, content, provider: 'huggingface', model };
        }
        const errText = await res.text();
        if (res.status === 401 || res.status === 403) {
          return { ok: false, provider: 'huggingface', fatal: true, error: { status: res.status, body: errText, model } };
        }
        if (res.status === 429 && attempt === 0) {
          await sleep(1500);
          continue;
        }
        break;
      } catch (err) {
        break;
      }
    }
  }
  return { ok: false, provider: 'huggingface', fatal: false, error: { status: 0, body: 'All Hugging Face models failed or rate-limited' } };
}

// Master fallback: Groq -> OpenRouter (free only) -> Gemini (free tier) -> Hugging Face
// Which providers actually have a key. Everything here reads from the
// environment, so on a fresh host with nothing set this is empty — and that
// is a completely different situation from four providers being tried and
// rejecting the request.
function configuredProviders() {
  return [
    GROQ_API_KEY && 'groq',
    OPENROUTER_API_KEY && 'openrouter',
    GEMINI_API_KEY && 'gemini',
    HF_API_KEY && 'huggingface'
  ].filter(Boolean);
}

// One place to build the error body, so all ten call sites say the same
// thing. The old message was a fixed string claiming all four providers had
// been "tried", which was actively misleading when none were configured —
// it sent you looking for an outage instead of a missing env var.
function aiFailureBody(result) {
  const configured = configuredProviders();
  if (!configured.length) {
    return {
      error: 'No AI provider is configured. Set at least one of GROQ_API_KEY, OPENROUTER_API_KEY, ' +
             'GEMINI_API_KEY or HF_API_KEY in the server environment — backend/.env when running ' +
             'locally, or the service environment variables when hosted.',
      configuredProviders: [],
      details: (result && result.attempts) || []
    };
  }
  return {
    error: 'Every configured AI provider failed (' + configured.join(', ') + ').',
    configuredProviders: configured,
    details: (result && result.attempts) || []
  };
}

async function callAi(messages) {
  const providerFns = { groq: tryGroq, openrouter: tryOpenRouter, gemini: tryGemini, huggingface: tryHuggingFace };
  // Only providers with a key. Without this filter an unconfigured host
  // makes four doomed HTTP round trips before failing, which is slow and
  // buries the real cause under four 401s.
  const allProviders = configuredProviders();
  const order = lastWorkingProvider && allProviders.includes(lastWorkingProvider)
    ? [lastWorkingProvider].concat(allProviders.filter(p => p !== lastWorkingProvider))
    : allProviders;

  const attempts = [];

  for (const providerName of order) {
    const result = await providerFns[providerName](messages);
    if (result.ok) {
      lastWorkingProvider = result.provider;
      lastWorkingModel = result.model;
      return {
        ok: true,
        content: result.content,
        provider: result.provider,
        model: result.model
      };
    }
    attempts.push({ provider: providerName, error: result.error });
  }

  return { ok: false, attempts };
}



app.post('/api/suggest-tags', async (req, res) => {
  try {
    const { question_text, question_type, existing_tags } = req.body;
    if (!question_text) {
      return res.status(400).json({ error: 'Missing question_text in request body' });
    }

    const systemPrompt =
      'You are an expert programming instructor who tags coding practice questions with the ' +
      'concrete technical concepts a learner needs to solve them (e.g. "1D array", "2D array", ' +
      '"nested loop", "conditional statements", "recursion", "string manipulation", "hashmap", ' +
      '"sorting", "two pointers", "sliding window", "binary search", "greedy", "backtracking"). ' +
      'Given a question (and optionally its type and existing tags), respond with ONLY a JSON array ' +
      'of 3-8 short tag strings, no prose, no markdown, no explanation. Example output: ' +
      '["1D array", "loop", "conditional statements"]';

    const userPrompt =
      'Question type: ' + (question_type || 'unknown') + '\n' +
      'Existing tags: ' + (Array.isArray(existing_tags) ? existing_tags.join(', ') : 'none') + '\n\n' +
      'Question:\n' + question_text;

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }

    const content = result.content;

    let tags = [];
    try {
      const cleaned = content.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
      tags = JSON.parse(cleaned);
      if (!Array.isArray(tags)) tags = [];
    } catch (parseErr) {
      tags = [];
    }

    res.json({ tags: tags, raw: content, model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tag suggestion failed', details: err.message });
  }
});

// ---- QC Analysis (rating, tags, duplication, core topic, topic alignment) ----
app.post('/api/qc-analyze', async (req, res) => {
  try {
    const {
      question_text,      // stripped problem statement
      input_format,
      output_format,
      constraints,          // the REAL constraint text (code_constraints) — nothing else
      sample_cases,         // visible sample I/O, formatted
      hidden_test_cases,    // hidden/scored cases, formatted
      repeated_cases,       // { sampleReusedInHidden:[], duplicateHidden:[], hasAny:bool }
      solution_code,
      question_type,
      mcq_data,            // raw JSON string of mcq_questions + answer_explanation (best-effort — field names unconfirmed)
      debug_code,          // best-effort buggy/debug code (field name unconfirmed — empty if not found)
      fillup_data,         // parsed fill-in-the-blank answers/blank counts (confirmed shape)
      topics_included,     // array of topic names in scope (syllabus check)
      topics_excluded      // array of future/out-of-scope topic names (syllabus check)
    } = req.body;

    if (!question_text) {
      return res.status(400).json({ error: 'Missing question_text in request body' });
    }

    const hasScope = (Array.isArray(topics_included) && topics_included.length) ||
      (Array.isArray(topics_excluded) && topics_excluded.length);
    const topicsIncludedBlock = (Array.isArray(topics_included) && topics_included.length)
      ? topics_included.join(', ') : '(none specified)';
    const topicsExcludedBlock = (Array.isArray(topics_excluded) && topics_excluded.length)
      ? topics_excluded.join(', ') : '(none specified)';

    // Kept intentionally short — this is the cheap first-pass table, not the fix itself.
    const systemPrompt =
      'You are a strict technical QC verifier for coding questions, debug questions, and MCQs. Be concise, ' +
      'technical, and evidence-based. Never assume correctness — check the code/answer against the statement, ' +
      'format, and constraints.\n\n' +
      'Classify the question as "coding" (this also covers debug questions — the reference/correct solution ' +
      'code is always given to you, even for a debug question) or "mcq".\n\n' +
      'For every check below, return a verdict: "pass", "fail" (must-fix, reduces rating), "warn" (should-fix, ' +
      'does NOT reduce rating), or "na" if the check does not apply.\n\n' +
      'CODING/DEBUG CHECKS:\n' +
      '- statement_code: the code must solve exactly what is described — no variant or different problem.\n' +
      '- format: input parsing order/types/delimiters and output wording/case/spacing must match the code ' +
      'exactly. If any input/output is float/double, the output description MUST state rounding (e.g. "rounded ' +
      'to 2 decimal places") — missing this is a fail. Sample inputs not shown as decimals when the type is ' +
      'float/double is a warn only, never a fail.\n' +
      '- constraints: judge ONLY the CONSTRAINTS block (the stated limits). They must be realistic, internally ' +
      'consistent, and match the code\'s actual complexity (fail if e.g. n<=10^5 but the code is O(n^2)). ' +
      'Crucially, every sample and hidden test case must SATISFY these constraints — if any case uses a value ' +
      'outside the stated limits, or the constraints omit a variable the cases clearly vary, that is a fail. ' +
      'Do NOT judge test-case quality here; that belongs to test_cases.\n' +
      '- test_cases: judge ONLY the SAMPLE and HIDDEN test-case blocks. They must cover edge/boundary/extreme ' +
      'conditions and be genuinely distinct from one another. The DUPLICATE-CASE SCAN below was computed by ' +
      'exact comparison in code — treat it as fact and do not second-guess it. If it reports any repeat, this ' +
      'check MUST be "fail" and the note MUST state which case numbers repeat (e.g. "hidden #3 repeats ' +
      'sample #1"), because a sample reused as a hidden case hands students free marks and duplicated hidden ' +
      'cases waste score weight. Do NOT judge the constraint limits here; that belongs to constraints.\n' +
      '- syllabus_alignment: ONLY evaluate if a topic scope is given below; otherwise return "na". Allowed ' +
      'topics = the included list (or everything except the excluded list). Fail if the core logic/algorithm/' +
      'data structure, any built-in shortcut, or wording in the statement requires something out of scope.\n' +
      '- blank_answer: FILL-IN-THE-BLANK questions only (otherwise "na"). The accepted answer(s) for each ' +
      'blank are given below. Mentally substitute each answer into the blank and decide whether the resulting ' +
      'code/sentence is actually correct AND produces the stated expected output. Fail if the answer is wrong, ' +
      'would not compile, produces different output, or if the declared blank count does not match the number ' +
      'of blanks actually present in the statement. Warn if the answer works but an obvious equally-valid ' +
      'alternative is missing from other_answers (e.g. only "==" accepted where "== " or "0 ==" would also be ' +
      'correct), or if case sensitivity looks wrong for the answer type.\n' +
      '- explanation_check: for MCQ AND fill-in-the-blank. Verify the explanation actually justifies the given ' +
      'answer and is itself factually correct — an explanation that contradicts the answer or explains a ' +
      'different question is a \"fail\". Missing entirely is a \"warn\".\n' +
      '  IMPORTANT EXCEPTION FOR FILL-IN-THE-BLANK: for a code-snippet fillup, the explanation is EXPECTED to ' +
      'be the complete filled-in solution code with no prose reasoning. That is the correct house style, so it ' +
      'is a \"pass\", NOT a fail. NEVER flag a fillup explanation for \"being just the solution code\", ' +
      '\"lacking reasoning\", or \"not explaining why\". Only fail a fillup explanation when the code it shows ' +
      'is actually WRONG — it does not compile, or contradicts the accepted blank answer / stated output.\n' +
      '- debug_analysis: ONLY evaluate if buggy/debug code is provided below; otherwise return "na". Count the ' +
      'actual number of syntax errors (code that would fail to compile/parse) and logical errors (code that ' +
      'compiles but produces wrong behavior) in that buggy code relative to the correct reference solution — ' +
      'report these as separate NUMERIC fields (syntax_error_count, logical_error_count), not just in prose. ' +
      'Verdict is "fail" if the bug count doesn\'t match what the question intends to test, "warn" if the bugs ' +
      'are fine but something else about the setup is off, otherwise "pass". CRITICAL EXCEPTION: if ' +
      'syntax_error_count is exactly 0 (the buggy code has NO syntax errors at all), this is itself a critical ' +
      'problem — a debug/bug-fixing question is supposed to actually be broken — so verdict MUST be "fail" ' +
      'regardless of anything else, and the overall rating for this question is forced to 0 (see RATING rule).\n\n' +
      'MCQ CHECKS:\n' +
      '- answer_correct: the marked correct option must actually be correct per the statement/logic.\n' +
      '- only_one_correct: exactly one option must be unambiguously correct; fail if 0 or 2+ are correct, or a ' +
      'distractor is arguably also correct.\n' +
      '- explanation_check: if an explanation is provided, it must be technically correct. If NO explanation is ' +
      'provided, do NOT return "na" — return "warn" with note exactly "Explanation is missing." This is flagged ' +
      'as should-fix (not a blocking must-fix), but still costs exactly 1 rating point (see RATING rule below).\n' +
      '- explanation_check should still be \"na\" if the question type is neither MCQ nor fill-in-the-blank.\n' +
      '\nWHICH KEYS TO RETURN (this matters — an empty \"checks\" object is never acceptable):\n' +
      '- category \"coding\": statement_code, format, constraints, test_cases (plus syllabus_alignment and ' +
      'debug_analysis when applicable).\n' +
      '- category \"mcq\": answer_correct, only_one_correct, explanation_check (plus syllabus_alignment).\n' +
      '- category \"fillup\" — use this whenever FILL-IN-THE-BLANK DATA is supplied below: blank_answer and ' +
      'explanation_check (plus syllabus_alignment). Do NOT return the coding keys for a fillup.\n' +
      'Always populate every key listed for the category you chose. If you genuinely cannot judge one, return ' +
      '\"warn\" with a short note explaining why — never omit the key, and never return an empty checks object.\n' +
      '- syllabus_alignment: same rule as above, "na" if no scope given.\n\n' +
      'RATING: 1-5 stars. Deduct 1 star per "fail" verdict. Additionally — as exceptions to "warns never ' +
      'reduce rating" — deduct exactly 1 star if explanation_check is "warn" specifically because the ' +
      'explanation is missing (this is still a should-fix issue, not a must-fix, but it does cost a point). ' +
      'Every other "warn" verdict never reduces the rating. HARD OVERRIDE: if debug_analysis.syntax_error_count ' +
      'is exactly 0, set rating to 0 regardless of every other check — this overrides the normal 1-5 floor.\n\n' +
      'Return ONLY a single JSON object (no markdown fences, no prose outside it). Include only the check keys ' +
      'relevant to the category:\n' +
      '{\n' +
      '  "category": "coding" | "mcq" | "fillup",\n' +
      '  "one_line_logic": "<one line: what the code/answer actually does, or the MCQ\'s core concept>",\n' +
      '  "checks": {\n' +
      '    "statement_code": {"verdict":"pass|fail|warn", "note":"<empty if pass, else one short sentence>"},\n' +
      '    "format": {...}, "constraints": {...}, "test_cases": {...},\n' +
      '    "answer_correct": {...}, "only_one_correct": {...}, "explanation_check": {"verdict":"pass|fail|na","note":"..."},\n' +
      '    "syllabus_alignment": {"verdict":"pass|fail|warn|na", "note":"<the specific out-of-scope topic and where it appears, if fail>"},\n' +
      '    "debug_analysis": {"verdict":"pass|fail|warn|na", "syntax_error_count": <int or null if na>, "logical_error_count": <int or null if na>, "note":"<one short clause of what the bugs are, or empty if na>"},\n' +
      '    "blank_answer": {"verdict":"pass|fail|warn|na", "note":"<what is wrong with the blank answer, or empty if pass/na>"}\n' +
      '  },\n' +
      '  "rating": <0-5 — 0 ONLY via the debug hard-override above, otherwise 1-5>,\n' +
      '  "fix_needed": [ {"area":"statement_code|format|constraints|test_cases|answer_correct|only_one_correct|explanation_check|syllabus_alignment|debug_analysis|blank_answer", "severity":"must-fix|should-fix", "issue":"<one short, specific sentence>"} ]\n' +
      '}\n' +
      'Keep every note/issue to one short sentence — this is a summary pass, not the fix itself.\n\n' +
      'CONSISTENCY (checked and enforced automatically, but get it right the first time):\n' +
      '- Every "fail" or "warn" verdict in checks MUST have a matching entry in fix_needed with that exact ' +
      'same area — never leave a fail/warn silently unlisted.\n' +
      '- Every fix_needed entry\'s "area" MUST name the check that is ACTUALLY wrong. If the real problem is ' +
      'the input/output description not matching the code, the area is "format" — do not label a format ' +
      'problem as "constraints", and do not label a constraints problem (unrealistic bounds, wrong complexity) ' +
      'as "format". The area and the issue text must describe the SAME problem.\n' +
      '- Never include a fix_needed entry whose area is "pass" in checks — if you are not flagging it, do not ' +
      'list it.';

    const userPrompt =
      'QUESTION TYPE (platform field): ' + (question_type || 'unknown') + '\n' +
      'SYLLABUS SCOPE — topics that should be included: ' + topicsIncludedBlock + '\n' +
      'SYLLABUS SCOPE — future/out-of-scope topics: ' + topicsExcludedBlock + (hasScope ? '' : ' (no scope given — mark syllabus_alignment as "na")') + '\n\n' +
      'PROBLEM STATEMENT:\n' + (question_text || '(none)') + '\n\n' +
      'INPUT FORMAT:\n' + (input_format || '(none)') + '\n\n' +
      'OUTPUT FORMAT:\n' + (output_format || '(none)') + '\n\n' +
      'CONSTRAINTS (the stated limits only):\n' + (constraints || '(none)') + '\n\n' +
      'SAMPLE TEST CASES (visible to students):\n' + (sample_cases || '(none)') + '\n\n' +
      'HIDDEN TEST CASES (used for scoring):\n' + (hidden_test_cases || '(none)') + '\n\n' +
      'DUPLICATE-CASE SCAN (computed locally, treat as fact):\n' + describeRepeats(repeated_cases) + '\n\n' +
      'SOLUTION CODE (coding/debug questions):\n' + (solution_code || '(none — likely an MCQ)') + '\n\n' +
      'MCQ ANSWER/OPTION DATA (raw, if this is an MCQ):\n' + (mcq_data || '(none — likely a coding question)') + '\n\n' +
      'BUGGY/DEBUG CODE (if this is a debug question — mark debug_analysis as "na" if empty):\n' + (debug_code || '(none provided)') + '\n\n' +
      'FILL-IN-THE-BLANK DATA (if this is a fillup question — mark blank_answer as "na" if empty):\n' + (fillup_data || '(none provided)') + '\n\n' +
      'Return the JSON object now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }

    const content = result.content;
    const parsed = parseAiJson(content);

    if (!parsed) {
      return res.json({
        ok: false,
        raw: content,
        model_used: result.provider + '/' + result.model,
        error: 'Could not parse AI response as JSON'
      });
    }

    res.json({ ok: true, analysis: reconcileAnalysis(parsed, repeated_cases), model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'QC analysis failed', details: err.message });
  }
});

// ---- Lightweight, single-purpose topic-alignment check — used during test PACKING, not
// the full QC rubric. Deliberately cheap (one check, short prompt) since the point is to let
// someone check just a handful of questions they're unsure about while browsing a QB, without
// paying for the full statement/format/constraints/test-case pass on every question in a pool.
app.post('/api/topic-align-check', async (req, res) => {
  try {
    const { question_text, solution_code, question_type, topics_included, topics_excluded } = req.body;

    if (!question_text) {
      return res.status(400).json({ error: 'Missing question_text in request body' });
    }
    const hasScope = (Array.isArray(topics_included) && topics_included.length) ||
      (Array.isArray(topics_excluded) && topics_excluded.length);
    if (!hasScope) {
      return res.json({ ok: true, verdict: 'na', note: 'No topic scope was given.' });
    }

    const topicsIncludedBlock = (Array.isArray(topics_included) && topics_included.length) ? topics_included.join(', ') : '(none specified)';
    const topicsExcludedBlock = (Array.isArray(topics_excluded) && topics_excluded.length) ? topics_excluded.join(', ') : '(none specified)';

    const systemPrompt =
      'Check ONLY whether a question stays within a given syllabus scope — nothing else. Allowed topics = the ' +
      'included list (or everything except the excluded list). Fail if the core logic/algorithm/data structure, ' +
      'any built-in shortcut, or wording in the statement requires something out of scope.\n\n' +
      'Return ONLY a single JSON object (no markdown fences, no prose outside it):\n' +
      '{ "verdict": "pass|fail|warn", "note": "<one short sentence — the specific topic and where it appears, if not pass>" }';

    const userPrompt =
      'TOPICS THAT SHOULD BE INCLUDED: ' + topicsIncludedBlock + '\n' +
      'FUTURE/OUT-OF-SCOPE TOPICS: ' + topicsExcludedBlock + '\n\n' +
      'QUESTION TYPE: ' + (question_type || 'unknown') + '\n' +
      'PROBLEM STATEMENT:\n' + (question_text || '(none)') + '\n\n' +
      'SOLUTION CODE (if any):\n' + (solution_code || '(none)') + '\n\n' +
      'Return the JSON now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }

    const parsed = parseAiJson(result.content);
    if (!parsed || !parsed.verdict) {
      return res.json({ ok: false, raw: result.content, model_used: result.provider + '/' + result.model, error: 'Could not parse AI response as JSON' });
    }

    res.json({ ok: true, verdict: parsed.verdict, note: parsed.note || '', model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Topic alignment check failed', details: err.message });
  }
});

// ---- Phase 2 (on-demand only): full rectification text for specific flagged issues ----
// Kept as a separate, only-called-when-needed endpoint so token spend matches actual need —
// most questions have no fails/warns and never trigger this call at all.
app.post('/api/qc-rectify', async (req, res) => {
  try {
    const {
      question_text, input_format, output_format, constraints, sample_cases, hidden_test_cases, solution_code,
      question_type, mcq_data, debug_code, fix_needed   // fix_needed: [{area, severity, issue}] — the specific items to fix
    } = req.body;

    if (!question_text) {
      return res.status(400).json({ error: 'Missing question_text in request body' });
    }
    if (!Array.isArray(fix_needed) || !fix_needed.length) {
      return res.status(400).json({ error: 'Missing or empty fix_needed list' });
    }

    const fixList = fix_needed.map(function(f) {
      return '- [' + f.area + ', ' + f.severity + '] ' + f.issue;
    }).join('\n');

    const systemPrompt =
      'You write precise rectifications for flagged QC issues in coding/debug questions and MCQs. For EACH ' +
      'issue in the given list, rewrite ONLY the specific broken part — never the whole question.\n\n' +
      'IMPORTANT — output format: the portal\'s own fields (problem statement, input/output format) are stored ' +
      'as HTML, and this text will be pasted directly into that same rich-text editor. So write replacement_text ' +
      'as plain readable text, and ONLY wrap the parts that must be visually bold in real HTML <strong> tags — ' +
      'NEVER use markdown syntax like **bold** or __bold__, since it will not render and will show as literal ' +
      'asterisks in the editor. Most replacement_text will have no bold at all; only use <strong> where the ' +
      'template below calls for it or where genuinely emphasizing a key term helps (e.g. a variable name on ' +
      'first mention). Do not wrap the whole answer in a <p> tag — just plain text with occasional <strong> spans.\n\n' +
      'For "format" issues (input_format or output_format specifically), use these exact templates:\n\n' +
      'Input Format template:\n' +
      'The first line of input consists of a <strong>[datatype]</strong> <strong>[variable_name]</strong> representing [description].\n' +
      '(repeat per line; for arrays: an "n" count line + an "n integers separated by spaces" line; for ' +
      'multiple test cases: a "t" count line + a per-test-case block; for class attributes: one line per ' +
      'attribute)\n\n' +
      'Output Format template:\n' +
      'The first line of output prints "[message]" followed by the <strong>[variable_name]</strong> value [formatting, ' +
      'e.g. rounded to two decimal places].\n' +
      '(repeat per line as needed; for variable/multi-line outputs always end with: "Refer to the sample ' +
      'output for the formatting specifications.")\n' +
      'Rules for format templates: use variable names only, never example values; always state precision ' +
      'explicitly for floats/doubles.\n\n' +
      'For non-format issues (constraints, test_cases, answer_correct, only_one_correct, explanation_check, ' +
      'statement_code, syllabus_alignment) state the specific fix directly and concisely in plain text — no ' +
      'template needed, just exactly what to change it to. For a missing MCQ explanation specifically, write a ' +
      'complete, technically correct explanation of why the correct option is right (this is the actual content ' +
      'to paste in, not just an instruction to add one).\n\n' +
      'Return ONLY a single JSON object (no markdown fences, no prose outside it):\n' +
      '{\n' +
      '  "rectifications": [\n' +
      '    { "area": "<same area as the input item>", "where_to_replace": "<e.g. \'Replace the entire Input Format field\' or \'Replace the output rounding sentence\'>", "replacement_text": "<the exact ready-to-paste replacement content — plain text with <strong> only where needed, no markdown>" }\n' +
      '  ]\n' +
      '}\n' +
      'One rectification object per input issue, same order.';

    const userPrompt =
      'QUESTION TYPE: ' + (question_type || 'unknown') + '\n\n' +
      'PROBLEM STATEMENT:\n' + (question_text || '(none)') + '\n\n' +
      'CURRENT INPUT FORMAT:\n' + (input_format || '(none)') + '\n\n' +
      'CURRENT OUTPUT FORMAT:\n' + (output_format || '(none)') + '\n\n' +
      'CURRENT CONSTRAINTS (stated limits only):\n' + (constraints || '(none)') + '\n\n' +
      'SAMPLE TEST CASES:\n' + (sample_cases || '(none)') + '\n\n' +
      'HIDDEN TEST CASES:\n' + (hidden_test_cases || '(none)') + '\n\n' +
      'SOLUTION CODE:\n' + (solution_code || '(none)') + '\n\n' +
      'MCQ ANSWER/OPTION DATA (raw, if applicable):\n' + (mcq_data || '(none)') + '\n\n' +
      'ISSUES TO FIX:\n' + fixList + '\n\n' +
      'Return the JSON object now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }

    const parsed = parseAiJson(result.content);

    if (!parsed || !Array.isArray(parsed.rectifications)) {
      return res.json({ ok: false, raw: result.content, model_used: result.provider + '/' + result.model, error: 'Could not parse AI response as JSON' });
    }

    res.json({ ok: true, rectifications: parsed.rectifications, model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Rectification failed', details: err.message });
  }
});

// ---- AI Test Packer: pick questions from a candidate pool to satisfy a spec ----
app.post('/api/pack-test', async (req, res) => {
  try {
    const { candidates, requirement } = req.body;
    // candidates: [{q_id, qb_name, question_type, topic, sub_topic, difficulty, priority_tier, summary}]
    // requirement: { language, mcq: {count, topics, difficulty}, coding: {count, topics, difficulty} }

    if (!Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ error: 'Missing or empty candidates list' });
    }
    if (!requirement) {
      return res.status(400).json({ error: 'Missing requirement spec' });
    }

    const candidateBlock = candidates.map(function(c) {
      return '- [' + c.q_id + '] type=' + c.question_type + ' | topic=' + (c.topic || '-') +
        ' / ' + (c.sub_topic || '-') + ' | difficulty=' + (c.difficulty || '-') +
        ' | priority_tier=' + c.priority_tier + ' | qb=' + c.qb_name +
        ' | summary=' + (c.summary || '').slice(0, 150);
    }).join('\n');

    const systemPrompt =
      'You are an assessment test packer. You are given a pool of candidate questions and a requirement ' +
      'spec (how many MCQ vs Coding questions are needed, which topics to cover, and which difficulty levels ' +
      'are acceptable). Your job is to SELECT exactly the right number of question IDs from the pool that best ' +
      'satisfy the spec.\n\n' +
      'Selection rules, in order of importance:\n' +
      '1. Match question_type exactly (MCQ requests must be filled by type mcq/MCQ-like questions; Coding ' +
      'requests must be filled by type programming/coding questions).\n' +
      '2. Only pick questions whose difficulty is in the requested difficulty set (e.g. "Easy and Medium" means ' +
      'only Easy or Medium difficulty questions qualify, exclude Hard).\n' +
      '3. Cover the requested topics as evenly as possible ("Mixed" means spread across ALL listed topics, not ' +
      'just one) — try to split the count roughly evenly across the given topics.\n' +
      '4. Among qualifying candidates, PREFER lower priority_tier number first (0 = best/most-verified, higher ' +
      'numbers = less verified) — always prefer more-verified questions when you have a choice.\n' +
      '5. Never pick the same q_id twice. Never pick more or fewer than the exact count requested for each ' +
      'category unless there are literally not enough qualifying candidates in the pool — in that case pick as ' +
      'many as qualify and note the shortfall.\n\n' +
      'Return ONLY a single JSON object (no markdown fences, no prose outside JSON):\n' +
      '{\n' +
      '  "mcq_selected": ["<q_id>", ...],\n' +
      '  "coding_selected": ["<q_id>", ...],\n' +
      '  "shortfall_notes": "<empty string, or a short note if any category could not be fully filled>",\n' +
      '  "topic_distribution_summary": "<one short line per category showing how many of each topic was picked>"\n' +
      '}';

    const userPrompt =
      'LANGUAGE: ' + (requirement.language || 'any') + '\n\n' +
      'MCQ REQUIREMENT: need ' + (requirement.mcq && requirement.mcq.count) + ' questions, ' +
      'topics: ' + (requirement.mcq && requirement.mcq.topics) + ', ' +
      'difficulty: ' + (requirement.mcq && requirement.mcq.difficulty) + '\n\n' +
      'CODING REQUIREMENT: need ' + (requirement.coding && requirement.coding.count) + ' questions, ' +
      'topics: ' + (requirement.coding && requirement.coding.topics) + ', ' +
      'difficulty: ' + (requirement.coding && requirement.coding.difficulty) + '\n\n' +
      'CANDIDATE POOL (' + candidates.length + ' questions):\n' + candidateBlock + '\n\n' +
      'Return the JSON selection now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }

    const content = result.content;
    let parsed = null;
    try {
      const cleaned = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '');
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      parsed = null;
    }

    if (!parsed) {
      return res.json({ ok: false, raw: content, model_used: result.provider + '/' + result.model, error: 'Could not parse AI response as JSON' });
    }

    res.json({ ok: true, packing: parsed, model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Test packing failed', details: err.message });
  }
});

// ---- AI-assisted QB name matching (handles naming variants like "array" / "1d array" / "Array 1d") ----
// One AI call per search batch (not per QB) — efficient, since it's a single prompt with the whole name list.
app.post('/api/match-qbs-ai', async (req, res) => {
  try {
    const { qb_list, topics } = req.body;
    if (!Array.isArray(qb_list) || !qb_list.length) {
      return res.status(400).json({ error: 'Missing or empty qb_list' });
    }
    if (!Array.isArray(topics) || !topics.length) {
      return res.json({ ok: true, matched_qb_ids: qb_list.map(function(q) { return q.qb_id; }) }); // no topic filter requested
    }

    const listBlock = qb_list.map(function(q) { return '- [' + q.qb_id + '] ' + q.qb_name; }).join('\n');

    const systemPrompt =
      'You match question bank names against requested topics. Question bank names use inconsistent, ' +
      'informal naming — the same topic can appear as "array", "1d array", "Array 1d", "arrays", "1D-Array", ' +
      '"single array", etc. Treat these as equivalent when they clearly refer to the same underlying concept. ' +
      'Given a list of question bank names and a list of requested topics, return ONLY a JSON object (no ' +
      'markdown, no prose) with this shape:\n' +
      '{ "matched_qb_ids": ["<qb_id>", ...] }\n' +
      'Include a qb_id if its name plausibly relates to ANY of the requested topics, accounting for naming ' +
      'variants, abbreviations, and word order differences. Exclude names that are clearly unrelated.';

    const userPrompt =
      'REQUESTED TOPICS: ' + topics.join(', ') + '\n\n' +
      'QUESTION BANK NAMES:\n' + listBlock + '\n\n' +
      'Return the JSON now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }

    let parsed = null;
    try {
      const cleaned = result.content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = null;
    }

    if (!parsed || !Array.isArray(parsed.matched_qb_ids)) {
      return res.json({ ok: false, error: 'Could not parse AI response', raw: result.content });
    }

    res.json({ ok: true, matched_qb_ids: parsed.matched_qb_ids, model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'QB matching failed', details: err.message });
  }
});

// ---- Aptitude distribution: map QBs to canonical topics, spread count across QBs ----
app.post('/api/aptitude-distribute', async (req, res) => {
  try {
    const { qb_list, canonical_topics, total_count } = req.body;
    if (!Array.isArray(qb_list) || !qb_list.length) {
      return res.status(400).json({ error: 'Missing or empty qb_list' });
    }
    if (!total_count || total_count <= 0) {
      return res.status(400).json({ error: 'total_count must be > 0' });
    }

    const listBlock = qb_list.map(function(q) { return '- [' + q.qb_id + '] ' + q.qb_name; }).join('\n');
    const topicsBlock = (Array.isArray(canonical_topics) ? canonical_topics : []).join(', ');

    const systemPrompt =
      'You distribute a total question count across multiple question banks (QBs) for an aptitude test, ' +
      'maximizing topic diversity. Each QB name maps to one topic from a canonical list, but naming is ' +
      'inconsistent (e.g. "apt_qa_PnL" or "Profit_Loss_Discount" both mean "Profit, Loss & Discount"; ' +
      '"apt_ra_bloodrel" means "Blood Relations"). Match each QB to the closest canonical topic using ' +
      'semantic judgment, not exact string matching.\n\n' +
      'Then allocate the total_count across QBs so that:\n' +
      '1. As many DIFFERENT topics are covered as possible (prefer breadth over depth).\n' +
      '2. Each selected QB gets 2 or 3 questions (never more than 3, never fewer than 2, unless total_count ' +
      'is too small to allow that, in which case use 1 per QB).\n' +
      '3. The sum of all allocated counts equals total_count exactly if enough QBs exist; otherwise get as ' +
      'close as possible and note the shortfall.\n' +
      '4. Do not reuse a QB twice in the allocation list.\n\n' +
      'Return ONLY a JSON object (no markdown, no prose):\n' +
      '{\n' +
      '  "allocations": [ { "qb_id": "<id>", "topic_guess": "<canonical topic name>", "count": <int> }, ... ],\n' +
      '  "notes": "<empty string, or a short note about any shortfall>"\n' +
      '}';

    const userPrompt =
      'CANONICAL TOPICS: ' + topicsBlock + '\n\n' +
      'TOTAL QUESTIONS NEEDED: ' + total_count + '\n\n' +
      'AVAILABLE QUESTION BANKS:\n' + listBlock + '\n\n' +
      'Return the JSON allocation now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }

    let parsed = null;
    try {
      const cleaned = result.content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = null;
    }

    if (!parsed || !Array.isArray(parsed.allocations)) {
      return res.json({ ok: false, error: 'Could not parse AI response', raw: result.content });
    }

    res.json({ ok: true, allocations: parsed.allocations, notes: parsed.notes || '', model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Aptitude distribution failed', details: err.message });
  }
});

// ---- Image proxy: the exam media bucket blocks cross-origin BROWSER requests (CORS/hotlink
// protection), but that restriction only applies to the browser — a server-to-server fetch
// isn't subject to it at all. So this fetches the image here and streams the bytes back
// through our own origin, letting <img> tags load it without the browser ever talking to S3
// directly. Restricted to AWS's own S3 hosts so this can't be used as an open image proxy.
app.get('/api/image-proxy', async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: 'Missing url query param' });

    let parsed;
    try { parsed = new URL(target); } catch (e) { return res.status(400).json({ error: 'Invalid url' }); }
    const hostOk = parsed.hostname === 's3.amazonaws.com' || parsed.hostname.endsWith('.amazonaws.com');
    if (!hostOk) return res.status(400).json({ error: 'URL host not allowed' });

    const upstreamRes = await fetch(target);
    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).json({ error: 'Upstream image fetch failed: ' + upstreamRes.status });
    }

    const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Image proxy failed', details: err.message });
  }
});


// ==========================================================================
// SOLUTION FORGE — generate a solution in another language, verify it against
// the question's own test cases by actually running it, then push it back.
// ==========================================================================

// Local execution + toolchain probe live in their own module.
app.use('/api', require('./routes-execute'));
// Topic Alignment report history (Postgres-backed, optional).
app.use('/api', require('./routes-history'));

// The portal's COMPLETE language catalogue, in the exact order its own UI
// sends it. CONFIRMED from a captured 200 PUT for question 8f53f0ab-…, where
// both `multilanguage` and `solution` carry all 26 entries (`solutiondata: []`
// for the ones with no solution yet).
//
// An earlier six-entry list here — ['Python','Java','Java17','Java21','C++','C']
// — was taken from one question's `multilanguage` and wrongly assumed to be
// the whole catalogue. It isn't: that field reflects what a single question
// currently offers, not what the portal supports. Note the versioned Java
// variants have no space or parentheses, and there are separate
// "Python3.12" / "C++c++11" / "Cc++11" entries.
const PORTAL_LANGUAGES = [
  'Java', 'Bash', 'C++', 'C', 'C#', 'Clojure', 'Go', 'Dotnet', 'Java_jdbc',
  'MySQL', 'Objective-C', 'Perl', 'PHP', 'C++c++11', 'Java21', 'Java17',
  'Kotlin', 'Python3.12', 'MySQL Verbose', 'Cc++11', 'R', 'VB.NET', 'Ruby',
  'Rust', 'Python', 'Plain Javascript'
];

// Of those, the ones Solution Forge can actually compile/run locally — and so
// the only ones it can ever verify, and therefore ever push. Kept in step with
// RUNNER_KIND in routes-execute.js.
const VERIFIABLE_LANGUAGES = [
  'Python', 'Python3.12', 'Java', 'Java17', 'Java21',
  'C', 'Cc++11', 'C++', 'C++c++11', 'Plain Javascript'
];

app.get('/api/solution-languages', (_req, res) => res.json({
  ok: true,
  languages: PORTAL_LANGUAGES,
  verifiable: VERIFIABLE_LANGUAGES
}));

// Language-specific conventions the generated code must follow to be runnable
// both locally and on the portal's own judge.
// Per-language rules the generated code must follow to run both locally and
// on the portal's judge — including the portal's actual language VERSION,
// which is older than the local toolchain for several of these. Getting that
// wrong produces code that verifies here and fails there.
//
// Keyed on the exact portal language name. Substring matching was a bug:
// 'plain javascript'.includes('java') is true, so JavaScript was being told
// to write a `public class Main`.
const LANG_CONVENTIONS = {
  'java': 'Java: the entry point MUST be `public class Main` with `public static void main(String[] args)`. ' +
    'Read from standard input with Scanner or BufferedReader. Do not declare a package.',
  'java17': 'Java 17: the entry point MUST be `public class Main` with `public static void main(String[] args)`. ' +
    'Read from standard input with Scanner or BufferedReader. Do not declare a package. ' +
    'Target Java 17 — do not use any language feature newer than 17.',
  'java21': 'Java 21: the entry point MUST be `public class Main` with `public static void main(String[] args)`. ' +
    'Read from standard input with Scanner or BufferedReader. Do not declare a package. ' +
    'Target Java 21 — do not use preview features.',
  'c': 'C (C17): provide a complete program with #include directives and `int main(void)`. ' +
    'Read from stdin with scanf/fgets. It is compiled with `-std=c17`, so use no feature newer than C17.',
  'c++': 'C++ (C++17): provide a complete program with #include directives and `int main()`. ' +
    'Read from stdin with cin/scanf. It is compiled with `-std=c++17`, so use no feature newer than C++17 — ' +
    'no std::print, no std::format, no ranges. Finish the output with `<< endl` or `<< "\\n"` — ' +
    'a bare `cout << answer;` leaves off the trailing newline and the judge marks it wrong.',
  'python': 'Python 3.8: a complete script reading from stdin via input() or sys.stdin. No function-only answers — ' +
    'it must run top-level. Target 3.8 exactly: NO match statements, no dict | merge, no walrus in comprehension ' +
    'edge cases, no list[int]/dict[str,int] builtin generics (use typing.List/typing.Dict if you need them).',
  'python3.12': 'Python 3.12: a complete script reading from stdin via input() or sys.stdin. No function-only ' +
    'answers — it must run top-level.',
  'plain javascript': 'JavaScript on Node 10: a complete script that reads ALL of stdin ' +
    '(e.g. `require("fs").readFileSync(0, "utf8")`) and prints with console.log. ' +
    'Target Node 10 — no optional chaining (?.), no nullish coalescing (??), no top-level await.'
};

function langConventions(language) {
  return LANG_CONVENTIONS[String(language || '').trim().toLowerCase()] ||
    'Provide a complete, runnable program that reads from standard input and writes to standard output.';
}

const SOLUTION_RULES =
  'You port an existing, already-correct programming-question solution into a different language.\n\n' +
  'HARD REQUIREMENTS:\n' +
  '- Reproduce the SAME behaviour as the reference solution: identical output for identical input.\n' +
  '- Match the expected output EXACTLY — spacing, capitalisation, punctuation, line breaks, decimal places. ' +
  'A judge compares text literally; "Match" and "match" are different answers.\n' +
  '- Read input in exactly the order and format the input format describes.\n' +
  '- Print nothing extra: no prompts, no banners, no "Enter a number:", no trailing explanation.\n' +
  '- END THE OUTPUT WITH A NEWLINE. The expected outputs end with "\\n" and the judge compares it, so a ' +
  'final line printed without a newline is marked wrong even though the text is right. Use the ' +
  'newline-terminating call: println / endl or "\\n" in printf / print() / console.log — never a bare ' +
  'cout << x; or print(x, end="") as the last statement.\n' +
  '- Handle the stated constraints without overflowing or timing out.\n\n' +
  'OUTPUT FORMAT: return ONLY the raw source code. No markdown fences, no commentary, no leading language name. ' +
  'The very first character must be the first character of the program.';

// Strips a markdown fence if the model added one despite being told not to.
function stripCodeFence(text) {
  let s = String(text || '').trim();
  const fence = s.match(/^```[a-zA-Z0-9+#]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) s = fence[1];
  return s.replace(/^```[a-zA-Z0-9+#]*\s*/, '').replace(/```$/, '').trim();
}

function casesBlock(testcases) {
  if (!Array.isArray(testcases) || !testcases.length) return '(none provided)';
  return testcases.slice(0, 6).map((t, i) =>
    '--- ' + (t.label || ('Case ' + (i + 1))) + ' ---\nINPUT:\n' + (t.input ?? '') + '\nEXPECTED OUTPUT:\n' + (t.output ?? '')
  ).join('\n');
}

// POST /api/translate-solution — port a reference solution into a target language.
app.post('/api/translate-solution', async (req, res) => {
  try {
    const {
      target_language, reference_code, reference_language,
      question_text, input_format, output_format, constraints, testcases,
      previous_attempt, previous_failure
    } = req.body || {};
    if (!target_language) return res.status(400).json({ error: 'Missing target_language' });
    if (!reference_code && !question_text) {
      return res.status(400).json({ error: 'Need either reference_code or question_text to work from' });
    }

    // On a restart, the earlier attempt and exactly how it failed are handed
    // back. Patching one bad attempt over and over tends to converge on
    // nothing — a genuinely fresh attempt that KNOWS what already failed is
    // far more likely to land, and stops the model rediscovering the same
    // dead end.
    const retryBlock = previous_attempt
      ? '\n\nA PREVIOUS ATTEMPT IN THIS LANGUAGE ALREADY FAILED. Do not repeat it.\n' +
        'What was tried:\n```\n' + String(previous_attempt).slice(0, 4000) + '\n```\n' +
        'How it failed (this is real measured output, not a guess):\n' +
        String(previous_failure || '(no detail captured)').slice(0, 2000) + '\n' +
        'Write a DIFFERENT solution — rethink the approach rather than patching the code above.\n'
      : '';

    const userPrompt =
      'TARGET LANGUAGE: ' + target_language + '\n' +
      langConventions(target_language) + '\n\n' +
      'PROBLEM STATEMENT:\n' + (question_text || '(none)') + '\n\n' +
      'INPUT FORMAT:\n' + (input_format || '(none)') + '\n\n' +
      'OUTPUT FORMAT:\n' + (output_format || '(none)') + '\n\n' +
      'CONSTRAINTS:\n' + (constraints || '(none)') + '\n\n' +
      'REFERENCE SOLUTION' + (reference_language ? ' (' + reference_language + ')' : '') + ':\n' +
      (reference_code || '(none — write it from the statement)') + '\n\n' +
      'TEST CASES IT MUST PASS:\n' + casesBlock(testcases) +
      retryBlock + '\n\n' +
      'Return only the ' + target_language + ' source code now.';

    const result = await callAi([
      { role: 'system', content: SOLUTION_RULES },
      { role: 'user', content: userPrompt }
    ]);
    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }
    res.json({ ok: true, code: stripCodeFence(result.content), model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Solution generation failed', details: err.message });
  }
});

// POST /api/fix-solution — repair a solution using the REAL failure output from
// a local run. This is the key to the loop: the model is given the actual
// expected-vs-actual mismatch (or compiler error), never asked to guess.
app.post('/api/fix-solution', async (req, res) => {
  try {
    const {
      language, code, compile_error, failures,
      question_text, input_format, output_format, constraints
    } = req.body || {};
    if (!language || !code) return res.status(400).json({ error: '"language" and "code" are required' });

    const failureBlock = compile_error
      ? 'IT DID NOT COMPILE. Compiler output:\n' + compile_error
      : (Array.isArray(failures) && failures.length
          ? 'IT COMPILED BUT FAILED THESE TEST CASES (this is real measured output, not a guess):\n' +
            failures.slice(0, 5).map(f =>
              '--- ' + (f.label || ('Case ' + (f.index + 1))) + ' ---\n' +
              'INPUT:\n' + (f.input ?? '(none)') + '\n' +
              // JSON-quoted so an invisible difference is actually visible:
              // a missing trailing newline renders as identical text
              // otherwise, and the model "fixes" something that isn't wrong.
              'EXPECTED (exact, quoted):\n' + JSON.stringify(f.expected ?? '') + '\n' +
              'ACTUAL (exact, quoted):\n' + (f.actual == null ? '(no output)' : JSON.stringify(f.actual)) +
              (f.note ? '\nDIAGNOSIS: ' + f.note : '') +
              (f.error ? '\nRUNTIME ERROR: ' + f.error : '') +
              (f.stderr ? '\nSTDERR: ' + f.stderr : '')
            ).join('\n')
          : 'It failed, but no specific failure detail was captured.');

    const systemPrompt =
      'You fix a programming solution that has been RUN and demonstrably failed. You are given the exact ' +
      'compiler error or the exact expected-vs-actual mismatch.\n\n' +
      'Diagnose the specific cause from that evidence and fix it. Common real causes: output text/case/spacing ' +
      'not matching exactly, reading input in the wrong order or wrong count, an off-by-one, wrong rounding or ' +
      'decimal places, printing extra prompt text, or a missing include/import.\n\n' +
      'Keep the overall approach unless it is fundamentally wrong. Change what the evidence shows is broken.\n\n' +
      SOLUTION_RULES;

    const userPrompt =
      'LANGUAGE: ' + language + '\n' + langConventions(language) + '\n\n' +
      'PROBLEM STATEMENT:\n' + (question_text || '(none)') + '\n\n' +
      'INPUT FORMAT:\n' + (input_format || '(none)') + '\n\n' +
      'OUTPUT FORMAT:\n' + (output_format || '(none)') + '\n\n' +
      'CONSTRAINTS:\n' + (constraints || '(none)') + '\n\n' +
      'CURRENT CODE:\n' + code + '\n\n' + failureBlock + '\n\n' +
      'Return only the corrected ' + language + ' source code now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
    if (!result.ok) {
      return res.status(500).json(aiFailureBody(result));
    }
    res.json({ ok: true, code: stripCodeFence(result.content), model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Solution fix failed', details: err.message });
  }
});

// POST /api/translate-fragment — port a header/footer/codeStub fragment. These
// are NOT full programs, so they get their own narrower prompt; a question that
// never had them must never have them invented (the client only calls this when
// there is real existing content).
app.post('/api/translate-fragment', async (req, res) => {
  try {
    const { target_language, fragment, kind, reference_language } = req.body || {};
    if (!target_language || !fragment) return res.status(400).json({ error: '"target_language" and "fragment" are required' });

    const systemPrompt =
      'You port a CODE FRAGMENT (not a whole program) into another language. It is part of a code-snippet ' +
      'question: a fixed ' + (kind || 'fragment') + ' that wraps or scaffolds the student\'s own code.\n\n' +
      '- Keep it a fragment. Do not add a main() or complete the program unless the original already had one.\n' +
      '- Preserve its role exactly: the same declarations, includes, class opening/closing, or stub signature.\n' +
      '- For a codeStub, KEEP any intentional bug or blank the original contains — that is the exercise.\n' +
      '- Preserve indentation.\n\n' +
      'Return ONLY the ported fragment. No fences, no commentary.';

    const userPrompt =
      'TARGET LANGUAGE: ' + target_language + '\n' +
      'FRAGMENT KIND: ' + (kind || 'unknown') + '\n' +
      'ORIGINAL' + (reference_language ? ' (' + reference_language + ')' : '') + ':\n' + fragment + '\n\n' +
      'Return only the ported fragment now.';

    const result = await callAi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
    if (!result.ok) return res.status(500).json(aiFailureBody(result));
    res.json({ ok: true, fragment: stripCodeFence(result.content), model_used: result.provider + '/' + result.model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fragment translation failed', details: err.message });
  }
});

// PUT /api/question-solution/:id — write solution(s) back to the portal.
//
// Endpoint and payload CONFIRMED against a real captured "edit solution" PUT
// from the portal's own UI (200 OK):
//   PUT https://api.examly.io/api/update_programming_question/{q_id}
//
// The body is FLAT and the portal's schema for it is strict (.unknown(false)
// style) — a live 400 confirmed that q_id / question_id / qb_id /
// questionbank_id are "not allowed" in the body at all; the id lives only in
// the URL. So this rebuilds the exact flat shape rather than forwarding the
// fetched question object as-is.
//
// Field-name quirks worth knowing (all confirmed, all easy to get wrong):
//   - body uses `inputformat` / `outputformat` / `codeconstraints` (no
//     underscores) but reads from programming_question.input_format /
//     output_format / code_constraints (WITH underscores).
//   - `testcases` must be a parsed ARRAY here, even though the list endpoint
//     returns it as a JSON string.
//   - `sample_io` stays a STRING.
//   - `tags` must be an array of plain name strings, never [] — the capture
//     sent [''] when there were none.
const EXAMLY_SOLUTION_PUSH_API = 'https://api.examly.io/api/update_programming_question';

function portalTagNames(raw) {
  if (Array.isArray(raw.tags)) {
    const names = raw.tags.map(t => (typeof t === 'string' ? t : (t && t.name))).filter(Boolean);
    if (names.length) return names;
  }
  return [];
}

app.put('/api/question-solution/:id', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    if (!token) return res.status(400).json({ error: 'Missing Authorization header' });

    // `solutions` is the multi-language form: [{ language, code, best, snippet }].
    // `language`/`code` remain accepted for a single push.
    const { language, code, rawQuestion, snippet, bestLanguage } = req.body || {};
    const incoming = Array.isArray(req.body && req.body.solutions) && req.body.solutions.length
      ? req.body.solutions
      : (language && code ? [{ language, code, snippet }] : []);

    if (!incoming.length) {
      return res.status(400).json({ error: 'Provide either { language, code } or a non-empty { solutions: [...] }' });
    }
    if (!rawQuestion) return res.status(400).json({ error: 'Missing rawQuestion — needed to rebuild the full save payload' });

    const raw = rawQuestion;
    const pq = raw.programming_question || {};
    const solutions = Array.isArray(pq.solution) ? JSON.parse(JSON.stringify(pq.solution)) : [];

    // Which language ends up flagged "Best Solution". It's a single choice
    // across the WHOLE question (a live capture confirmed only one is ever
    // true at a time), so every other flag is cleared first — otherwise the
    // portal ends up with two languages both marked best.
    const explicitBest = bestLanguage || (incoming.find(s => s.best) || {}).language;
    const bestLang = explicitBest || incoming[incoming.length - 1].language;

    solutions.forEach(sol => {
      if (Array.isArray(sol.solutiondata)) sol.solutiondata.forEach(sd => { sd.solutionbest = false; });
    });

    for (const item of incoming) {
      if (!item || !item.language || !item.code) continue;
      const idx = solutions.findIndex(s => String(s.language).toLowerCase() === String(item.language).toLowerCase());
      const existing = idx !== -1 ? solutions[idx] : null;
      const isBest = String(item.language).toLowerCase() === String(bestLang).toLowerCase();

      // Snippet fields are detected on real CONTENT, never on the hasSnippet
      // flag alone — a live capture confirmed the two can disagree. A question
      // that never had them must never have them invented.
      const inc = item.snippet || {};
      const hasSnippetContent = !!(inc.header || inc.footer || inc.codeStub) ||
        !!(existing && (existing.header || existing.footer || existing.codeStub));

      const entry = {
        language: item.language,
        solutiondata: [{
          solution: item.code, solutionExp: null, solutionbest: isBest,
          isSolutionExp: false, solutionDebug: null
        }]
      };
      if (hasSnippetContent) {
        entry.hasSnippet = inc.hasSnippet != null ? !!inc.hasSnippet : !!(existing && existing.hasSnippet);
        const h = inc.header != null ? inc.header : ((existing && existing.header) || '');
        const f = inc.footer != null ? inc.footer : ((existing && existing.footer) || '');
        if (h) entry.header = h;
        if (f) entry.footer = f;
        entry.codeStub = inc.codeStub != null ? inc.codeStub : ((existing && existing.codeStub) || '');
        entry.hideHeader = existing ? !!existing.hideHeader : false;
        entry.hideFooter = existing ? !!existing.hideFooter : false;
      } else {
        entry.hasSnippet = false;
        entry.codeStub = '';
        entry.hideHeader = false;
        entry.hideFooter = false;
      }

      if (idx === -1) solutions.push(entry);
      else solutions[idx] = Object.assign({}, solutions[idx], entry);
    }

    // Round the solution array out to the portal's full catalogue, matching
    // what its own UI sends (confirmed capture). Languages already present
    // keep their position and content; everything else is appended as an
    // empty placeholder so the question keeps offering all of them.
    // Send ONLY the languages that actually carry a solution: the ones the
    // question already had, plus the ones just generated. Empty placeholders
    // are dropped.
    //
    // The portal's own UI sends all 26 catalogue entries with
    // `solutiondata: []` for the unused ones (confirmed capture), and this
    // deliberately does NOT copy that: enabling every language on a question
    // that only has two real solutions is noise. Existing solutions are never
    // touched, so this only ever removes empty placeholders — the question
    // keeps offering exactly the languages it can actually answer in.
    const withSolution = solutions.filter(s =>
      s && s.language && Array.isArray(s.solutiondata) &&
      s.solutiondata.some(d => d && typeof d.solution === 'string' && d.solution.trim())
    );

    solutions.length = 0;
    solutions.push(...withSolution);

    // /api/v2/questionfilter never returns `multilanguage` inside
    // programming_question, so merging against it silently collapsed the list
    // to just the language being pushed, losing the ones already there.
    // Derived from the solution array instead, so it always matches the
    // languages actually being saved: existing + newly generated.
    const seen = {};
    const multilanguage = solutions.map(s => s.language).filter(l => {
      if (!l) return false;
      const k = String(l).toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });

    // testcases: array here, even though the list endpoint hands back a string.
    let testcases = [];
    if (Array.isArray(pq.testcases)) testcases = pq.testcases;
    else if (typeof pq.testcases === 'string' && pq.testcases) {
      try { testcases = JSON.parse(pq.testcases); } catch { testcases = []; }
    }

    const tags = portalTagNames(raw);

    // This PUT rewrites the WHOLE question, not just its solutions — so every
    // non-solution field here is a pass-through of what was fetched. Falling
    // back to '' when a field isn't found would silently ERASE the question's
    // real statement/format text on the portal. Instead: look through the
    // shapes these fields are known to arrive in and, if genuinely absent,
    // omit the key entirely so the portal keeps whatever it already has.
    const answer = (raw.entity && raw.entity.answer) || {};
    const learning = (raw.entity && raw.entity.learning) || {};
    function passthrough(...candidates) {
      for (const v of candidates) if (v !== undefined) return v;
      return undefined;
    }
    const inputformat = passthrough(pq.input_format, answer.input_format, raw.input_format, raw.inputformat);
    const outputformat = passthrough(pq.output_format, answer.output_format, raw.output_format, raw.outputformat);
    const question_data = passthrough(raw.question_data, learning.question_data);
    const omittedFields = [['inputformat', inputformat], ['outputformat', outputformat], ['question_data', question_data]]
      .filter(([, v]) => v === undefined).map(([k]) => k);
    if (omittedFields.length) {
      console.log('[PUSH] WARN q=' + req.params.id + ' omitting unresolved pass-through field(s): ' +
        omittedFields.join(', ') + ' — left untouched rather than blanked.');
    }

    const body = {
      question_data,
      manual_difficulty: raw.manual_difficulty || undefined,
      inputformat,
      outputformat,
      // Real field is code_constraints (underscored) under programming_question.
      // null is preserved as null — the capture sent null, and coercing it to
      // '' is a needless edit to a field this push has no business changing.
      codeconstraints: passthrough(pq.code_constraints, answer.code_constraints, raw.codeconstraints),
      sample_io: pq.sample_io != null ? pq.sample_io : '[]',
      testcases,
      multilanguage,
      // Forward the question's real editor type untouched; only default when
      // the fetched object genuinely lacks it.
      question_editor_type: raw.question_editor_type != null ? raw.question_editor_type : 1,
      solution: solutions,

      blooms_taxonomy: raw.blooms_taxonomy != null ? raw.blooms_taxonomy : null,
      codesize: raw.codesize != null ? raw.codesize : (pq.code_size != null ? pq.code_size : null),
      course_outcome: raw.course_outcome != null ? raw.course_outcome : null,
      createdBy: raw.createdBy || raw.created_by || undefined,
      enable_api: pq.enable_api != null ? pq.enable_api : (raw.enable_api != null ? raw.enable_api : false),
      enablecustominput: pq.enablecustominput != null ? pq.enablecustominput : true,
      hint: Array.isArray(raw.hint) ? raw.hint : [],
      line_token_evaluation: pq.line_token_evaluation != null ? pq.line_token_evaluation : false,
      linked_concepts: raw.linked_concepts != null ? raw.linked_concepts : '',
      memorylimit: raw.memorylimit != null ? raw.memorylimit : (pq.memory_limit != null ? pq.memory_limit : null),
      outputLimit: raw.outputLimit != null ? raw.outputLimit : (pq.output_limit != null ? pq.output_limit : null),
      pcm_combination_ids: Array.isArray(raw.pcm_combination_ids) ? raw.pcm_combination_ids : [],
      program_outcome: raw.program_outcome != null ? raw.program_outcome : null,
      question_media: Array.isArray(raw.question_media) ? raw.question_media : [],
      setLimit: pq.setLimit != null ? pq.setLimit : false,
      sub_topic_id: raw.sub_topic_id || (raw.sub_topic && (raw.sub_topic.sub_topic_id || raw.sub_topic.id)) || undefined,
      subject_id: raw.subject_id || (raw.subject && (raw.subject.subject_id || raw.subject.id)) || undefined,
      tags: tags.length ? tags : [''],
      timelimit: raw.timelimit != null ? raw.timelimit : (pq.run_time_limit != null ? pq.run_time_limit : null),
      topic_id: raw.topic_id || (raw.topic && (raw.topic.topic_id || raw.topic.id)) || undefined
    };

    // Any key still undefined is silently DROPPED by JSON.stringify, so the
    // portal sees a body missing that field entirely. The captured 200 sent
    // all 30, so a dropped key is the first thing to suspect on a rejection —
    // several of them (subject_id / topic_id / sub_topic_id / createdBy /
    // manual_difficulty) only exist on some of the shapes a question can
    // arrive in.
    const droppedKeys = Object.keys(body).filter(k => body[k] === undefined);

    console.log('[PUSH] q=' + req.params.id + ' langs=' + incoming.map(s => s.language).join(',') +
                ' best=' + bestLang + ' multilanguage=' + multilanguage.join(','));
    if (droppedKeys.length) {
      console.log('[PUSH] NOTE dropped (undefined) keys: ' + droppedKeys.join(', ') +
                  ' — the captured 200 sent all 30 fields.');
    }

    const upstreamRes = await fetch(EXAMLY_SOLUTION_PUSH_API + '/' + encodeURIComponent(req.params.id), {
      method: 'PUT',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify(body)
    });

    const text = await upstreamRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!upstreamRes.ok) {
      // Surface the portal's own message — its schema errors name the exact
      // offending field, which is the only useful thing when a save is
      // refused. Also dump what WE sent: a rejection is nearly always a
      // field that's missing, null, or the wrong type, and guessing at it
      // from the outside wastes far more time than logging it here.
      console.log('[PUSH] REJECTED ' + upstreamRes.status + ': ' + text.slice(0, 1000));
      console.log('[PUSH] sent keys: ' + Object.keys(body).sort().join(', '));
      console.log('[PUSH] sent field summary: ' + JSON.stringify(
        Object.fromEntries(Object.entries(body).map(([k, v]) => [
          k,
          v === null ? 'null'
            : v === undefined ? 'undefined'
              : Array.isArray(v) ? 'array(' + v.length + ')'
                : typeof v === 'string' ? 'string(' + v.length + ')'
                  : typeof v
        ]))
      ));
      if (omittedFields.length) console.log('[PUSH] omitted pass-through fields: ' + omittedFields.join(', '));

      return res.status(upstreamRes.status).json({
        error: 'Portal rejected the save',
        status: upstreamRes.status,
        portalMessage: (data && (data.message || data.error)) || text.slice(0, 300),
        omittedFields,
        droppedKeys,
        sentKeys: Object.keys(body).sort(),
        details: data
      });
    }

    res.json({ ok: true, languages: multilanguage, bestLanguage: bestLang, response: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Solution push failed', details: err.message });
  }
});

// ==========================================================================
// QB ORGANISER — split one mixed question bank into topic-based banks.
//
// Endpoints below are all CONFIRMED from live Network-tab captures.
// ==========================================================================

const EXAMLY_QB_CREATE_API = 'https://api.examly.io/api/questionbank/create';
const EXAMLY_QB_UPDATE_API = 'https://api.examly.io/api/questionbanks/singleUpdate';
const EXAMLY_QUESTION_MOVE_API = 'https://api.examly.io/api/questionMove';

// POST /api/qb/move  { q_ids: [], q_types: [], qb_id, current_qb_id }
//
// Upstream is a GET with everything in the query string (yes, a mutating GET
// — that is what the portal does). Exposed here as a POST so long ID lists
// travel in a body instead of our own URL.
//
// q_type is POSITIONAL: it must line up index-for-index with q_id. The
// client sends one batch per question type so a mismatch can't scramble a
// mixed request.
app.post('/api/qb/move', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    if (!token) return res.status(400).json({ error: 'Missing Authorization header' });

    const { q_ids, q_types, qb_id, current_qb_id } = req.body || {};
    if (!Array.isArray(q_ids) || !q_ids.length) return res.status(400).json({ error: '"q_ids" must be a non-empty array' });
    if (!Array.isArray(q_types) || q_types.length !== q_ids.length) {
      return res.status(400).json({ error: '"q_types" must be the same length as "q_ids" (it is positional)' });
    }
    if (!qb_id) return res.status(400).json({ error: '"qb_id" (destination) is required' });
    if (!current_qb_id) return res.status(400).json({ error: '"current_qb_id" (source) is required' });
    if (qb_id === current_qb_id) return res.status(400).json({ error: 'Source and destination bank are the same' });

    const url = EXAMLY_QUESTION_MOVE_API +
      '?q_id=' + q_ids.map(encodeURIComponent).join(',') +
      '&q_type=' + q_types.map(encodeURIComponent).join(',') +
      '&qb_id=' + encodeURIComponent(qb_id) +
      '&current_qb_id=' + encodeURIComponent(current_qb_id);

    const r = await callUpstream(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json, text/plain, */*', 'Authorization': token }
    });

    if (r.failed || r.status >= 400) {
      return res.status(r.status || 502).json({
        error: 'Portal refused the move',
        moved: 0,
        details: r.body
      });
    }

    // The portal answers {success:true, message:"Question successfully moved"}.
    // Treat anything without success:true as a failure rather than assuming
    // HTTP 200 means the questions actually moved.
    const ok = r.body && (r.body.success === true || (r.body.data && r.body.data.success === true));
    if (!ok) {
      return res.status(502).json({ error: 'Move did not report success', moved: 0, details: r.body });
    }

    console.log('[QB-MOVE] ' + q_ids.length + ' question(s) ' + current_qb_id + ' -> ' + qb_id);
    res.json({ ok: true, moved: q_ids.length, q_ids, details: r.body });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Question move failed', moved: 0, details: err.message });
  }
});


// ---- Serve the built React app from this same process ----
//
// One Render service instead of two: no CORS, no second URL, and the free
// tier only gives you one anyway. In local dev this block is inert — Vite
// serves the app on :5173 and proxies /api here — because starklight/dist
// only exists after a build.
//
// Registered AFTER every /api route so it can never shadow one, and the
// catch-all deliberately excludes /api so a wrong API path still returns a
// JSON 404 rather than the HTML shell.
const CLIENT_DIST = path.join(__dirname, '..', 'starklight', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  // Cache policy matters here, and getting it wrong is invisible until a
  // deploy "does nothing": Vite fingerprints asset filenames
  // (index-BlUyTz-H.js), so a new build produces new filenames and old ones
  // can be cached forever. index.html is the opposite — it is the thing that
  // POINTS at those filenames, so if a browser caches it, the deploy lands
  // but the user keeps loading the previous bundle and sees no change.
  app.use(express.static(CLIENT_DIST, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Content-hashed: safe to cache hard, and a rebuild changes the name.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));

  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
  console.log('Serving built client from ' + CLIENT_DIST);
} else {
  console.log('No client build found at ' + CLIENT_DIST + ' — API only (run the Vite dev server for the UI).');
}


// Render supplies PORT; 3000 locally.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Starklight server running on port ' + PORT);
  console.log('  AI providers configured: ' +
    (['GROQ', 'OPENROUTER', 'GEMINI', 'HF'].filter(k => process.env[k + '_API_KEY']).join(', ') || 'NONE'));
  console.log('  Report history: ' + (process.env.DATABASE_URL ? 'enabled (DATABASE_URL set)' : 'disabled (no DATABASE_URL)'));
});
