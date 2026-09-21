import axios from 'axios';
const h = t => ({'x-auth-token': t});

export async function browseQBs(token, { search = '', page = 1, limit = 25 } = {}) {
  const r = await axios.get('/api/examly/questionbanks', { headers: h(token), params: { search, page, limit } });
  return r.data; // { success, data: QB[], total, raw }
}
export async function resolveQBNames(token, names) {
  const r = await axios.get('/api/examly/questionbanks/search', { headers: h(token), params: { names: names.join(',') } });
  return r.data; // { success, data: QB[], missing: string[] }
}
export async function getQBQuestions(token, qbId, qbName) {
  const r = await axios.get(`/api/examly/questionbanks/${qbId}/questions`, { headers: h(token), params: qbName ? { qbName } : {} });
  return r.data; // { success, data: Question[], total } — CONFIRMED pipeline (same one Test Packing uses)
}
export async function getQBReport(token, qbId, qbName) {
  const r = await axios.get(`/api/examly/questionbanks/${qbId}/report`, { headers: h(token), params: qbName ? { qbName } : {} });
  return r.data;
}
export async function createQB(token, name) {
  const r = await axios.post('/api/examly/questionbanks/create', { name }, { headers: h(token) });
  return r.data;
}
export async function createTest(token, payload) {
  const r = await axios.post('/api/examly/tests', payload, { headers: h(token) });
  return r.data;
}
// Test-name-ONLY pipeline — QB auto-resolved server-side (a test can span
// several QBs, so there's no single "QB name" to ask for; the server lists
// every QB you can see and scans each one's question list for this test's
// ids, using the same full-metadata pipeline QB-name search used).
export async function getTestQuestions(token, testName) {
  const r = await axios.get(`/api/examly/tests/${encodeURIComponent(testName)}/questions`, { headers: h(token) });
  return r.data; // { success, data: Question[], tests: string[], total, requested, notFound }
}
// Fuzzy test-name search — every match, not auto-resolved to one, so the
// caller can show a picker when a partial/approximate name matches several
// tests (e.g. "...Day 19_PAH" vs "...Day 19_CE" — sibling tests in the same series).
export async function searchTests(token, name) {
  const r = await axios.get('/api/examly/tests/search', { headers: h(token), params: { name } });
  return r.data; // { success, data: [{id, name, code, publishStatus, sections, questionIds, questionCount}, ...] }
}

// ── Add-solutions feature ──────────────────────────────────────────────────
// Reads go entirely through the CONFIRMED getQBQuestions pipeline above.
export async function pushSolution(token, questionId, language, code, extra = {}) {
  const r = await axios.post(`/api/examly/questions/${questionId}/solution`, { language, code, ...extra }, { headers: h(token) });
  return r.data;
}
