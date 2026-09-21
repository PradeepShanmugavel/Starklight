// Constraint/statement text routinely contains bare comparison operators — "s < 10",
// "1 <n< 100" — and the HTML parser treats `<` followed by a letter as a tag opener, silently
// swallowing everything up to the next `>`. ("<p>s < 10</p>" came out as just "s".) Only a `<`
// that starts a REAL html tag is left alone; every other one is escaped so the text survives.
// The list covers what the portal's rich-text editor actually emits.
// A `<` only counts as a tag if it forms a COMPLETE, well-formed tag: a known tag name
// followed by attributes containing no further `<`, then `>`. That distinction matters for
// single-letter tag names — "<b>" is bold, but "if a<b then" is a comparison, and requiring
// the closing `>` (with no `<` in between) tells them apart.
const HTML_TAG_NAMES = 'p|br|div|span|b|strong|i|em|u|s|sub|sup|ul|ol|li|a|img|pre|code|table|thead|tbody|tr|td|th|h[1-6]|blockquote|hr|font'
const REAL_TAG_RE = new RegExp(`^<(?:/?(?:${HTML_TAG_NAMES})\\b[^<>]*>|!--|![^<>]*>)`, 'i')

function escapeStrayAngleBrackets(html) {
  const src = String(html)
  return src.replace(/</g, (m, offset) =>
    REAL_TAG_RE.test(src.slice(offset)) ? m : '&lt;'
  )
}

// ---- Plain-text extraction from the platform's HTML-formatted fields ----
// The `$$$examly` code delimiter is dropped here too, so it never leaks into previews,
// one-line summaries, Excel cells or the text sent to the AI.
export function stripHtml(html) {
  if (!html) return ''
  const div = document.createElement('div')
  div.innerHTML = escapeStrayAngleBrackets(html)
  const text = div.textContent || div.innerText || ''
  return text.split('$$$examly').join(' ').replace(/\s+/g, ' ').trim()
}

// ---- Image URLs embedded in a question's HTML fields (statement/format/constraints) ----
const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["']/gi

export function extractImageUrls(q) {
  if (!q) return []
  const pq = q.programming_question || {}
  const texts = [q.question_data, pq.input_format, pq.output_format, pq.code_constraints]
  const urls = []
  const seen = new Set()
  for (const t of texts) {
    if (!t) continue
    IMG_SRC_RE.lastIndex = 0
    let m
    while ((m = IMG_SRC_RE.exec(t)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); urls.push(m[1]) }
    }
  }
  return urls
}

// ---- Verification-tag priority (stverified > fverified > qcverified > sverified > verified) ----
const VERIFICATION_PRIORITY = ['stverified', 'fverified', 'qcverified', 'sverified', 'verified']
export const PRIORITY_LABELS = ['🥇 STVerified', '🥈 FVerified', '🥉 QCVerified', '🏅 SVerified', '✅ Verified']

export function getPriorityRank(q) {
  if (!Array.isArray(q.tags)) return VERIFICATION_PRIORITY.length
  const names = q.tags.map(t => (t.name || '').trim().toLowerCase())
  for (let i = 0; i < VERIFICATION_PRIORITY.length; i++) {
    if (names.includes(VERIFICATION_PRIORITY[i])) return i
  }
  return VERIFICATION_PRIORITY.length
}

// Priority first — 🥇STVerified, 🥈FVerified, 🥉QCVerified, 🏅SVerified, ✅Verified, then
// everything else grouped by its first tag name (so unverified questions still cluster by
// topic/tag rather than showing in arbitrary fetch order).
export function sortByPriority(list) {
  return list.slice().sort((a, b) => {
    const rankDiff = getPriorityRank(a) - getPriorityRank(b)
    if (rankDiff !== 0) return rankDiff
    const tagA = (a.tags?.[0]?.name || '').toLowerCase()
    const tagB = (b.tags?.[0]?.name || '').toLowerCase()
    return tagA.localeCompare(tagB)
  })
}

