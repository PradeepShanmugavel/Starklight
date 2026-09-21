// All calls go to the SAME Express server.js the original tool used — nothing on the
// backend changed. In dev, Vite's proxy (vite.config.js) forwards /api/* to localhost:3000.

// Turns whatever the backend sent back into a real, readable string — some upstream error
// responses (Examly's own API, or a malformed proxy response) return `error`/`message` as an
// object instead of a string, and `new Error(someObject)` silently stringifies it to the
// useless "[object Object]" instead of throwing. This guarantees an actual readable message.
function asText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

function toErrorMessage(data, res) {
  const msg = asText(data?.message ?? data?.error)

  // The backend puts the UPSTREAM portal's own words under `portalMessage`,
  // and that is the only part that names the offending field. Dropping it
  // made every single rejection read "Portal rejected the save" with no way
  // to tell a schema error from an expired token.
  const portal = asText(data?.portalMessage)
  const status = data?.status ?? res.status

  let out = msg || 'Request failed'
  if (portal && portal !== msg) out += ` — ${portal}`
  if (status) out += ` (HTTP ${status})`
  // The proxy attaches a `hint` on network/timeout failures — the part that
  // says *why* it probably happened. Worth showing: a 504 alone doesn't tell
  // you the host can't reach the portal.
  const hint = asText(data?.hint)
  if (hint) out += ` ${hint}`
  return out
}

// `signal` is optional and additive — every existing call site that doesn't
// pass one behaves exactly as before. Solution Manager's Stop button is the
// first caller that does, so an in-flight generate/run/push can actually be
// cancelled instead of just not-started-next.
async function request(path, { method = 'GET', token, body, signal } = {}) {
  const headers = { Accept: 'application/json, text/plain, */*' }
  if (token) headers.Authorization = token
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(toErrorMessage(data, res))
    err.data = data
    throw err
  }
  return data
}

export const api = {
  // ---- Question banks ----
  searchQuestionBanks: (token, body, signal) => request('/api/questionbanks', { method: 'POST', token, body, signal }),
  // `page` matters: the endpoint is paginated, so anything that needs a whole
  // bank has to walk the pages rather than asking for one huge limit.
  getQuestionsForQb: (token, qbId, limit = 50, page = 1, signal) =>
    request('/api/questions', { method: 'POST', token, body: { qb_id: qbId, type: 'Single', page, limit }, signal }),

  // ---- Tests ----
  searchTests: (token, body, signal) => request('/api/tests/filter', { method: 'POST', token, body, signal }),
  getTestDetail: (token, testId) => request(`/api/test/${encodeURIComponent(testId)}`, { token }),
  getQuestionsForTest: (token, testId, signal) => request(`/api/questions/test/${encodeURIComponent(testId)}`, { token, signal }),
  createTest: (token, body) => request('/api/test', { method: 'POST', token, body }),
  updateTest: (token, testId, body) => request(`/api/test/${testId}`, { method: 'PUT', token, body }),

  // ---- AI-assisted ----
  qcAnalyze: (token, body) => request('/api/qc-analyze', { method: 'POST', token, body }),
  qcRectify: (token, body) => request('/api/qc-rectify', { method: 'POST', token, body }),
  topicAlignCheck: (token, body) => request('/api/topic-align-check', { method: 'POST', token, body }),

  // ---- Solution Forge ----
  solutionLanguages: () => request('/api/solution-languages'),
  toolchainCheck: (signal) => request('/api/toolchain-check', { signal }),

  // ---- Topic Alignment report history ----
  // No token: history lives in our own database, not the portal.
  historyStatus: () => request('/api/history/status'),
  listTopicReports: () => request('/api/history/topic-reports'),
  getTopicReport: id => request(`/api/history/topic-reports/${encodeURIComponent(id)}`),
  saveTopicReport: body => request('/api/history/topic-reports', { method: 'POST', body }),
  deleteTopicReport: id =>
    request(`/api/history/topic-reports/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runTests: (body, signal) => request('/api/run-tests', { method: 'POST', body, signal }),
  translateSolution: (token, body, signal) => request('/api/translate-solution', { method: 'POST', token, body, signal }),
  fixSolution: (token, body, signal) => request('/api/fix-solution', { method: 'POST', token, body, signal }),
  translateFragment: (token, body, signal) => request('/api/translate-fragment', { method: 'POST', token, body, signal }),
  // body: { solutions: [{language, code, snippet}], bestLanguage, rawQuestion }
  // — or the single-solution form { language, code, snippet, rawQuestion }.
  // ---- QB Organiser ----
  // Destination banks are created by hand in the portal, so there is no create
  // call here — only the move.
  moveQuestions: (token, body) => request('/api/qb/move', { method: 'POST', token, body }),

  pushSolution: (token, qId, body, signal) =>
    request(`/api/question-solution/${encodeURIComponent(qId)}`, { method: 'PUT', token, body, signal }),
  packTest: (token, body) => request('/api/pack-test', { method: 'POST', token, body }),
  matchQbsAi: (token, body) => request('/api/match-qbs-ai', { method: 'POST', token, body }),
  aptitudeDistribute: (token, body) => request('/api/aptitude-distribute', { method: 'POST', token, body })
}

export function decodeJwtPayload(token) {
  try {
    const clean = token.replace(/^Bearer\s+/i, '').trim()
    const parts = clean.split('.')
    if (parts.length < 2) return null
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (payload.length % 4) payload += '='
    const json = decodeURIComponent(
      atob(payload).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    )
    return JSON.parse(json)
  } catch {
    return null
  }
}
