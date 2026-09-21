import { useEffect, useMemo, useRef, useState } from 'react' 
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Loader2, Landmark, FileText, Telescope, RotateCcw, FolderOpen, Target, Check,
  FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, Minus, StopCircle, ArrowLeftCircle, History, Download, Trash2
} from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useToast } from '../../context/ToastContext'
import { api, decodeJwtPayload } from '../../lib/api'
import { stripHtml, parseCsv, groupBySection, assignSectionQuestionNumbers, getSolutionCode } from '../../lib/helpers'
import { exportTopicReportToExcel, exportStoredTopicReport } from '../../lib/excel'
import QuestionPicker from '../../components/QuestionPicker'
import { StepHeader, StepNav } from '../../components/Stepper'
import SectionSwitcherBar from '../../components/SectionSwitcherBar'
import SkeletonRows from '../../components/SkeletonRows'

const STEPS = [
  { id: 'source', label: 'Pick Source', icon: FileText },
  { id: 'section', label: 'Choose Section', icon: FolderOpen },
  { id: 'scope', label: 'Topic Scope', icon: Target },
  { id: 'run', label: 'Analyse', icon: Telescope }
]

function parseQuestionsByTestResponse(root) {
  const arr = Array.isArray(root) ? root : Array.isArray(root?.results) ? root.results : Array.isArray(root?.data) ? root.data : null
  if (!arr) return []
  const merged = []
  for (const section of arr) {
    if (!section || typeof section !== 'object') continue
    const sectionName = section.name || 'Section'
    const lists = [
      ...(Array.isArray(section.non_group_questions) ? section.non_group_questions : []),
      ...(Array.isArray(section.group_questions) ? section.group_questions : [])
    ]
    for (const q of lists) {
      if (q && typeof q === 'object' && q.q_id) {
        if (!q._sectionName) q._sectionName = sectionName
        merged.push(q)
      }
    }
  }
  return merged
}

const VERDICT_META = {
  pass: { icon: CheckCircle2, cls: 'text-emerald-400', label: 'In scope' },
  fail: { icon: XCircle, cls: 'text-red-400', label: 'Out of scope' },
  warn: { icon: AlertTriangle, cls: 'text-amber-400', label: 'Borderline' },
  na: { icon: Minus, cls: 'text-muted2', label: 'Not checked' }
}