// ---- Stable per-section question numbering (Q1, Q2, ...) ----
// Mutates each question with a `_qNum` (1-based, restarts per section) so numbering stays
// consistent across every view (picker, QC table, report, Excel) instead of drifting with
// sorting/filtering. Groups by _sectionName (test section / target section) if set, else
// falls back to _qb_name (the real originating question bank) — see groupBySection below for
// why these two are kept separate.
export function assignSectionQuestionNumbers(rows) {
  const counters = {}
  for (const q of rows) {
    const sec = q._sectionName || q._qb_name || 'Ungrouped'
    counters[sec] = (counters[sec] || 0) + 1
    q._qNum = counters[sec]
  }
}

// `_qb_name` = the question's REAL originating question bank name — set once when a question
// is first loaded from a QB search, and NEVER overwritten afterward. `_sectionName` = which
// section it's currently grouped under for display/test-building purposes — set separately
// whenever a question is placed into a section. Keeping these distinct matters a lot: once a
// question was assigned to a section, code used to overwrite `_qb_name` with the section name,
// which silently broke both the "Question Bank: X" display AND debug-question detection (which
// checks the QB name for "debug") for anything already added to a test.
export function groupBySection(rows) {
  const order = []
  const bySection = {}
  for (const q of rows) {
    const sec = q._sectionName || q._qb_name || 'Ungrouped'
    if (!bySection[sec]) { bySection[sec] = []; order.push(sec) }
    bySection[sec].push(q)
  }
  return { order, bySection }
}

// ---- Solution code / constraints extraction (for coding & debug questions) ----
// ---- Every language's solution, with the one marked solutionbest:true flagged, plus header/
// footer/codeStub — ALL confirmed fields, seen directly in a real capture of a debug question:
// solution[].codeStub holds the intentionally-broken code for a debug question (or a starter
// template for a regular coding question); header/footer are the locked pre/post code; and
// solutiondata[].solutionbest flags the reference-best solution. ----
export function getSolutionsWithBest(q) {
  const pq = q.programming_question
  if (!pq || !Array.isArray(pq.solution)) return []
  const out = []
  for (const sol of pq.solution) {
    if (!Array.isArray(sol.solutiondata)) continue
    for (const sd of sol.solutiondata) {
      if (sd.solution) {
        out.push({
          language: sol.language || 'code',
          code: sd.solution,
          isBest: !!sd.solutionbest,
          header: sol.hasSnippet && !sol.hideHeader ? (sol.header || '') : '',
          footer: sol.hasSnippet && !sol.hideFooter ? (sol.footer || '') : '',
          codeStub: sol.codeStub || ''
        })
      }
    }
  }
  return out
}

// ---- Stub / starter code — confirmed field: solution[].codeStub (same field also holds a
// debug question's intentionally-broken code — see getDebugCodeBestEffort below). Prefers the
// best-marked language's stub, falls back to any language that has one.
export function getStubCodeBestEffort(q) {
  const solutions = getSolutionsWithBest(q)
  const best = solutions.find(s => s.isBest && s.codeStub)
  if (best) return best.codeStub
  const any = solutions.find(s => s.codeStub)
  return any ? any.codeStub : ''
}

// ---- Best-effort MCQ option extraction — mcq_questions' full shape (beyond `id`) has never
// been confirmed via a real capture, so this tries a few common shapes and falls back to
// raw JSON so nothing is silently hidden even when the shape doesn't match.
// Several MCQ fields arrive as a JSON *string* wrapping an {args:[...]} envelope, e.g.
// answer: '{"args":["<p>It will compile successfully</p>"],"partial":[]}'. This unwraps that
// to a plain array of strings; returns [] for anything unparseable.
function parseArgsEnvelope(raw) {
  if (!raw) return []
  let val = raw
  if (typeof val === 'string') {
    try { val = JSON.parse(val) } catch { return [] }
  }
  if (Array.isArray(val)) return val.map(String)
  if (val && typeof val === 'object' && Array.isArray(val.args)) return val.args.map(String)
  return []
}

