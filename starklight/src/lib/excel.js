import * as XLSX from 'xlsx'
import { stripHtml, extractImageUrls, findRepeatedTestCases, getSampleCases, getHiddenTestCases } from './helpers'

const VERDICT_EMOJI = { pass: '✅', fail: '❌', warn: '⚠️' }

// Same emoji-forward style as the in-app tables — easier to scan at a glance in Excel too,
// not just plain text.
function verdictText(check) {
  if (!check || check.verdict === undefined || check.verdict === 'na') return '—'
  const emoji = VERDICT_EMOJI[check.verdict] || ''
  const label = `${emoji} ${check.verdict}`.trim()
  return check.note ? `${label} — ${check.note}` : label
}

function starsText(rating) {
  if (rating == null || rating === '') return ''
  const n = Math.max(0, Math.min(5, parseInt(rating, 10) || 0))
  return '⭐'.repeat(n) + '☆'.repeat(5 - n) + ` (${n}/5)`
}

// Excel sheet names: max 31 chars, and : \ / ? * [ ] are illegal. Also has to be unique
// within the workbook, so collisions after truncation get a numeric suffix.
function safeSheetName(base, used) {
  let name = String(base).replace(/[:\\/?*[\]]/g, '-').trim().slice(0, 31) || 'Section'
  if (used.has(name)) {
    let i = 2
    while (used.has(`${name.slice(0, 28)} (${i})`)) i++
    name = `${name.slice(0, 28)} (${i})`
  }
  used.add(name)
  return name
}

function summaryRowFor(e) {
  const q = e.question, a = e.analysis
  const c = a?.checks || {}
  const fixes = (a && Array.isArray(a.fix_needed)) ? a.fix_needed : []
  const mustFix = fixes.filter(f => f.severity === 'must-fix').length
  const debugCheck = c.debug_analysis

  return {
    'Q#': q._qNum ? `Q${q._qNum}` : '',
    'Question ID': q.q_id || '',
    '🧩 Question (preview)': stripHtml(q.question_data || '').slice(0, 150),
    'Question Bank': q._qb_name || '',
    Category: a ? (a.category === 'mcq' ? '📝 MCQ' : '💻 Coding') : '❔ error',
    // Coding checks
    'Statement↔Code': verdictText(c.statement_code),
    Format: verdictText(c.format),
    Constraints: verdictText(c.constraints),
    'Test Cases': verdictText(c.test_cases),
    // MCQ checks
    'Answer Correct': verdictText(c.answer_correct),
    'Only-One-Correct': verdictText(c.only_one_correct),
    Explanation: verdictText(c.explanation_check),
    // Shared
    Syllabus: verdictText(c.syllabus_alignment),
    // Debug — explicit numeric columns, not buried in a note
    '🐞 Debug Verdict': debugCheck && debugCheck.verdict !== 'na' ? `${VERDICT_EMOJI[debugCheck.verdict] || ''} ${debugCheck.verdict}`.trim() : '—',
    '🔤 Debug Syntax Errors': debugCheck?.syntax_error_count ?? '—',
    '🧠 Debug Logical Errors': debugCheck?.logical_error_count ?? '—',
    '🐞 Debug Notes': (debugCheck && debugCheck.verdict !== 'na' && debugCheck.note) || '',
    '⭐ Rating': starsText(a?.rating),
    '❗ Must-Fix Issues': mustFix,
    '💡 Should-Fix Issues': fixes.length - mustFix,
    '🖼️ Uses Image(s)': extractImageUrls(q).length ? '✅ Yes' : '—',
    '🧪 Sample Cases': getSampleCases(q).length,
    '🧪 Hidden Cases': getHiddenTestCases(q).length,
    '♻️ Repeated Cases': (() => {
      const r = findRepeatedTestCases(q)
      if (!r.hasAny) return '—'
      return r.sampleReusedInHidden.map(x => `hidden #${x.hiddenIndex}=sample #${x.sampleIndex}`)
        .concat(r.duplicateHidden.map(x => `hidden #${x.hiddenIndex}=hidden #${x.firstIndex}`))
        .join('; ')
    })(),
    Tags: Array.isArray(q.tags) ? q.tags.map(t => t.name).join(', ') : '',
    '❌ Error': e.error || ''
  }
}

function fixRowsFor(e) {
  const q = e.question, a = e.analysis
  const fixes = (a && Array.isArray(a.fix_needed)) ? a.fix_needed : []
  return fixes.map(f => ({
    'Q#': q._qNum ? `Q${q._qNum}` : '',
    'Question ID': q.q_id || '',
    '🎯 Area': f.area || '',
    Severity: f.severity === 'must-fix' ? '❗ must-fix' : '💡 should-fix',
    '🧩 Issue': f.issue || '',
    // Read straight off the fix object itself — set once by "Get Fixes", never re-keyed by
    // array position, so it can't drift out of sync with what was actually fetched.
    '🔧 Rectification (if fetched via Get Fixes)': f.rectification ? f.rectification.text : '⏳ (not fetched — click "Get Fixes" first)'
  }))
}

