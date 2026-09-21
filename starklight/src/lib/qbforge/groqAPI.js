import axios from 'axios';

/** Rich per-question QC pass: rating, duplication, tags, topic alignment */
export async function qcAnalyze(payload) {
  const res = await axios.post('/api/groq/qc-analyze', payload);
  return res.data; // { ok, analysis: {one_line_logic, rating, rating_reason, tags, duplication, duplication_details, core_topic, topic_alignment, topic_alignment_reason}, model_used }
}

/** Translate a solution's code into another language, same logic/I-O.
 * `signal` (optional): an AbortController's signal — lets the caller cancel
 * a still-in-flight request (the "Stop" button during generation). */
export async function translateSolution({ code, fromLanguage, toLanguage, question_text }, signal) {
  const res = await axios.post('/api/groq/translate-solution', { code, fromLanguage, toLanguage, question_text }, { signal });
  return res.data; // { ok, code, model }
}

/** Fix code using REAL local test-execution failures (expected vs actual).
 * `header`/`footer` (optional): when present, `code` is only the middle
 * portion — pass the fixed header/footer as read-only context so the fix
 * comes back as just the corrected middle, not a full re-fabricated program. */
export async function fixSolution({ code, language, question_text, failures, header, footer }, signal) {
  const res = await axios.post('/api/groq/fix-solution', { code, language, question_text, failures, header, footer }, { signal });
  return res.data; // { ok, code, model }
}

/** Translate a header or footer (fixed boilerplate wrapping a solution)
 * into another language. Plain code-in/code-out — no JSON/delimiters to get
 * wrong (an earlier combined-JSON version mangled newlines into literal
 * "\n" text; this is the same reliable shape as translateSolution above). */
export async function translateFragment({ code, fromLanguage, toLanguage, kind }, signal) {
  const res = await axios.post('/api/groq/translate-fragment', { code, fromLanguage, toLanguage, kind }, { signal });
  return res.data; // { ok, code, model }
}

/** Translate a codeStub (INTENTIONALLY buggy) into another language,
 * reintroducing an equivalent mistake (never fixed, never mentioned in
 * comments). Needs both the original solution (to diff against the stub
 * and see what the mistake is) and the already-translated solution (so the
 * stub matches its naming/structure). */
export async function translateStub({ codeStub, originalSolution, translatedSolution, fromLanguage, toLanguage, question_text }, signal) {
  const res = await axios.post('/api/groq/translate-stub', { codeStub, originalSolution, translatedSolution, fromLanguage, toLanguage, question_text }, { signal });
  return res.data; // { ok, code, model }
}