// ---- MCQ options + which one is correct. CONFIRMED shape (from a real capture of
// /api/mcq_question/{id}):
//   mcq_questions.options = '[{"text":"<p>..</p>","media":""}, ...]'   (JSON string)
//   mcq_questions.answer  = '{"args":["<p>..</p>"],"partial":[]}'      (JSON string)
// Note there is NO per-option "correct" flag — correctness is determined by matching an
// option's text against the entries in `answer.args`, which also means multi-correct MCQs
// work naturally (args simply holds more than one entry).
export function getMcqOptionsBestEffort(q) {
  const mcq = q.mcq_questions
  if (!mcq || typeof mcq !== 'object') return null

  const raw = mcq.options ?? mcq.choices ?? mcq.answers
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { list = null }
  }

  if (Array.isArray(list) && list.length) {
    // Correct answers, normalised to plain text for comparison against option text.
    const correctTexts = new Set(
      parseArgsEnvelope(mcq.answer).map(a => stripHtml(a).trim().toLowerCase()).filter(Boolean)
    )

    return list.map((o, i) => {
      const rawText = typeof o === 'string'
        ? o
        : (o.text ?? o.value ?? o.option ?? o.optionText ?? JSON.stringify(o))
      const text = stripHtml(String(rawText)).trim()
      // Primary signal is the answer-text match above. The explicit boolean flags are kept as
      // a fallback for any shape that does carry them (older/other question types).
      const flagged = typeof o === 'object' && o !== null && (
        o.isCorrect === true || o.correct === true || o.is_correct === true || o.isAnswer === true
      )
      return {
        label: String.fromCharCode(65 + i),
        text,
        media: (o && typeof o === 'object' && o.media) || '',
        isCorrect: (text && correctTexts.has(text.toLowerCase())) || flagged
      }
    })
  }

  const letterKeys = ['option_a', 'option_b', 'option_c', 'option_d', 'choice_a', 'choice_b', 'choice_c', 'choice_d']
  const found = letterKeys.filter(k => mcq[k] != null)
  if (found.length) {
    return found.map((k, i) => ({ label: String.fromCharCode(65 + i), text: stripHtml(String(mcq[k])).trim(), isCorrect: false }))
  }
  return null // caller falls back to showing the raw mcq_questions JSON
}

// ---- Answer explanation. Also an {args:[...]} JSON string in real captures, with a
// duplicate copy under `best_sol` — prefer args, fall back to best_sol, then plain text.
export function getAnswerExplanation(q) {
  const raw = q.answer_explanation
  if (!raw) return ''
  const args = parseArgsEnvelope(raw)
  if (args.length) return stripHtml(args.join(' ')).trim()
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.best_sol) return stripHtml(String(parsed.best_sol)).trim()
    } catch { /* not JSON — treat as plain HTML below */ }
    return stripHtml(raw).trim()
  }
  return ''
}

// ---- Code snippets embedded in question text ----
// The portal wraps inline code in a `$$$examly` delimiter pair, e.g.
//   "...consider the code $$$examlypublic class Main { ... }$$$examly what is the output?"
// Rendered as ordinary HTML the whitespace collapses and the whole program becomes one
// unreadable line (and the raw "$$$examly" marker leaks into the text). This converts each
// delimited span into a real <pre> block so indentation and line breaks survive.
const EXAMLY_CODE_DELIM = '$$$examly'

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Turns the HTML that lives *inside* a code span back into plain text: <br> and block ends
// become newlines, tags are dropped, entities decoded — then it gets re-escaped for <pre>.
function codeInnerToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\s+$/g, '')
}

export function formatExamlyCodeBlocks(html) {
  const src = String(html || '')
  if (!src.includes(EXAMLY_CODE_DELIM)) return src

  // Paired delimiter: segments at odd indices are code, even indices are prose.
  const parts = src.split(EXAMLY_CODE_DELIM)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const code = codeInnerToText(parts[i])
      if (code) out += `<pre class="examly-code"><code>${escapeHtml(code)}</code></pre>`
    } else {
      out += parts[i]
    }
  }
  // Odd number of delimiters means the last one was unclosed — the trailing chunk was treated
  // as prose above, which is the safe outcome (nothing is swallowed).
  return out
}

