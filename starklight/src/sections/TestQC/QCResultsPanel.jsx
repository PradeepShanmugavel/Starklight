import { useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, CheckCircle, FileSpreadsheet, Loader2, RotateCcw, ListChecks, StopCircle } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import { stripHtml, extractImageUrls, groupBySection, getSolutionCode, getCodeConstraints, getSampleCases, getHiddenTestCases, formatCases, findRepeatedTestCases, getMcqData, getDebugCodeBestEffort, isDebugQuestion, getFillupData, getFillupAnswerSummary } from '../../lib/helpers'
import { VerdictBadge, StarRating, DebugAnalysisBadge } from '../../components/Badges'
import FixNeededCell from './FixNeededCell'
import { exportQcReportToExcel } from '../../lib/excel'

export default function QCResultsPanel({ questions, selected, testLabel, topicsIncluded = [], topicsExcluded = [] }) {
  const { token, qcResults, setQcResults } = useApp()
  const toast = useToast()
  const [busyLabel, setBusyLabel] = useState('')
  // Set by the Stop button; checked between questions so a long batch can be abandoned
  // without waiting for the whole list (the in-flight request still finishes, but no
  // further ones are started).
  const cancelRef = useRef(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })

  // If the visible question set changes while a batch is running (e.g. you switch section
  // from the sticky bar), stop it — otherwise it keeps grinding through the previous
  // section's list behind a table that's already showing something else. Checked during
  // render so no state is set from an effect; the loop itself notices the flag and exits.
  const questionKey = questions.map(q => q.q_id).join('|')
  const lastKeyRef = useRef(questionKey)
  if (lastKeyRef.current !== questionKey) {
    lastKeyRef.current = questionKey
    cancelRef.current = true // harmless when nothing is running
  }

  async function analyzeOne(q, isRetry = false) {
    setQcResults(prev => ({ ...prev, [q.q_id]: { question: q, analysis: null, error: null, pending: true } }))

    const pq = q.programming_question || {}
    try {
      const data = await api.qcAnalyze(token, {
        question_text: stripHtml(q.question_data || ''),
        input_format: stripHtml(pq.input_format || ''),
        output_format: stripHtml(pq.output_format || ''),
        // Sent as DISTINCT fields — merging these was making the constraints check judge
        // test-case data instead of the actual constraints.
        constraints: getCodeConstraints(q),
        sample_cases: formatCases(getSampleCases(q)),
        hidden_test_cases: formatCases(getHiddenTestCases(q), { withScores: true }),
        repeated_cases: findRepeatedTestCases(q),
        solution_code: getSolutionCode(q),
        question_type: q.question_type,
        mcq_data: getMcqData(q),
        debug_code: isDebugQuestion(q) ? getDebugCodeBestEffort(q) : '',
        fillup_data: q.fillup_questions ? JSON.stringify(getFillupData(q), null, 2) : '',
        topics_included: topicsIncluded,
        topics_excluded: topicsExcluded
      })
      const analysis = data.analysis || {}
      const emptyChecks = !analysis.checks || Object.keys(analysis.checks).length === 0
      // One silent automatic retry: an empty/incomplete result is almost always a one-off
      // bad generation rather than a real property of the question, and it otherwise shows
      // as a row of dashes that looks like a pass.
      if ((analysis.incomplete || emptyChecks) && !isRetry) {
        return analyzeOne(q, true)
      }
      setQcResults(prev => ({ ...prev, [q.q_id]: { question: q, analysis, error: null } }))
    } catch (err) {
      // Covers "API not found for this question" and any other network/HTTP failure — the
      // row stays retryable via the 🔁 Re-QC button instead of silently missing the report.
      setQcResults(prev => ({ ...prev, [q.q_id]: { question: q, analysis: null, error: err.message } }))
    }
  }

  async function analyzeMany(list, label) {
    if (!token) { toast('Please paste an access token first.', 'error'); return }
    if (!list.length) return
    cancelRef.current = false
    setBusyLabel(label)
    setProgress({ done: 0, total: list.length })
    let done = 0
    for (const q of list) {
      if (cancelRef.current) break
      await analyzeOne(q)
      done++
      setProgress({ done, total: list.length })
    }
    const stopped = cancelRef.current
    cancelRef.current = false
    setBusyLabel('')
    toast(
      stopped
        ? `Stopped after ${done} of ${list.length} question(s).`
        : `Analyzed ${list.length} question(s).`,
      stopped ? 'info' : 'success'
    )
  }

  function stopAnalysis() {
    cancelRef.current = true
    toast('Stopping after the current question…', 'info')
  }

  async function retryOne(q) {
    if (!token) { toast('Please paste an access token first.', 'error'); return }
    await analyzeOne(q)
    toast(`Re-QC'd Q${q._qNum ?? ''}.`, 'success')
  }

  function handleFixesUpdated(qId, newFixNeeded) {
    setQcResults(prev => {
      const entry = prev[qId]
      if (!entry) return prev
      return { ...prev, [qId]: { ...entry, analysis: { ...entry.analysis, fix_needed: newFixNeeded } } }
    })
  }

  const entries = useMemo(() => Object.values(qcResults).filter(e => !e.pending), [qcResults])
  const pendingCount = useMemo(() => Object.values(qcResults).filter(e => e.pending).length, [qcResults])
  const failedCount = useMemo(() => entries.filter(e => e.error).length, [entries])
  const { order, bySection } = useMemo(() => groupBySection(entries.map(e => e.question)), [entries])
  const bySectionEntries = useMemo(() => {
    const out = {}
    for (const sec of order) out[sec] = bySection[sec].map(q => entries.find(e => e.question.q_id === q.q_id))
    return out
  }, [order, bySection, entries])

  // Section name -> full question list for that section (from the ORIGINAL questions prop,
  // not just already-analyzed ones) — used by each section's own "Analyze this section" button.
  const questionsBySection = useMemo(() => groupBySection(questions).bySection, [questions])

  function handleExport() {
    if (failedCount > 0) {
      toast(`${failedCount} question(s) failed to analyze — Re-QC them first for a complete report, or export anyway.`, 'error')
    }
    const result = exportQcReportToExcel(qcResults, testLabel)
    if (!result.ok) toast(result.reason, 'error')
    else toast('Excel report downloaded.', 'success')
  }

  const selectedList = questions.filter(q => selected.has(q.q_id))

  return (
    <div className="rounded-xl border border-theme bg-panel p-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h2 className="font-semibold flex items-center gap-2">
          <CheckCircle size={16} className="text-indigo-300" /> QC Analysis
        </h2>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => analyzeMany(selectedList, 'selected')}
            disabled={!!busyLabel || !selectedList.length}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-40"
          >
            {busyLabel === 'selected' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            Analyze Selected ({selectedList.length})
          </button>
          <button
            onClick={() => analyzeMany(questions, 'all')}
            disabled={!!busyLabel}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-40"
          >
            {busyLabel === 'all' ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            Analyze All ({questions.length})
          </button>
          {busyLabel && (
            <button
              onClick={stopAnalysis}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30"
            >
              <StopCircle size={14} /> Stop
            </button>
          )}
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-green-600 hover:opacity-90"
          >
            <FileSpreadsheet size={14} /> Export to Excel
          </button>
        </div>
      </div>

      {busyLabel && progress.total > 0 && (
        <div className="mb-3">
          <p className="text-xs text-muted mb-1.5">
            🤖 Analyzing {progress.done} / {progress.total}… <span className="text-muted2">(Stop halts after the current question)</span>
          </p>
          <div className="h-1.5 rounded-full bg-panel overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-400 to-violet-400 transition-all duration-300"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}
      {!busyLabel && pendingCount > 0 && (
        <p className="text-xs text-muted mb-3 animate-pulse-soft">🤖 Analyzing {pendingCount} question(s)…</p>
      )}
      {failedCount > 0 && (
        <p className="text-xs text-amber-400 mb-3">
          ⚠️ {failedCount} question(s) failed to analyze — use 🔁 Re-QC on each row, or "Analyze All" to retry everything.
        </p>
      )}

      {!entries.length && !pendingCount && (
        <p className="text-sm text-muted2 text-center py-6">No questions analyzed yet — select some above, or hit "Analyze All".</p>
      )}

      {order.map(sectionName => {
        const rows = bySectionEntries[sectionName]
        // Fillups get their own table — split them out first so they don't fall into the
        // coding bucket (which is the catch-all for anything not tagged 'mcq').
        const fillup = rows.filter(e => e.analysis?.category === 'fillup' || e.question.fillup_questions)
        const fillupIds = new Set(fillup.map(e => e.question.q_id))
        const mcq = rows.filter(e => e.analysis?.category === 'mcq' && !fillupIds.has(e.question.q_id))
        const coding = rows.filter(e =>
          !fillupIds.has(e.question.q_id) && (!e.analysis || e.analysis.category !== 'mcq')
        )
        const sectionAllQuestions = questionsBySection[sectionName] || []
        return (
          <div key={sectionName} className="mb-6">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                📂 {sectionName} <span className="text-muted2 font-normal">({rows.length})</span>
              </h3>
              <button
                onClick={() => analyzeMany(sectionAllQuestions, `sec-${sectionName}`)}
                disabled={!!busyLabel}
                className="ml-auto flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-body-app disabled:opacity-40"
              >
                {busyLabel === `sec-${sectionName}` ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}
                Analyze this section
              </button>
            </div>
            {coding.length > 0 && <CodingTable rows={coding} onFixesUpdated={handleFixesUpdated} onRetry={retryOne} />}
            {mcq.length > 0 && <McqTable rows={mcq} onFixesUpdated={handleFixesUpdated} onRetry={retryOne} />}
            {fillup.length > 0 && <FillupTable rows={fillup} onFixesUpdated={handleFixesUpdated} onRetry={retryOne} />}
          </div>
        )
      })}
    </div>
  )
}

function QuestionCell({ q, a, error, onRetry }) {
  const text = stripHtml(q.question_data || '')
  const short = text.length > 55 ? text.slice(0, 55) + '…' : text
  const images = extractImageUrls(q)
  return (
    <td className="px-3 py-2 align-top max-w-[210px]">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[11px] font-mono text-muted2">Q{q._qNum ?? '?'}</span>
        {!error && onRetry && (
          <button onClick={() => onRetry(q)} title="🔁 Re-QC this question (use if the result above looks wrong or incomplete)" className="text-muted2 hover:text-indigo-400 transition">
            <RotateCcw size={11} />
          </button>
        )}
      </div>
      <div className="text-xs text-body-app leading-snug">{a?.one_line_logic || short}</div>
      {a?.incomplete && (
        <div className="text-[10px] text-amber-400 mt-1">⚠️ No checks returned — re-run this one</div>
      )}
      {images.length > 0 && <div className="text-[10px] text-amber-400 mt-1">🖼️ image(s) — verify visually</div>}
      {error && <div className="text-[11px] text-red-400 mt-1">❌ {error}</div>}
    </td>
  )
}

function ErrorRow({ q, error, colSpan, onRetry }) {
  const text = stripHtml(q.question_data || '')
  const short = text.length > 70 ? text.slice(0, 70) + '…' : text
  return (
    <tr>
      <QuestionCell q={q} error={error} />
      <td colSpan={colSpan} className="px-3 py-2.5 align-top">
        <div className="text-red-400 text-sm mb-1.5">❌ {error || 'Analysis failed'}</div>
        <button
          onClick={() => onRetry(q)}
          className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15"
        >
          <RotateCcw size={13} /> Re-QC "{short.slice(0, 30)}{short.length > 30 ? '…' : ''}"
        </button>
      </td>
    </tr>
  )
}

function CodingTable({ rows, onFixesUpdated, onRetry }) {
  const hasSyllabus = rows.some(e => e.analysis?.checks?.syllabus_alignment?.verdict !== 'na' && e.analysis?.checks?.syllabus_alignment)
  const hasDebug = rows.some(e => e.analysis?.checks?.debug_analysis?.verdict !== 'na' && e.analysis?.checks?.debug_analysis)
  const extraCols = (hasSyllabus ? 1 : 0) + (hasDebug ? 1 : 0)
  return (
    <div className="rounded-lg border border-theme overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-muted text-left">
          <tr>
            <th className="px-3 py-2 font-medium">Question</th>
            <th className="px-3 py-2 font-medium">Statement↔Code</th>
            <th className="px-3 py-2 font-medium">Format</th>
            <th className="px-3 py-2 font-medium">Constraints</th>
            <th className="px-3 py-2 font-medium">Test Cases</th>
            {hasSyllabus && <th className="px-3 py-2 font-medium">Syllabus</th>}
            {hasDebug && <th className="px-3 py-2 font-medium">🐞 Debug Errors</th>}
            <th className="px-3 py-2 font-medium">Rating</th>
            <th className="px-3 py-2 font-medium">Fix Needed</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {rows.map((e, i) => {
              const { question: q, analysis: a, error } = e
              if (error || !a) {
                return <ErrorRow key={q.q_id} q={q} error={error} colSpan={5 + extraCols} onRetry={onRetry} />
              }
              const c = a.checks || {}
              return (
                <motion.tr
                  key={q.q_id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 10) * 0.02 }}
                >
                  <QuestionCell q={q} a={a} onRetry={onRetry} />
                  <td className="px-3 py-2.5"><VerdictBadge check={c.statement_code} /></td>
                  <td className="px-3 py-2.5"><VerdictBadge check={c.format} /></td>
                  <td className="px-3 py-2.5"><VerdictBadge check={c.constraints} /></td>
                  <td className="px-3 py-2.5"><VerdictBadge check={c.test_cases} /></td>
                  {hasSyllabus && <td className="px-3 py-2.5"><VerdictBadge check={c.syllabus_alignment} /></td>}
                  {hasDebug && <td className="px-3 py-2.5"><DebugAnalysisBadge check={c.debug_analysis} /></td>}
                  <td className="px-3 py-2.5"><StarRating n={a.rating} /></td>
                  <td className="px-3 py-2.5"><FixNeededCell q={q} analysis={a} onFixesUpdated={onFixesUpdated} /></td>
                </motion.tr>
              )
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}

function McqTable({ rows, onFixesUpdated, onRetry }) {
  const hasSyllabus = rows.some(e => e.analysis?.checks?.syllabus_alignment?.verdict !== 'na' && e.analysis?.checks?.syllabus_alignment)
  return (
    <div className="rounded-lg border border-theme overflow-x-auto mt-3">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-muted text-left">
          <tr>
            <th className="px-3 py-2 font-medium">Question</th>
            <th className="px-3 py-2 font-medium">Answer Correct</th>
            <th className="px-3 py-2 font-medium">Only-One-Correct</th>
            <th className="px-3 py-2 font-medium">Explanation</th>
            {hasSyllabus && <th className="px-3 py-2 font-medium">Syllabus</th>}
            <th className="px-3 py-2 font-medium">Rating</th>
            <th className="px-3 py-2 font-medium">Fix Needed</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {rows.map((e, i) => {
              const { question: q, analysis: a, error } = e
              if (error || !a) {
                return <ErrorRow key={q.q_id} q={q} error={error} colSpan={hasSyllabus ? 5 : 4} onRetry={onRetry} />
              }
              const c = a.checks || {}
              return (
                <motion.tr
                  key={q.q_id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 10) * 0.02 }}
                >
                  <QuestionCell q={q} a={a} onRetry={onRetry} />
                  <td className="px-3 py-2.5"><VerdictBadge check={c.answer_correct} /></td>
                  <td className="px-3 py-2.5"><VerdictBadge check={c.only_one_correct} /></td>
                  <td className="px-3 py-2.5"><VerdictBadge check={c.explanation_check} /></td>
                  {hasSyllabus && <td className="px-3 py-2.5"><VerdictBadge check={c.syllabus_alignment} /></td>}
                  <td className="px-3 py-2.5"><StarRating n={a.rating} /></td>
                  <td className="px-3 py-2.5"><FixNeededCell q={q} analysis={a} onFixesUpdated={onFixesUpdated} /></td>
                </motion.tr>
              )
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}

function FillupTable({ rows, onFixesUpdated, onRetry }) {
  const hasSyllabus = rows.some(e => e.analysis?.checks?.syllabus_alignment?.verdict !== 'na' && e.analysis?.checks?.syllabus_alignment)
  return (
    <div className="rounded-lg border border-theme overflow-x-auto mt-3">
      <table className="w-full text-sm">
        <thead className="bg-panel text-muted text-left">
          <tr>
            <th className="px-3 py-2 font-medium">Question</th>
            <th className="px-3 py-2 font-medium">✏️ Answer</th>
            <th className="px-3 py-2 font-medium">Blank Correct</th>
            <th className="px-3 py-2 font-medium">Explanation</th>
            {hasSyllabus && <th className="px-3 py-2 font-medium">Syllabus</th>}
            <th className="px-3 py-2 font-medium">Rating</th>
            <th className="px-3 py-2 font-medium">Fix Needed</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {rows.map((e, i) => {
              const { question: q, analysis: a, error } = e
              if (error || !a) {
                return <ErrorRow key={q.q_id} q={q} error={error} colSpan={hasSyllabus ? 6 : 5} onRetry={onRetry} />
              }
              const chk = a.checks || {}
              const fd = getFillupData(q)
              const answerText = getFillupAnswerSummary(q)
              // Declared blank count vs. underscores actually present in the statement — a
              // mismatch is a common authoring slip, so surface it even before the AI verdict.
              const blankMismatch = fd && fd.declaredBlanks != null && fd.blanksInStatement > 0 &&
                fd.declaredBlanks !== fd.blanksInStatement
              return (
                <motion.tr key={q.q_id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 10) * 0.02 }}>
                  <QuestionCell q={q} a={a} onRetry={onRetry} />
                  <td className="px-3 py-2.5 align-top max-w-[180px]">
                    <code className="text-[11px] text-emerald-300 break-words">{answerText || '—'}</code>
                    <div className="text-[10px] text-muted2 mt-1">
                      {fd?.declaredBlanks != null && <>blanks: {fd.declaredBlanks}</>}
                      {blankMismatch && <span className="text-amber-400"> ⚠️ statement has {fd.blanksInStatement}</span>}
                      {fd?.caseSensitive ? ' · case-sensitive' : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2.5"><VerdictBadge check={chk.blank_answer} /></td>
                  <td className="px-3 py-2.5"><VerdictBadge check={chk.explanation_check} /></td>
                  {hasSyllabus && <td className="px-3 py-2.5"><VerdictBadge check={chk.syllabus_alignment} /></td>}
                  <td className="px-3 py-2.5"><StarRating n={a.rating} /></td>
                  <td className="px-3 py-2.5"><FixNeededCell q={q} analysis={a} onFixesUpdated={onFixesUpdated} /></td>
                </motion.tr>
              )
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}