// qcResults: { [q_id]: { question, analysis, error, pending } }
// sourceName: the test/QB name, used in the filename.
export function exportQcReportToExcel(qcResults, sourceName) {
  const entries = Object.values(qcResults).filter(e => !e.pending)
  if (!entries.length) return { ok: false, reason: 'No analyzed questions yet.' }

  // Group by the SAME key the app groups by on screen (a test's section name, falling back to
  // the originating question bank) so the workbook mirrors what you were just looking at.
  const order = []
  const bySection = new Map()
  for (const e of entries) {
    const key = e.question._sectionName || e.question._qb_name || 'Ungrouped'
    if (!bySection.has(key)) { bySection.set(key, []); order.push(key) }
    bySection.get(key).push(e)
  }

  const wb = XLSX.utils.book_new()
  const usedNames = new Set()

  // --- Sheet 1: one row per section, so you can see at a glance which section is worst off.
  const overviewRows = order.map(section => {
    const rows = bySection.get(section)
    const rated = rows.filter(r => r.analysis && typeof r.analysis.rating === 'number')
    const avg = rated.length ? rated.reduce((n, r) => n + r.analysis.rating, 0) / rated.length : null
    let must = 0, should = 0
    for (const r of rows) {
      const fixes = (r.analysis && Array.isArray(r.analysis.fix_needed)) ? r.analysis.fix_needed : []
      must += fixes.filter(f => f.severity === 'must-fix').length
      should += fixes.length - fixes.filter(f => f.severity === 'must-fix').length
    }
    return {
      '📂 Section': section,
      'Questions': rows.length,
      '⭐ Avg Rating': avg == null ? '—' : `${avg.toFixed(2)} / 5`,
      '❗ Must-Fix (total)': must,
      '💡 Should-Fix (total)': should,
      '❌ Failed to analyze': rows.filter(r => r.error).length
    }
  })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overviewRows), safeSheetName('📊 Section Overview', usedNames))

  // --- Sheet 2: every question, still grouped by section (section column first) — handy when
  // you want to filter/pivot the whole test in one place rather than tab-hopping.
  const allRows = []
  const allFixRows = []
  for (const section of order) {
    for (const e of bySection.get(section)) {
      allRows.push({ '📂 Section': section, ...summaryRowFor(e) })
      for (const fr of fixRowsFor(e)) allFixRows.push({ '📂 Section': section, ...fr })
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allRows), safeSheetName('All Questions', usedNames))
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(allFixRows.length ? allFixRows : [{ Note: '✅ No flagged issues in this batch.' }]),
    safeSheetName('All Fixes', usedNames)
  )

  // --- Then one dedicated sheet per section: its questions, followed by its own fixes below.
  for (const section of order) {
    const rows = bySection.get(section)
    const sheetRows = rows.map(summaryRowFor)
    const ws = XLSX.utils.json_to_sheet(sheetRows)

    const sectionFixes = rows.flatMap(fixRowsFor)
    if (sectionFixes.length) {
      // Two blank rows, a heading, then this section's fixes stacked under the summary.
      const startRow = sheetRows.length + 3
      XLSX.utils.sheet_add_aoa(ws, [['🔧 FIXES NEEDED IN THIS SECTION']], { origin: `A${startRow}` })
      XLSX.utils.sheet_add_json(ws, sectionFixes, { origin: `A${startRow + 1}` })
    }
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(section, usedNames))
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const cleanName = (sourceName || 'report').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'report'
  XLSX.writeFile(wb, `qc_report_${cleanName}_${stamp}.xlsx`)
  return { ok: true }
}

const TOPIC_VERDICT_TEXT = {
  pass: '✅ In scope',
  fail: '❌ Out of scope',
  warn: '⚠️ Borderline',
  error: '❗ Check failed',
  pending: '⏳ Pending'
}