// ---- Fill-in-the-blank questions ----
// CONFIRMED shape (from a real capture of /api/fillup_question/{id}):
//   fillup_questions.answer = '{"fillups_answers":[{"args":"==","splitweight":100,
//                               "do_not_split_bool":true,"other_answers":[],
//                               "other_answer_partial":false}]}'   (JSON string)
//   fillup_questions.blanks = 1
//   fillup_questions.case_sensitive = false
// The blank itself appears in question_data as a run of underscores (e.g. "________").
export function getFillupData(q) {
  const fq = q.fillup_questions
  if (!fq || typeof fq !== 'object') return null

  let parsed = null
  if (fq.answer) {
    if (typeof fq.answer === 'string') {
      try { parsed = JSON.parse(fq.answer) } catch { parsed = null }
    } else if (typeof fq.answer === 'object') {
      parsed = fq.answer
    }
  }

  const rows = Array.isArray(parsed?.fillups_answers) ? parsed.fillups_answers : []
  const answers = rows.map((a, i) => ({
    index: i + 1,
    // `args` is the accepted answer for this blank; occasionally an array on multi-answer blanks.
    value: Array.isArray(a?.args) ? a.args.map(String).join(' | ') : String(a?.args ?? ''),
    otherAnswers: Array.isArray(a?.other_answers) ? a.other_answers.map(String).filter(Boolean) : [],
    weight: a?.splitweight ?? null,
    partialCredit: !!a?.other_answer_partial
  }))

  // How many blanks the statement actually contains, so QC can flag a mismatch against
  // the declared `blanks` count.
  const statement = String(q.question_data || '')
  const blanksInText = (statement.match(/_{3,}/g) || []).length

  return {
    declaredBlanks: fq.blanks ?? null,
    blanksInStatement: blanksInText,
    caseSensitive: !!fq.case_sensitive,
    answers
  }
}

// Compact human-readable summary used in the UI and Excel.
export function getFillupAnswerSummary(q) {
  const d = getFillupData(q)
  if (!d || !d.answers.length) return ''
  return d.answers
    .map(a => {
      const alts = a.otherAnswers.length ? ` (also: ${a.otherAnswers.join(', ')})` : ''
      return d.answers.length > 1 ? `#${a.index}: ${a.value}${alts}` : `${a.value}${alts}`
    })
    .join('  |  ')
}

// ---- Rectification text normalisation ----
// Two problems this solves:
//  1. The model occasionally wraps its answer in a JSON envelope (or returns a stringified
//     object) instead of the bare replacement content, which then renders as raw JSON.
//  2. stripHtml() collapses ALL whitespace, which is fine for prose but destroys the
//     indentation of code — making a "copy this in" rectification useless for code fixes.
// This returns { html, text } where text preserves line breaks and leading indentation.

// Plain text that keeps newlines and indentation (unlike stripHtml, which flattens them).
export function htmlToPlainText(html) {
  let s = String(html || '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
  s = s.replace(/<li[^>]*>/gi, '• ')
  s = s.replace(/<[^>]*>/g, '')
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&amp;/g, '&')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.replace(/^\n+/, '').replace(/\s+$/, '')
}

// Pull readable content out of whatever the model returned for one rectification.
export function normalizeRectification(raw) {
  let value = raw

  // Unwrap a JSON envelope if that's what came back.
  if (typeof value === 'string') {
    const t = value.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        const parsed = JSON.parse(t)
        value = parsed
      } catch { /* not actually JSON — leave the string as-is */ }
    }
  }

  if (value && typeof value === 'object') {
    // Common shapes: {args:[...]}, {replacement_text:"..."}, {text:"..."}, or an array.
    if (Array.isArray(value)) {
      value = value.map(v => (typeof v === 'string' ? v : v?.text ?? v?.args ?? JSON.stringify(v))).join('\n\n')
    } else if (Array.isArray(value.args)) {
      value = value.args.join('\n\n')
    } else {
      value = value.replacement_text ?? value.text ?? value.content ?? value.best_sol ?? JSON.stringify(value, null, 2)
    }
  }

  const html = String(value ?? '')
  return { html, text: htmlToPlainText(html) }
}