export default function TopicAnalyserPage() {
  const { token, deptIds } = useApp()
  const toast = useToast()

  const [step, setStep] = useState(0)
  const [furthest, setFurthest] = useState(0)

  const [mode, setMode] = useState('test')
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState([])
  const [searching, setSearching] = useState(false)
  const [opening, setOpening] = useState(null)
  const [error, setError] = useState('')

  const [source, setSource] = useState(null)
  const [questions, setQuestions] = useState([])
  const [activeSections, setActiveSections] = useState([])

  const [topicsIncluded, setTopicsIncluded] = useState('')
  const [topicsRestricted, setTopicsRestricted] = useState('')
  const [results, setResults] = useState({})
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const cancelRef = useRef(false)

  // Report history — null while unknown, false when the backend has no
  // DATABASE_URL configured, true once it answers.
  const [history, setHistory] = useState([])
  const [historyEnabled, setHistoryEnabled] = useState(null)

  const scopeGiven = !!(topicsIncluded.trim() || topicsRestricted.trim())
  const { order, bySection } = useMemo(() => groupBySection(questions), [questions])
  // Multi-select: analyse several sections in one pass. Falls back to the first section
  // until a choice is made so the list is never empty.
  const chosenSections = activeSections.filter(s => order.includes(s))
  const effectiveSections = chosenSections.length ? chosenSections : order.slice(0, 1)
  const sectionKey = effectiveSections.join('|')
  // Memoised on a string key — bySection[...] arrays are fresh references each render and
  // would otherwise defeat the tally's useMemo below.
  const sectionQuestions = useMemo(
    () => effectiveSections.flatMap(s => bySection[s] || []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bySection, sectionKey]
  )
  const sectionLabel = effectiveSections.length === 1 ? effectiveSections[0] : `${effectiveSections.length} sections`

  function toggleSectionChoice(name) {
    setActiveSections(cur => {
      const base = cur.filter(s => order.includes(s))
      const list = base.length ? base : effectiveSections
      const next = list.includes(name) ? list.filter(s => s !== name) : [...list, name]
      return next.length ? next : [name]
    })
  }

  function goTo(i) {
    setStep(i)
    setFurthest(f => Math.max(f, i))
  }

  async function runSearch() {
    if (!token) { setError('Paste an access token first.'); return }
    if (!term.trim() && mode === 'qb') return
    setSearching(true); setError('')
    try {
      if (mode === 'test') {
        const body = { branch_id: 'All', department_id: deptIds, limit: 25, mainDepartmentUser: true, page: 1 }
        if (term.trim()) body.search = term.trim()
        const data = await api.searchTests(token, body)
        const r = data.results || data.data || data
        const rows = Array.isArray(r) ? r
          : Array.isArray(r?.tests) ? r.tests
          : Array.isArray(r?.testList) ? r.testList
          : Array.isArray(r?.data) ? r.data
          : []
        setHits(rows.map(t => ({
          id: t._id || t.test_id || t.testId || t.id,
          name: t.testName || t.test_name || t.t_name || t.name || '(unnamed)',
          meta: t.testType || t.test_type || ''
        })))
      } else {
        const data = await api.searchQuestionBanks(token, {
          branch_id: 'all', department_id: deptIds, limit: 30, mainDepartmentUser: true, page: 1, visibility: 'All', search: term.trim()
        })
        setHits((data.results?.questionbanks || []).map(qb => ({
          id: qb.qb_id,
          name: qb.qb_name || qb.qb_code || qb.qb_id,
          meta: qb.questionCount != null ? `${qb.questionCount} q` : ''
        })))
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSearching(false)
    }
  }

  async function openSource(hit) {
    setOpening(hit.id); setError('')
    try {
      let merged = []
      if (mode === 'test') {
        merged = parseQuestionsByTestResponse(await api.getQuestionsForTest(token, hit.id))
      } else {
        const data = await api.getQuestionsForQb(token, hit.id, 150)
        const r = data.results || data
        merged = r.non_group_questions || r.questions || []
        merged.forEach(x => { x._qb_name = hit.name })
      }
      if (!merged.length) { setError('No questions found for that selection.'); return }
      assignSectionQuestionNumbers(merged)
      setQuestions(merged)
      setSource({ label: hit.name, kind: mode })
      setResults({})
      setActiveSections([])
      goTo(1)
      toast(`Loaded ${merged.length} question(s) from "${hit.name}".`, 'success')
    } catch (err) {
      setError(err.message)
    } finally {
      setOpening(null)
    }
  }

  async function checkOne(q) {
    const data = await api.topicAlignCheck(token, {
      question_text: stripHtml(q.question_data || ''),
      solution_code: getSolutionCode(q),
      question_type: q.question_type,
      topics_included: parseCsv(topicsIncluded),
      topics_excluded: parseCsv(topicsRestricted)
    })
    return { verdict: data.verdict || 'na', note: data.note || '' }
  }

  async function analyzeAll(list) {
    if (!token) { toast('Paste an access token first.', 'error'); return }
    if (!scopeGiven) { toast('Enter at least one allowed or restricted topic first.', 'error'); return }
    if (!list.length) return

    cancelRef.current = false
    setRunning(true)
    setProgress({ done: 0, total: list.length })
    let done = 0
    for (const q of list) {
      if (cancelRef.current) break
      try {
        const r = await checkOne(q)
        setResults(prev => ({ ...prev, [q.q_id]: r }))
      } catch (err) {
        setResults(prev => ({ ...prev, [q.q_id]: { verdict: 'error', note: err.message } }))
      }
      done++
      setProgress({ done, total: list.length })
    }
    const stopped = cancelRef.current
    cancelRef.current = false
    setRunning(false)
    toast(
      stopped ? `Stopped after ${done} of ${list.length}.` : `Checked ${list.length} question(s).`,
      stopped ? 'info' : 'success'
    )

    // Only a run that actually finished is worth keeping — a partial sweep
    // would sit in history looking like a full report. Read from the state
    // updater rather than `results`, which is stale in this closure.
    if (!stopped) {
      setResults(current => { saveToHistory(list, current); return current })
    }
  }

  // Fire-and-forget: history is a convenience, so a database that's missing
  // or down must never turn a completed analysis into an error.
  async function saveToHistory(list, resultMap) {
    if (historyEnabled === false) return
    try {
      const rows = list.map(q => ({
        q_id: q.q_id,
        qNum: q._qNum ?? null,
        section: q._sectionName || q._qb_name || null,
        type: q.question_type || null,
        statement: stripHtml(q.question_data || '').slice(0, 400),
        ...(resultMap[q.q_id] || {})
      }))
      const flagged = rows.filter(r => r.verdict && r.verdict !== 'pass').length
      const scope = {
        included: parseCsv(topicsIncluded),
        restricted: parseCsv(topicsRestricted)
      }
      const saved = await api.saveTopicReport({
        sourceLabel: source?.label || 'Untitled',
        sourceKind: source?.kind || null,
        scope: [
          scope.included.length ? 'Allowed: ' + scope.included.join(', ') : '',
          scope.restricted.length ? 'Restricted: ' + scope.restricted.join(', ') : ''
        ].filter(Boolean).join(' | '),
        total: rows.length,
        flagged,
        createdBy: decodeJwtPayload(token)?.name || null,
        report: { scope, rows }
      })
      if (saved?.ok) {
        setHistoryEnabled(true)
        toast('Report saved to history.', 'info')
        loadHistory()
      }
    } catch (err) {
      // 503 = no DATABASE_URL. Not a failure worth shouting about; just stop
      // offering history for the rest of the session.
      if (err?.data?.enabled === false) setHistoryEnabled(false)
      else console.warn('Could not save report to history:', err.message)
    }
  }

  async function loadHistory() {
    try {
      const r = await api.listTopicReports()
      setHistory(r.reports || [])
      setHistoryEnabled(true)
    } catch (err) {
      if (err?.data?.enabled === false) setHistoryEnabled(false)
    }
  }

  // Re-export a stored report without re-running the analysis, which costs
  // AI calls and several minutes.
  async function downloadFromHistory(row) {
    try {
      const r = await api.getTopicReport(row.id)
      const stored = r.report?.report
      if (!stored?.rows?.length) { toast('That report has no stored rows.', 'error'); return }
      const res = exportStoredTopicReport(stored, row.source_label)
      if (!res.ok) toast(res.reason, 'error')
      else toast('Report downloaded.', 'success')
    } catch (err) {
      toast('Could not download that report: ' + err.message, 'error')
    }
  }

  // Probe once on mount so the panel can say "not configured" instead of
  // silently showing nothing when there's no DATABASE_URL.
  useEffect(() => {
    let alive = true
    api.historyStatus()
      .then(s => {
        if (!alive) return
        setHistoryEnabled(!!s.enabled && !!s.connected)
        if (s.enabled && s.connected) loadHistory()
      })
      .catch(() => { if (alive) setHistoryEnabled(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function removeFromHistory(row) {
    try {
      await api.deleteTopicReport(row.id)
      setHistory(h => h.filter(x => x.id !== row.id))
      toast('Report removed from history.', 'info')
    } catch (err) {
      toast('Could not delete: ' + err.message, 'error')
    }
  }

  function stopAnalysis() {
    cancelRef.current = true
    toast('Stopping after the current question…', 'info')
  }

  async function recheckOne(q) {
    if (!scopeGiven) { toast('Enter at least one topic first.', 'error'); return }
    setResults(prev => ({ ...prev, [q.q_id]: { verdict: 'pending', note: '' } }))
    try {
      const r = await checkOne(q)
      setResults(prev => ({ ...prev, [q.q_id]: r }))
    } catch (err) {
      setResults(prev => ({ ...prev, [q.q_id]: { verdict: 'error', note: err.message } }))
    }
  }

  const tally = useMemo(() => {
    const t = { pass: 0, fail: 0, warn: 0, error: 0, unchecked: 0 }
    for (const q of sectionQuestions) {
      const r = results[q.q_id]
      if (!r) t.unchecked++
      else if (t[r.verdict] !== undefined) t[r.verdict]++
    }
    return t
  }, [sectionQuestions, results])

  function handleExport(scopeToSection) {
    const list = scopeToSection ? sectionQuestions : questions
    const res = exportTopicReportToExcel(list, results, source?.label, {
      included: parseCsv(topicsIncluded),
      restricted: parseCsv(topicsRestricted)
    })
    if (!res.ok) toast(res.reason, 'error')
    else toast('Topic report downloaded.', 'success')
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold mb-0.5 flex items-center gap-2">
            <Telescope size={22} className="text-accent-pill" />
            {source ? source.label : 'Topic Analyser'}
          </h1>
          <p className="text-sm text-muted">
            {source
              ? `${questions.length} question(s) across ${order.length} section(s)`
              : 'Check a test or question bank against a syllabus scope.'}
          </p>
        </div>
        {source && (
          <button
            onClick={() => { setSource(null); setQuestions([]); setResults({}); goTo(0) }}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg bg-panel bg-panel-hover text-muted"
          >
            <ArrowLeftCircle size={16} /> Different source
          </button>
        )}
      </div>

      <StepHeader steps={STEPS} current={step} furthest={furthest} onGo={goTo} />

      <AnimatePresence mode="wait">
        {/* ================= STEP 1 — source ================= */}
        {step === 0 && (
          <motion.div key="source" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} className="flex flex-col gap-4">
            <div className="flex gap-2">
              <div className="flex rounded-lg border border-theme overflow-hidden shrink-0">
                {[['test', 'Test', FileText], ['qb', 'Question Bank', Landmark]].map(([id, label, Icon]) => (
                  <button
                    key={id}
                    onClick={() => { setMode(id); setHits([]) }}
                    className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition ${
                      mode === id ? 'bg-accent-pill text-accent-pill' : 'text-muted bg-panel-hover'
                    }`}
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted2 pointer-events-none" />
                <input
                  value={term}
                  onChange={e => setTerm(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && runSearch()}
                  placeholder={mode === 'test' ? 'Search tests by name…' : 'Search question banks…'}
                  className="input"
                  style={{ paddingLeft: '2.25rem' }}
                />
              </div>
              <button onClick={runSearch} disabled={searching} className="px-4 py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-sm font-semibold disabled:opacity-50">
                {searching ? <Loader2 size={16} className="animate-spin" /> : 'Search'}
              </button>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}
            {searching && !hits.length && <SkeletonRows />}

            {hits.length > 0 && (
              <div className="rounded-xl border border-theme overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-panel text-muted text-left">
                    <tr>
                      <th className="px-4 py-2 font-medium">{mode === 'test' ? 'Test Name' : 'Question Bank'}</th>
                      <th className="px-4 py-2 font-medium">Info</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((h, i) => (
                      <tr key={h.id || i} className="bg-panel-hover">
                        <td className="px-4 py-2.5">{h.name}</td>
                        <td className="px-4 py-2.5 text-muted2">{h.meta || '—'}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => openSource(h)} disabled={opening === h.id} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent-pill text-accent-pill disabled:opacity-50">
                            {opening === h.id ? 'Opening…' : 'Open'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        )}

        {/* ================= STEP 2 — section ================= */}
        {step === 1 && (
          <motion.div key="section" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} className="flex flex-col gap-4">
            <div className="grid lg:grid-cols-[1fr_260px] gap-4 items-start">
              <div className="rounded-xl border border-theme bg-panel p-4 order-2 lg:order-1 min-w-0">
                <h3 className="text-xs font-semibold uppercase text-muted mb-3">
                  Questions in scope <span className="text-muted2 font-normal normal-case">({sectionQuestions.length})</span>
                </h3>
                <QuestionPicker
                  questions={sectionQuestions}
                  mode="view"
                  variant="detailed"
                  onView={() => {}}
                  emptyLabel="Pick a section on the right to see its questions."
                />
              </div>

              <div className="rounded-xl border border-theme bg-panel p-4 order-1 lg:order-2 lg:sticky lg:top-20">
                <h3 className="text-xs font-semibold uppercase text-muted mb-2">📂 Sections</h3>
                <p className="text-[11px] text-muted2 mb-3">Tick one or more to analyse together.</p>
                <div className="flex flex-col gap-1 max-h-[50vh] overflow-y-auto">
                  {order.map(name => {
                    const on = effectiveSections.includes(name)
                    return (
                      <button
                        key={name}
                        onClick={() => toggleSectionChoice(name)}
                        className={`flex items-center gap-2 text-left px-2.5 py-2 rounded-lg text-sm transition ${
                          on ? 'bg-accent-pill text-accent-pill' : 'text-muted bg-panel-hover'
                        }`}
                      >
                        <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          on ? 'bg-indigo-500 border-indigo-400' : 'border-white/25'
                        }`}>
                          {on && <Check size={11} className="text-white" />}
                        </span>
                        <span className="flex-1 min-w-0 truncate">{name}</span>
                        <span className="text-[10px] text-muted2 shrink-0">{bySection[name].length}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="mt-3 pt-3 border-t border-theme text-[11px] text-muted2">
                  {sectionQuestions.length} question(s) selected
                </div>
              </div>
            </div>

            <StepNav onBack={() => goTo(0)} backLabel="Back to source" onNext={() => goTo(2)} nextLabel="Set topic scope" nextDisabled={!sectionQuestions.length} />
          </motion.div>
        )}

        {/* ================= STEP 3 — scope ================= */}
        {step === 2 && (
          <motion.div key="scope" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} className="flex flex-col gap-4">
            <div className="rounded-xl border border-theme bg-panel p-5">
              <h2 className="font-semibold mb-1">Topic scope</h2>
              <p className="text-sm text-muted mb-4">
                At least one list is required — questions are judged against these.
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted">✅ Allowed topics</span>
                  <input value={topicsIncluded} onChange={e => setTopicsIncluded(e.target.value)} placeholder="e.g. arrays, loops, if-else, strings" className="input" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted">⛔ Restricted / future topics</span>
                  <input value={topicsRestricted} onChange={e => setTopicsRestricted(e.target.value)} placeholder="e.g. recursion, OOP, collections" className="input" />
                </label>
              </div>
              <div className="mt-4 text-xs text-muted2">
                Analysing <b className="text-body-app">{sectionLabel}</b> — {sectionQuestions.length} question(s).
              </div>
            </div>

            <StepNav onBack={() => goTo(1)} backLabel="Back to section" onNext={() => goTo(3)} nextLabel="Go to analysis" nextDisabled={!scopeGiven} />
          </motion.div>
        )}

        {/* ================= STEP 4 — run ================= */}
        {step === 3 && (
          <motion.div key="run" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} className="flex flex-col gap-4">
            <SectionSwitcherBar
              order={order}
              bySection={bySection}
              active={effectiveSections}
              results={results}
              onToggle={toggleSectionChoice}
              onSetOnly={name => setActiveSections([name])}
            />

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => analyzeAll(sectionQuestions)}
                disabled={running || !scopeGiven}
                className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 hover:opacity-90 disabled:opacity-40"
              >
                {running ? <Loader2 size={15} className="animate-spin" /> : <Telescope size={15} />}
                Analyse {sectionLabel} ({sectionQuestions.length})
              </button>
              {running && (
                <button onClick={stopAnalysis} className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30">
                  <StopCircle size={15} /> Stop
                </button>
              )}
              <button onClick={() => handleExport(true)} className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-gradient-to-r from-emerald-600 to-green-600 hover:opacity-90">
                <FileSpreadsheet size={15} /> Export section
              </button>
              <button onClick={() => handleExport(false)} className="text-sm font-medium px-3 py-2.5 rounded-lg bg-panel bg-panel-hover text-muted">
                Export whole source
              </button>
            </div>

            {running && progress.total > 0 && (
              <div>
                <p className="text-xs text-muted mb-1.5">
                  Analysing {progress.done} / {progress.total}… <span className="text-muted2">(Stop halts after the current question)</span>
                </p>
                <div className="h-1.5 rounded-full bg-panel overflow-hidden">
                  <motion.div className="h-full bg-gradient-to-r from-indigo-400 to-violet-400" animate={{ width: `${(progress.done / progress.total) * 100}%` }} transition={{ duration: 0.25 }} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <Tally label="In scope" value={tally.pass} cls="text-emerald-400" />
              <Tally label="Out of scope" value={tally.fail} cls="text-red-400" />
              <Tally label="Borderline" value={tally.warn} cls="text-amber-400" />
              <Tally label="Failed" value={tally.error} cls="text-red-300" />
              <Tally label="Unchecked" value={tally.unchecked} cls="text-muted2" />
            </div>

            {/* Saved reports. A completed run is stored automatically, so a
                report can be re-downloaded later without paying for the AI
                calls and minutes a re-run would cost. */}
            <div className="rounded-lg border border-theme bg-panel p-3">
              <div className="flex items-center gap-2 mb-2">
                <History size={14} className="text-muted2" />
                <span className="text-xs font-semibold text-muted">Report history</span>
                {historyEnabled && (
                  <button onClick={loadHistory} className="ml-auto text-[11px] text-muted2 hover-strong">refresh</button>
                )}
              </div>

              {historyEnabled === null && <p className="text-xs text-muted2">Checking…</p>}

              {historyEnabled === false && (
                <p className="text-xs text-muted2">
                  Not configured. Set <code className="mx-1 px-1 rounded bg-black/30">DATABASE_URL</code>
                  on the server to save reports for later download. Everything else works without it.
                </p>
              )}

              {historyEnabled === true && history.length === 0 && (
                <p className="text-xs text-muted2">No saved reports yet — finish an analysis and it lands here.</p>
              )}

              {historyEnabled === true && history.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
                  {history.map(row => (
                    <div key={row.id} className="flex items-center gap-2 rounded-md border border-theme bg-surface px-2.5 py-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-body-app truncate">{row.source_label}</p>
                        <p className="text-[10px] text-muted2">
                          {new Date(row.created_at).toLocaleString()} · {row.total} question(s) ·{' '}
                          <span className={row.flagged ? 'text-amber-400' : 'text-emerald-400'}>
                            {row.flagged} flagged
                          </span>
                          {row.created_by ? ` · ${row.created_by}` : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => downloadFromHistory(row)}
                        title="Download this report as Excel"
                        className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md bg-panel bg-panel-hover text-muted flex items-center gap-1"
                      >
                        <Download size={12} /> Excel
                      </button>
                      <button
                        onClick={() => removeFromHistory(row)}
                        title="Delete from history"
                        className="shrink-0 text-muted2 hover-strong p-1 rounded-md"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-theme overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-panel text-muted text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium w-16">Q#</th>
                    <th className="px-3 py-2 font-medium">Question</th>
                    <th className="px-3 py-2 font-medium w-36">Verdict</th>
                    <th className="px-3 py-2 font-medium">Finding</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence initial={false}>
                    {sectionQuestions.map((q, i) => {
                      const r = results[q.q_id]
                      const meta = VERDICT_META[r?.verdict] || VERDICT_META.na
                      const Icon = meta.icon
                      const text = stripHtml(q.question_data || '')
                      return (
                        <motion.tr key={q.q_id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, delay: Math.min(i, 10) * 0.015 }}>
                          <td className="px-3 py-2 align-top">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] font-mono text-muted2">Q{q._qNum ?? '?'}</span>
                              {r && r.verdict !== 'pending' && (
                                <button onClick={() => recheckOne(q)} title="Re-check this question" className="text-muted2 hover:text-indigo-400">
                                  <RotateCcw size={11} />
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top max-w-[380px]">
                            <div className="text-xs text-body-app leading-snug">{text.length > 130 ? text.slice(0, 130) + '…' : text}</div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            {r?.verdict === 'pending' ? <Loader2 size={14} className="animate-spin text-indigo-400" />
                              : r?.verdict === 'error' ? <span className="text-xs text-red-400">Failed</span>
                              : <span className={`flex items-center gap-1.5 text-xs font-medium ${meta.cls}`}><Icon size={14} /> {meta.label}</span>}
                          </td>
                          <td className="px-3 py-2 align-top text-xs text-muted leading-snug">{r?.note || (r ? '' : '—')}</td>
                        </motion.tr>
                      )
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>

            <StepNav onBack={() => goTo(2)} backLabel="Back to topics" hideNext>
              <button onClick={() => goTo(1)} className="text-sm font-medium px-4 py-2.5 rounded-lg bg-panel bg-panel-hover text-muted">
                Switch section
              </button>
            </StepNav>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Tally({ label, value, cls }) {
  return (
    <div className="rounded-xl border border-theme bg-panel px-3 py-2.5 text-center">
      <div className={`text-xl font-bold ${cls}`}>{value}</div>
      <div className="text-[10px] text-muted2 tracking-wide uppercase mt-0.5">{label}</div>
    </div>
  )
}