// ---- Topic Analyser report ----
// questions: the loaded question list; results: { q_id -> { verdict, note } };
// scope: { included: [], restricted: [] } — recorded on its own sheet so a saved report
// still shows which syllabus it was judged against.
export function exportTopicReportToExcel(questions, results, sourceName, scope) {
  if (!questions?.length) return { ok: false, reason: 'Nothing loaded to export yet.' }
  const checked = questions.filter(q => results[q.q_id])
  if (!checked.length) return { ok: false, reason: 'No questions analysed yet.' }

  const order = []
  const bySection = new Map()
  for (const q of questions) {
    const key = q._sectionName || q._qb_name || 'Ungrouped'
    if (!bySection.has(key)) { bySection.set(key, []); order.push(key) }
    bySection.get(key).push(q)
  }

  const rowFor = q => {
    const r = results[q.q_id]
    return {
      'Q#': q._qNum ? `Q${q._qNum}` : '',
      'Question ID': q.q_id || '',
      'Question (preview)': stripHtml(q.question_data || '').slice(0, 180),
      Type: q.question_type || '',
      Topic: q.topic?.name || '',
      'Sub-topic': q.sub_topic?.name || '',
      Tags: Array.isArray(q.tags) ? q.tags.map(t => t.name).join(', ') : '',
      Verdict: r ? (TOPIC_VERDICT_TEXT[r.verdict] || r.verdict) : '— not checked',
      Finding: r?.note || ''
    }
  }

  const wb = XLSX.utils.book_new()
  const used = new Set()

  // Scope sheet first — so the report is self-documenting months later.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Field: 'Source', Value: sourceName || '(unnamed)' },
    { Field: 'Generated', Value: new Date().toLocaleString() },
    { Field: '✅ Allowed topics', Value: (scope?.included || []).join(', ') || '(none given)' },
    { Field: '⛔ Restricted / future topics', Value: (scope?.restricted || []).join(', ') || '(none given)' },
    { Field: 'Questions loaded', Value: questions.length },
    { Field: 'Questions analysed', Value: checked.length }
  ]), safeSheetName('Scope', used))

  // Per-section tallies.
  const overview = order.map(section => {
    const rows = bySection.get(section)
    const count = v => rows.filter(q => results[q.q_id]?.verdict === v).length
    return {
      '📂 Section': section,
      Questions: rows.length,
      '✅ In scope': count('pass'),
      '❌ Out of scope': count('fail'),
      '⚠️ Borderline': count('warn'),
      '❗ Failed': count('error'),
      '— Unchecked': rows.filter(q => !results[q.q_id]).length
    }
  })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overview), safeSheetName('Section Overview', used))

  // Everything, with section as the leading column.
  const all = []
  for (const section of order) for (const q of bySection.get(section)) all.push({ '📂 Section': section, ...rowFor(q) })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(all), safeSheetName('All Questions', used))

  // Just the problems — usually the sheet you actually act on.
  const flagged = all.filter(r => r.Verdict.includes('Out of scope') || r.Verdict.includes('Borderline'))
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(flagged.length ? flagged : [{ Note: '✅ Nothing outside the given topic scope.' }]),
    safeSheetName('Flagged Only', used)
  )

  // One sheet per section.
  for (const section of order) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bySection.get(section).map(rowFor)), safeSheetName(section, used))
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const clean = (sourceName || 'report').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'report'
  XLSX.writeFile(wb, `topic_report_${clean}_${stamp}.xlsx`)
  return { ok: true }
}

// Re-export a report pulled back out of history.
//
// Deliberately separate from exportTopicReportToExcel: that one walks live
// question objects, which a stored report does not have. History stores
// flattened rows instead, so the whole payload stays small and stays valid
// even if the underlying questions are later edited or deleted in the portal
// — the report is a record of what was true when it ran.
export function exportStoredTopicReport(stored, sourceName) {
  const rows = Array.isArray(stored?.rows) ? stored.rows : []
  if (!rows.length) return { ok: false, reason: 'That stored report has no rows.' }

  const wb = XLSX.utils.book_new()
  const used = new Set()

  const scope = stored.scope || {}
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Field: 'Source', Value: sourceName || '' },
    { Field: 'Allowed topics', Value: (scope.included || []).join(', ') || '(none given)' },
    { Field: 'Restricted topics', Value: (scope.restricted || []).join(', ') || '(none given)' },
    { Field: 'Questions', Value: rows.length },
    { Field: 'Flagged', Value: rows.filter(r => r.verdict && r.verdict !== 'pass').length },
    { Field: 'Exported', Value: new Date().toLocaleString() }
  ]), safeSheetName('Scope', used))

  const flat = rows.map(r => ({
    'Q#': r.qNum ? `Q${r.qNum}` : '',
    'Question ID': r.q_id || '',
    Section: r.section || '',
    Type: r.type || '',
    Verdict: r.verdict || '',
    Topic: r.topic || '',
    Note: r.note || '',
    Question: r.statement || ''
  }))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), safeSheetName('All Questions', used))

  const flagged = flat.filter(r => r.Verdict && r.Verdict !== 'pass')
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(flagged.length ? flagged : [{ Note: 'Nothing outside the given topic scope.' }]),
    safeSheetName('Flagged Only', used)
  )

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const clean = (sourceName || 'report').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'report'
  XLSX.writeFile(wb, `topic_report_${clean}_${stamp}.xlsx`)
  return { ok: true }
}