// ---- Solution Forge helpers ----
// Everything below reads CONFIRMED fields on programming_question.solution[]:
// { language, hasSnippet, header, footer, codeStub, solutiondata:[{solution, solutionbest}] }

const EMPTY_BEST = { code: '', language: null, hasSnippet: false, header: '', footer: '', codeStub: '' };

// The solution marked "Best Solution" on the portal, falling back to the first
// one that has code (covers questions authored before that flag existed).
export function bestSolutionOf(q) {
  const sols = q?.programming_question?.solution;
  if (!Array.isArray(sols) || !sols.length) return EMPTY_BEST;
  const hasBest = s => Array.isArray(s.solutiondata) && s.solutiondata.some(sd => sd.solutionbest && sd.solution);
  const hasAny = s => Array.isArray(s.solutiondata) && s.solutiondata.some(sd => sd.solution);
  const best = sols.find(hasBest) || sols.find(hasAny);
  if (!best) return EMPTY_BEST;
  const sd = best.solutiondata.find(x => x.solution) || {};
  return {
    code: sd.solution || '',
    language: best.language || null,
    // hasSnippet and the actual header/footer/codeStub content can disagree
    // (confirmed on a live question), so callers should check content, not the flag.
    hasSnippet: !!best.hasSnippet,
    header: best.header || '',
    footer: best.footer || '',
    codeStub: best.codeStub || ''
  };
}

// Every language this question already has a solution for.
export function allSolutionsOf(q) {
  const sols = q?.programming_question?.solution;
  if (!Array.isArray(sols)) return [];
  return sols.map(s => {
    const sd = (s.solutiondata || []).find(x => x.solution) || {};
    return {
      language: s.language,
      code: sd.solution || '',
      best: !!sd.solutionbest,
      hasSnippet: !!s.hasSnippet,
      header: s.header || '',
      footer: s.footer || '',
      codeStub: s.codeStub || ''
    };
  }).filter(s => s.language && s.code);
}

// Sample I/O + hidden test cases combined, as {input, output, label}. Both
// come back as JSON *strings* rather than arrays, so both need parsing.
export function testCasesOf(q) {
  const pq = q?.programming_question || {};
  const out = [];
  try {
    const samples = typeof pq.sample_io === 'string' ? JSON.parse(pq.sample_io) : (pq.sample_io || []);
    if (Array.isArray(samples)) samples.forEach((t, i) => out.push({ input: t.input, output: t.output, label: `Sample ${i + 1}` }));
  } catch { /* leave samples out if unparseable */ }
  try {
    const hidden = typeof pq.testcases === 'string' ? JSON.parse(pq.testcases) : (pq.testcases || []);
    if (Array.isArray(hidden)) hidden.forEach((t, i) => out.push({
      input: t.input, output: t.output,
      label: `Test ${i + 1}${t.difficulty ? ' (' + t.difficulty + ')' : ''}`
    }));
  } catch { /* leave hidden cases out if unparseable */ }
  return out;
}

// A question can only have a solution generated for it if it's a programming
// question with at least one runnable test case.
export function isForgeable(q) {
  return q?.question_type === 'programming' && testCasesOf(q).length > 0;
}

// ---- QB Organiser ----

// The portal's `question_type` values vs. what the questionMove endpoint wants
// for its positional `q_type` parameter.
//
// CONFIRMED: programming -> "programming" (from a live capture).
// The MCQ and fillup values are NOT confirmed — they follow the same
// bare-noun pattern, which is the obvious reading, but nothing has verified
// them. Moves are batched one type at a time so a wrong value here can only
// ever affect that single batch, and a failed batch is retried once using the
// raw question_type before giving up.
export const MOVE_TYPE_GUESSED = { mcq: true, fillup: true, programming: false };

export function moveTypeFor(questionType) {
  const t = String(questionType || '').toLowerCase();
  if (t.includes('programming')) return 'programming';
  if (t.includes('mcq')) return 'mcq';
  if (t.includes('fillup')) return 'fillup';
  return t || 'programming';
}

export function typeSlugFor(questionType) {
  const t = moveTypeFor(questionType);
  return t === 'programming' ? 'code' : t;
}

// Parse a question-number list. Deliberately forgiving: commas, spaces, and
// ranges all work, since these are typed by hand or pasted from an AI answer.
//   "1, 4, 7"  "1 4 7"  "1-5, 9, 12-14"
// Returns { nums, bad } — `bad` holds anything that wasn't a number so the UI
// can say exactly what it couldn't read rather than silently dropping it.
export function parseQuestionNumbers(text) {
  const nums = [];
  const bad = [];
  const parts = String(text || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = +range[1], b = +range[2];
      if (a > b) { const t = a; a = b; b = t; } // tolerate a reversed range
      for (let i = a; i <= b; i++) nums.push(i);
      continue;
    }
    if (/^\d+$/.test(part)) nums.push(+part);
    else bad.push(part);
  }
  return { nums: [...new Set(nums)], bad };
}

// Parse a pasted plan of "ML_Regression - 1, 4, 7" lines.
//
// Separator handling matters here: question ranges use hyphens too ("7-10"),
// so a bare "-" split would cut in the wrong place. The rule is the FIRST
// spaced hyphen (" - "), falling back to the last colon for ":" style lines.
// Blank lines and headings with no separator are skipped, not treated as errors.
export function parsePastedPlan(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let name, numbers;
    const dash = line.indexOf(' - ');
    if (dash !== -1) {
      name = line.slice(0, dash);
      numbers = line.slice(dash + 3);
    } else {
      const colon = line.lastIndexOf(':');
      if (colon === -1) continue;
      name = line.slice(0, colon);
      numbers = line.slice(colon + 1);
    }

    name = name.trim().replace(/^[-*\d.\s]+/, ''); // strip bullet/number prefixes
    numbers = numbers.trim();
    if (!name || !numbers) continue;
    rows.push({ name, numbersText: numbers });
  }
  return rows;
}

// The prompt the user pastes into an AI chat along with their question list.
// Deliberately short: its whole job is to teach the output format, so the
// answer can be pasted straight back into the destinations box. No options —
// the AI works out the language and the topics from the questions themselves.
export const SEGREGATION_PROMPT = [
  'Group the numbered questions below into topic-wise question banks.',
  '',
  'For each group, work out:',
  '- the language or subject the questions are about (ml, genai, java, python, c, cpp, dsa, aptitude, ...)',
  '- a short, common topic name — the term a syllabus or textbook chapter would use',
  '  (Operators, Conditional Statements, Loops, Arrays, Strings, OOP, Collections,',
  '  Exception Handling, Regression, Clustering, ...). Not narrow ones like',
  '  "ternary operator precedence".',
  '',
  'Rules:',
  '- Prefer fewer, broader topics over many narrow ones.',
  '- Merge related ideas: if/else and switch are both Conditional Statements;',
  '  for/while/do-while are all Loops.',
  '- Every question number must appear exactly once. Do not drop or repeat any.',
  '',
  'Output one line per bank and nothing else — no preamble, no bullets, no code fences:',
  '',
  '<lang>_<Topic> - <comma separated question numbers>',
  '',
  'Example:',
  'ml_Regression - 1, 4, 9',
  'ml_Clustering - 2, 3, 7, 8',
  'java_Loops - 5, 6, 10',
  '',
  'QUESTIONS:'
].join('\n');

// ---- Detect a debug-type question. Primary signal: the REAL question bank name (`_qb_name`,
// never overwritten by section grouping — see groupBySection above) containing "debug"
// anywhere. Secondary signal, used when `_qb_name` isn't available (e.g. Test QC's bulk
// endpoint doesn't return a QB name, only a qb_id): any of the question's `question_testName`
// entries containing "debug" — confirmed useful in a real capture where a debug question's
// tests were named like "..._Debugging_Slot 3".
export function isDebugQuestion(q) {
  const qbName = q._qb_name || q.qb_name || ''
  if (/debug/i.test(qbName)) return true
  const testNames = Array.isArray(q.question_testName) ? q.question_testName.join(' ') : ''
  return /debug/i.test(testNames)
}

// ---- Buggy/debug code — CONFIRMED field: solution[].codeStub. For a debug question this
// holds the intentionally-broken code students must fix (verified directly in a real capture:
// a Java debug question's codeStub had genuine syntax errors — `size()` called without an
// object reference, a missing semicolon, `list.set(i)` used instead of `list.get(i)`, etc.).
// Same underlying field as getStubCodeBestEffort — kept as a separate function name since the
// two call sites (display vs. QC's debug_analysis check) have different semantics.
export function getDebugCodeBestEffort(q) {
  return getStubCodeBestEffort(q)
}

// ---- Route every question image through our own backend proxy (/api/image-proxy) rather
// than hitting S3 directly — that bucket blocks cross-origin BROWSER requests, but a
// server-to-server fetch isn't subject to that restriction at all.
export function proxiedImageUrl(url) {
  if (!url) return url
  return '/api/image-proxy?url=' + encodeURIComponent(url)
}

export function getSolutionCode(q) {
  const pq = q.programming_question
  if (!pq || !Array.isArray(pq.solution)) return ''
  const parts = []
  for (const sol of pq.solution) {
    if (Array.isArray(sol.solutiondata)) {
      for (const sd of sol.solutiondata) {
        if (sd.solution) parts.push(`[${sol.language || 'code'}]\n${sd.solution}`)
      }
    }
  }
  return parts.join('\n\n')
}

// ---- Constraints vs. test cases: kept STRICTLY separate ----
// These used to be merged into one blob, which meant the QC "constraints" check was actually
// reading test-case data (and `code_constraints` — the real constraints field — was never
// sent at all). Constraints must be judged against the test cases, so they have to arrive as
// distinct inputs.

// The actual constraint text, e.g. "<p>1 ≤ n ≤ 1000</p><p>1 ≤ rating ≤ 10000</p>".
export function getCodeConstraints(q) {
  const pq = q.programming_question
  if (!pq || !pq.code_constraints) return ''
  // Each <p>/<br> is a separate constraint, so split on block boundaries FIRST and strip each
  // piece on its own — stripHtml collapses all whitespace, so any newline inserted before it
  // would just come back out as a space.
  return String(pq.code_constraints)
    .split(/<br\s*\/?>|<\/(?:p|div|li)>/i)
    .map(part => stripHtml(part))
    .filter(Boolean)
    .join('\n')
}

function parseCaseList(raw) {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// Visible sample cases shown to the student.
export function getSampleCases(q) {
  return parseCaseList(q.programming_question?.sample_io)
}

// Hidden/scored cases used for grading.
export function getHiddenTestCases(q) {
  return parseCaseList(q.programming_question?.testcases)
}

// Normalised for comparison: trailing whitespace and line-ending differences shouldn't make
// two otherwise-identical cases look distinct.
function normaliseCase(t) {
  const norm = v => String(v ?? '').replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').trim()
  return `${norm(t.input)}\u0000${norm(t.output)}`
}

// ---- Duplicate detection across (and within) the case lists ----
// Two things worth flagging in QC: a sample case reused as a hidden case (students get that
// one free), and the same case appearing twice among the hidden cases (wasted score weight).
export function findRepeatedTestCases(q) {
  const samples = getSampleCases(q)
  const hidden = getHiddenTestCases(q)

  const sampleKeys = new Map()
  samples.forEach((s, i) => { sampleKeys.set(normaliseCase(s), i + 1) })

  const sampleReusedInHidden = []
  const duplicateHidden = []
  const seenHidden = new Map()

  hidden.forEach((t, i) => {
    const key = normaliseCase(t)
    if (sampleKeys.has(key)) {
      sampleReusedInHidden.push({ hiddenIndex: i + 1, sampleIndex: sampleKeys.get(key) })
    }
    if (seenHidden.has(key)) {
      duplicateHidden.push({ hiddenIndex: i + 1, firstIndex: seenHidden.get(key) })
    } else {
      seenHidden.set(key, i + 1)
    }
  })

  return {
    sampleReusedInHidden,
    duplicateHidden,
    hasAny: sampleReusedInHidden.length > 0 || duplicateHidden.length > 0
  }
}

// Human-readable case list for the QC payload — samples and hidden cases are formatted the
// same way but handed over as two separate fields by the caller.
export function formatCases(list, { withScores = false } = {}) {
  if (!list.length) return '(none)'
  return list.map((t, i) => {
    const meta = withScores ? ` [${t.difficulty || '-'}, score ${t.score ?? '-'}]` : ''
    return `#${i + 1}${meta}\nInput: ${t.input}\nOutput: ${t.output}`
  }).join('\n---\n')
}

// Kept for the places that just want one readable blob to DISPLAY (never for QC input) —
// now clearly labelled, and it finally includes the real constraints.
export function getConstraintsBlock(q) {
  const pq = q.programming_question
  if (!pq) return ''
  const parts = []
  const cons = getCodeConstraints(q)
  if (cons) parts.push('Constraints:\n' + cons)
  const samples = getSampleCases(q)
  if (samples.length) parts.push(`Sample I/O (${samples.length}):\n` + formatCases(samples))
  const hidden = getHiddenTestCases(q)
  if (hidden.length) parts.push(`Hidden Test Cases (${hidden.length}):\n` + formatCases(hidden, { withScores: true }))
  return parts.join('\n\n')
}

// ---- Best-effort MCQ payload (mcq_questions' exact field names are unconfirmed — we hand
// the AI the raw structure and let it read it directly rather than guessing field names) ----
export function getMcqData(q) {
  if (!q.mcq_questions && !q.answer_explanation) return ''
  try {
    // Send the AI a clean, already-parsed option list alongside the raw payload. The raw
    // `options` field is a JSON string containing HTML, so on its own it reaches the model
    // double-escaped and hard to read; `parsed_options` is the plain-text version.
    const parsed = getMcqOptionsBestEffort(q)
    const correct = parsed ? parsed.filter(o => o.isCorrect).map(o => `${o.label}. ${o.text}`) : []
    return JSON.stringify({
      parsed_options: parsed || '(could not parse — see raw below)',
      marked_correct: correct.length ? correct : '(none marked — verify the answer field)',
      answer_explanation: getAnswerExplanation(q),
      raw: { mcq_questions: q.mcq_questions || {} }
    }, null, 2)
  } catch {
    return ''
  }
}

export function getUsedTestNames(q) {
  const names = []
  if (Array.isArray(q.questions_in_tests)) {
    for (const entry of q.questions_in_tests) {
      if (entry?.tests?.t_name) names.push(entry.tests.t_name)
    }
  }
  if (Array.isArray(q.question_testName)) {
    for (const n of q.question_testName) if (n && !names.includes(n)) names.push(n)
  }
  return names
}

export function getMatchedExcludedTests(q, excludedLower) {
  if (!excludedLower.length) return []
  return getUsedTestNames(q).filter(name => excludedLower.includes(name.trim().toLowerCase()))
}

export function parseCsv(str) {
  if (!str) return []
  return str.split(',').map(s => s.trim()).filter(Boolean)
}

export function parseCsvLower(str) {
  return parseCsv(str).map(s => s.toLowerCase())
}

// ---- All unique tag names across a question list (for a tag-filter UI) ----
export function getUniqueTags(questions) {
  const set = new Set()
  for (const q of questions) {
    if (Array.isArray(q.tags)) for (const t of q.tags) if (t.name) set.add(t.name)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

// ---- Lightweight, no-AI duplicate detection: exact-text matches only (cheap, no tokens
// spent). Returns a Map of q_id -> the FIRST q_id it duplicates (so later occurrences show
// a warning pointing back at the original). Two questions with identical stripped text —
// even under different q_ids — are flagged; near-duplicates need the AI QC pass instead.
export function findDuplicateQuestionIds(questions) {
  const seenByText = new Map() // normalized text -> first q_id seen with that text
  const dupOf = new Map() // q_id -> the original q_id it duplicates
  for (const q of questions) {
    const text = stripHtml(q.question_data || '').toLowerCase().trim()
    if (!text) continue
    if (seenByText.has(text)) {
      dupOf.set(q.q_id, seenByText.get(text))
    } else {
      seenByText.set(text, q.q_id)
    }
  }
  return dupOf
}

