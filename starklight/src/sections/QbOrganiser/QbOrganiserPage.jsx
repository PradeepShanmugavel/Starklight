import { useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Loader2, Landmark, FolderTree, ListTree, ClipboardCheck, PlayCircle,
  CheckCircle2, XCircle, AlertTriangle, StopCircle, ArrowLeftCircle,
  Plus, Trash2, Download, Copy, ClipboardPaste, Sparkles
} from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import {
  stripHtml, parseQuestionNumbers, parsePastedPlan,
  SEGREGATION_PROMPT, moveTypeFor, typeSlugFor, MOVE_TYPE_GUESSED
} from '../../lib/helpers'
import { copyRich } from '../../lib/clipboard'
import { StepHeader, StepNav } from '../../components/Stepper'
import SkeletonRows from '../../components/SkeletonRows'

const STEPS = [
  { id: 'source', label: 'Source Bank', icon: Landmark },
  { id: 'plan', label: 'Destinations', icon: ListTree },
  { id: 'review', label: 'Check', icon: ClipboardCheck },
  { id: 'run', label: 'Move', icon: PlayCircle }
]

// Questions per questionMove call. The endpoint puts every id in the query
// string, so an unbounded list would eventually exceed the URL limit.
const MOVE_BATCH = 20

export default function QbOrganiserPage() {
  const { token, deptIds } = useApp()
  const toast = useToast()

  const [step, setStep] = useState(0)
  const [furthest, setFurthest] = useState(0)

  // ---- source ----
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState([])
  const [searching, setSearching] = useState(false)
  const [loadingSrc, setLoadingSrc] = useState('')
  const [error, setError] = useState('')
  const [source, setSource] = useState(null)
  const [questions, setQuestions] = useState([])

  // ---- destinations ----
  const [dests, setDests] = useState([])
  const [resolvingIdx, setResolvingIdx] = useState(null)
  const [pickOptions, setPickOptions] = useState({}) // row index -> candidate banks

  // ---- prompt / paste helpers ----
  const [showPrompt, setShowPrompt] = useState(false)
  const [pasteText, setPasteText] = useState('')

  // ---- validation / run ----
  const [problems, setProblems] = useState(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [log, setLog] = useState([])
  const [lastRun, setLastRun] = useState(null)
  const cancelRef = useRef(false)

  function goTo(i) { setStep(i); setFurthest(f => Math.max(f, i)) }
  function pushLog(line) { setLog(l => [...l, line]) }

  // ================= STEP 1 — source =================
  async function runSearch() {
    if (!token) { setError('Paste an access token first.'); return }
    if (!term.trim()) return
    setSearching(true); setError('')
    try {
      const data = await api.searchQuestionBanks(token, {
        branch_id: 'all', department_id: deptIds, limit: 30,
        mainDepartmentUser: true, page: 1, visibility: 'All', search: term.trim()
      })
      const qbs = data.results?.questionbanks || []
      setHits(qbs)
      if (!qbs.length) setError('No banks matched that search.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSearching(false)
    }
  }

  // Fetch EVERY question, page by page. A single large `limit` is not reliable:
  // the endpoint is paginated, and a truncated list would mean the question
  // numbers here silently disagree with the portal.
  async function fetchAllQuestions(qb_id, onProgress) {
    const PAGE_SIZE = 100
    const MAX_PAGES = 200 // hard stop so a bad count can't loop forever
    let page = 1, all = [], reported = null

    while (page <= MAX_PAGES) {
      const data = await api.getQuestionsForQb(token, qb_id, PAGE_SIZE, page)
      const r = data.results || data
      const rows = r.non_group_questions || r.questions || []
      if (reported === null && typeof r.count === 'number') reported = r.count
      all = all.concat(rows)
      onProgress?.(all.length, reported)
      if (rows.length < PAGE_SIZE) break
      if (reported !== null && all.length >= reported) break
      page++
    }

    // De-duplicate on q_id — an overlap between pages would shift every
    // question number after it.
    const seen = new Set(), unique = []
    for (const q of all) {
      if (q?.q_id && !seen.has(q.q_id)) { seen.add(q.q_id); unique.push(q) }
    }
    return { questions: unique, reported }
  }

  async function openSource(qb) {
    setError(''); setLoadingSrc(qb.qb_id)
    try {
      const res = await fetchAllQuestions(qb.qb_id, (sofar, total) =>
        setLoadingSrc(`${qb.qb_id}|${sofar}${total ? '/' + total : ''}`))
      const rows = res.questions
      if (!rows.length) { setError('That bank has no questions.'); return }
      rows.forEach((q, i) => { q._qNum = i + 1 })

      setSource({ qb_id: qb.qb_id, qb_name: qb.qb_name, reported: res.reported })
      setQuestions(rows)
      setDests([{ name: '', qb_id: null, numbersText: '', resolved: false, error: null }])
      setProblems(null); setLog([]); setLastRun(null)
      goTo(1)
      toast(`Loaded all ${rows.length} question(s) from "${qb.qb_name}".`, 'success')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingSrc('')
    }
  }

  // ================= STEP 2 — destinations =================
  function addDest() {
    setDests(d => [...d, { name: '', qb_id: null, numbersText: '', resolved: false, error: null }])
  }
  function removeDest(i) { setDests(d => d.filter((_, idx) => idx !== i)) }
  function patchDest(i, patch) {
    setDests(d => d.map((row, idx) => idx === i ? { ...row, ...patch } : row))
  }

  // Destination banks already exist, so a typed name is resolved to its id.
  async function resolveDest(i) {
    const d = dests[i]
    if (!d.name.trim()) return
    if (!token) { toast('Paste an access token first.', 'error'); return }
    setResolvingIdx(i)
    setPickOptions(p => ({ ...p, [i]: null }))
    try {
      const data = await api.searchQuestionBanks(token, {
        branch_id: 'all', department_id: deptIds, limit: 30,
        mainDepartmentUser: true, page: 1, visibility: 'All', search: d.name.trim()
      })
      const qbs = data.results?.questionbanks || []
      const wanted = d.name.trim().toLowerCase()
      const exact = qbs.filter(q => String(q.qb_name).trim().toLowerCase() === wanted)

      if (exact.length === 1) patchDest(i, { qb_id: exact[0].qb_id, name: exact[0].qb_name, resolved: true, error: null })
      else if (exact.length > 1) patchDest(i, { resolved: false, error: 'several banks share that exact name' })
      else if (qbs.length === 1) patchDest(i, { qb_id: qbs[0].qb_id, name: qbs[0].qb_name, resolved: true, error: null })
      else if (qbs.length > 1) {
        // Ambiguous — let the user choose rather than guessing which they meant.
        setPickOptions(p => ({ ...p, [i]: qbs.slice(0, 8) }))
        patchDest(i, { resolved: false, error: null })
      }
      else patchDest(i, { resolved: false, error: 'no bank found with that name' })
    } catch (err) {
      patchDest(i, { resolved: false, error: err.message })
    } finally {
      setResolvingIdx(null)
    }
  }

  async function resolveAll() {
    for (let i = 0; i < dests.length; i++) {
      if (dests[i].name.trim() && !dests[i].resolved) await resolveDest(i)
    }
  }

  // Paste an AI answer in the "Bank name: 1, 4, 7" format and turn it into rows.
  function applyPaste() {
    const rows = parsePastedPlan(pasteText)
    if (!rows.length) {
      toast('Nothing readable — each line needs to look like "ml_Regression - 1, 4, 9".', 'error')
      return
    }
    setDests(rows.map(r => ({ ...r, qb_id: null, resolved: false, error: null })))
    setPasteText('')
    setProblems(null)
    toast(`Read ${rows.length} destination(s). Now press "Find all banks".`, 'success')
  }

  // The question list to paste under the prompt.
  const questionListText = useMemo(
    () => questions.map(q => `${q._qNum}. (${typeSlugFor(q.question_type)}) ${stripHtml(q.question_data || '').slice(0, 160)}`).join('\n'),
    [questions]
  )

  // Which source questions are already spoken for (drives the chip highlight).
  const assignedNums = useMemo(() => {
    const s = new Set()
    dests.forEach(d => parseQuestionNumbers(d.numbersText).nums.forEach(n => s.add(n)))
    return s
  }, [dests])

  // ================= STEP 3 — validate =================
  function validateAll() {
    const found = []
    const claimed = new Map()
    let planned = 0
    const prepared = dests.map((d, i) => {
      const label = d.name.trim() || `destination #${i + 1}`
      const { nums, bad } = parseQuestionNumbers(d.numbersText)

      if (!d.name.trim()) found.push(`Destination #${i + 1} has no bank name.`)
      else if (!d.resolved) found.push(`"${label}" hasn't been found yet — press "Find bank".`)
      if (!nums.length) found.push(`"${label}" has no question numbers.`)
      if (bad.length) found.push(`"${label}": couldn't read ${bad.join(', ')}.`)

      const outOfRange = nums.filter(n => n < 1 || n > questions.length)
      if (outOfRange.length) {
        found.push(`"${label}": the source has ${questions.length} questions, so ${outOfRange.join(', ')} doesn't exist.`)
      }
      nums.forEach(n => {
        if (claimed.has(n)) found.push(`Q${n} is listed twice — "${claimed.get(n)}" and "${label}". A question can only go to one bank.`)
        else claimed.set(n, label)
      })

      const qs = nums.filter(n => n >= 1 && n <= questions.length).map(n => questions[n - 1])
      planned += qs.length
      return { ...d, questions: qs }
    })

    if (prepared.some(d => d.resolved && d.qb_id === source?.qb_id)) {
      found.push('One destination is the same bank as the source.')
    }

    setDests(prepared)
    setProblems({ list: found, planned, untouched: questions.length - claimed.size })
    goTo(2)
  }

  // ================= STEP 4 — move =================
  async function runMoves() {
    if (!token) { toast('Paste an access token first.', 'error'); return }
    cancelRef.current = false
    setRunning(true); setLog([])

    const total = dests.reduce((n, d) => n + (d.questions?.length || 0), 0)
    setProgress({ done: 0, total })
    let overall = 0
    const rows = []

    pushLog(`Source: ${source.qb_name} (${source.qb_id})`)
    pushLog(`${dests.length} destination(s), ${total} question(s) to move.`)
    pushLog('')

    for (const d of dests) {
      if (cancelRef.current) break
      let moved = 0, failed = null

      // Batch by question TYPE so the positional q_type array is always
      // uniform, then by size so the query string can't overflow.
      const byType = new Map()
      for (const q of d.questions) {
        const t = moveTypeFor(q.question_type)
        if (!byType.has(t)) byType.set(t, [])
        byType.get(t).push(q)
      }

      for (const [type, list] of byType) {
        if (cancelRef.current) break
        for (let i = 0; i < list.length; i += MOVE_BATCH) {
          if (cancelRef.current) break
          const batch = list.slice(i, i + MOVE_BATCH)
          const q_ids = batch.map(q => q.q_id)
          try {
            await api.moveQuestions(token, {
              q_ids, q_types: batch.map(() => type),
              qb_id: d.qb_id, current_qb_id: source.qb_id
            })
            moved += batch.length
          } catch {
            // mcq/fillup move types are inferred — retry once with the raw type.
            try {
              await api.moveQuestions(token, {
                q_ids, q_types: batch.map(q => q.question_type),
                qb_id: d.qb_id, current_qb_id: source.qb_id
              })
              moved += batch.length
              pushLog(`  retried with raw type "${batch[0].question_type}" — ok`)
            } catch (err2) {
              failed = err2.message
              pushLog(`  FAILED (${type}, Q${batch.map(q => q._qNum).join(',')}): ${err2.message}`)
              break
            }
          }
          overall += batch.length
          setProgress({ done: overall, total })
        }
      }

      pushLog(`${d.name}: moved ${moved}/${d.questions.length}${failed ? ' — ' + failed : ''}`)
      rows.push({
        name: d.name, qb_id: d.qb_id, moved, total: d.questions.length,
        numbers: d.questions.map(q => q._qNum), ids: d.questions.map(q => q.q_id), error: failed
      })
    }

    const stopped = cancelRef.current
    cancelRef.current = false
    setRunning(false)
    setLastRun({ when: new Date().toLocaleString(), source, rows })
    pushLog(''); pushLog(stopped ? 'Stopped.' : 'Done.')
    toast(stopped ? 'Stopped.' : 'Move complete.', stopped ? 'info' : 'success')
  }

  function downloadReport() {
    if (!lastRun) return
    const lines = ['QB Move Report',
      `Source: ${lastRun.source.qb_name} (${lastRun.source.qb_id})`,
      `Run: ${lastRun.when}`, '']
    lastRun.rows.forEach(r => lines.push(r.name,
      `  destination qb_id : ${r.qb_id}`,
      `  moved             : ${r.moved}/${r.total}${r.error ? ' — ' + r.error : ''}`,
      `  question numbers  : ${r.numbers.join(', ')}`,
      `  question ids      : ${r.ids.join(', ')}`, ''))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }))
    a.download = `qb_move_${String(lastRun.source.qb_name).replace(/[^\w-]+/g, '_')}.txt`
    a.click(); URL.revokeObjectURL(a.href)
  }

  const guessed = useMemo(() => {
    const t = new Set()
    dests.forEach(d => (d.questions || []).forEach(q => {
      const m = moveTypeFor(q.question_type)
      if (MOVE_TYPE_GUESSED[m]) t.add(m)
    }))
    return [...t]
  }, [dests])

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold mb-0.5 flex items-center gap-2">
            <FolderTree size={22} className="text-accent-pill" />
            {source ? source.qb_name : 'QB Organiser'}
          </h1>
          <p className="text-sm text-muted">
            {source
              ? `${questions.length} question(s), numbered Q1–Q${questions.length}`
              : 'Move questions out of one bank into banks you have already created.'}
          </p>
        </div>
        {source && (
          <button
            onClick={() => { setSource(null); setQuestions([]); setDests([]); goTo(0) }}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg bg-panel bg-panel-hover text-muted"
          >
            <ArrowLeftCircle size={16} /> Different bank
          </button>
        )}
      </div>

      <StepHeader steps={STEPS} current={step} furthest={furthest} onGo={goTo} />

      <AnimatePresence mode="wait">
        {/* ============ STEP 1 ============ */}
        {step === 0 && (
          <Pane key="source">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted2 pointer-events-none" />
                <input
                  value={term} onChange={e => setTerm(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && runSearch()}
                  placeholder="Search question banks…" className="input" style={{ paddingLeft: '2.25rem' }}
                />
              </div>
              <button onClick={runSearch} disabled={searching}
                className="px-4 py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-sm font-semibold disabled:opacity-50">
                {searching ? <Loader2 size={16} className="animate-spin" /> : 'Search'}
              </button>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}
            {searching && !hits.length && <SkeletonRows />}

            {hits.length > 0 && (
              <div className="rounded-xl border border-theme overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-panel text-muted text-left">
                    <tr><th className="px-4 py-2 font-medium">Question Bank</th>
                      <th className="px-4 py-2 font-medium" style={{ width: 90 }}>Questions</th>
                      <th className="px-4 py-2" style={{ width: 120 }}></th></tr>
                  </thead>
                  <tbody>
                    {hits.map(qb => {
                      const busy = loadingSrc.startsWith(qb.qb_id)
                      const prog = busy && loadingSrc.includes('|') ? loadingSrc.split('|')[1] : null
                      return (
                        <tr key={qb.qb_id} className="bg-panel-hover">
                          <td className="px-4 py-2.5">{qb.qb_name}</td>
                          <td className="px-4 py-2.5 text-muted2">{qb.questionCount ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right">
                            <button onClick={() => openSource(qb)} disabled={!!loadingSrc}
                              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent-pill text-accent-pill disabled:opacity-50">
                              {busy ? (prog ? `Loading ${prog}…` : 'Loading…') : 'Use this'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Pane>
        )}

        {/* ============ STEP 2 ============ */}
        {step === 1 && (
          <Pane key="plan">
            {/* --- the question map --- */}
            <div className="rounded-xl border border-theme bg-panel p-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                <h3 className="text-xs font-semibold uppercase text-muted">Questions in this bank</h3>
                <button
                  onClick={() => { copyRich('', questionListText); toast('Question list copied.', 'success') }}
                  className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-panel bg-panel-hover text-muted"
                >
                  <Copy size={12} /> Copy numbered list
                </button>
              </div>
              {source?.reported != null && source.reported !== questions.length && (
                <p className="text-xs text-amber-400 mb-2">
                  The bank reports {source.reported} questions but {questions.length} loaded — check before moving.
                </p>
              )}
              <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                {questions.map(q => (
                  <span key={q.q_id}
                    title={stripHtml(q.question_data || '').slice(0, 140)}
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      assignedNums.has(q._qNum) ? 'bg-accent-pill text-accent-pill' : 'bg-panel text-muted2'
                    }`}>
                    Q{q._qNum}
                  </span>
                ))}
              </div>
            </div>

            {/* --- prompt helper --- */}
            <div className="rounded-xl border border-theme bg-panel p-4">
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => setShowPrompt(v => !v)}
                  className="flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-lg bg-accent-pill text-accent-pill">
                  <Sparkles size={15} /> Prompt
                </button>
                <button
                  onClick={() => { copyRich('', SEGREGATION_PROMPT + '\n' + questionListText); toast('Prompt + questions copied.', 'success') }}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500">
                  <Copy size={12} /> Copy prompt + all questions
                </button>
                <span className="text-[11px] text-muted2">
                  Paste into any AI chat, then paste its answer into the box below.
                </span>
              </div>
              {showPrompt && (
                <div className="mt-3 flex flex-col gap-2">
                  <pre className="text-[11px] leading-relaxed bg-black/30 border border-theme rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap">{SEGREGATION_PROMPT}</pre>
                  <button onClick={() => { copyRich('', SEGREGATION_PROMPT); toast('Prompt copied.', 'success') }}
                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-panel bg-panel-hover text-muted self-start">
                    <Copy size={12} /> Copy prompt only
                  </button>
                </div>
              )}
            </div>

            {/* --- paste the answer back --- */}
            <div className="rounded-xl border border-theme bg-panel p-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted">Paste the answer — one line per bank: <span className="font-mono">ml_Regression - 1, 4, 9</span></span>
                <textarea
                  value={pasteText} onChange={e => setPasteText(e.target.value)} rows={4}
                  placeholder={'ml_Regression - 1, 4, 9\nml_Clustering - 2, 3, 7, 8'}
                  className="input font-mono" style={{ resize: 'vertical' }}
                />
              </label>
              <button onClick={applyPaste} disabled={!pasteText.trim()}
                className="mt-2 flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-40">
                <ClipboardPaste size={12} /> Read into destinations below
              </button>
            </div>

            {/* --- destination rows --- */}
            <div className="flex flex-col gap-2">
              {dests.map((d, i) => {
                const { nums, bad } = parseQuestionNumbers(d.numbersText)
                const outOfRange = nums.filter(n => n < 1 || n > questions.length)
                return (
                  <div key={i} className="rounded-xl border border-theme bg-panel p-3">
                    <div className="flex gap-2 flex-wrap items-end">
                      <label className="flex flex-col gap-1 text-sm" style={{ flex: 2, minWidth: 220 }}>
                        <span className="text-xs text-muted">Destination bank name</span>
                        <input value={d.name}
                          onChange={e => patchDest(i, { name: e.target.value, resolved: false, qb_id: null, error: null })}
                          placeholder="Exact name of a bank you created" className="input" />
                      </label>
                      <label className="flex flex-col gap-1 text-sm" style={{ flex: 2, minWidth: 200 }}>
                        <span className="text-xs text-muted">Question numbers</span>
                        <input value={d.numbersText}
                          onChange={e => patchDest(i, { numbersText: e.target.value })}
                          placeholder="e.g. 1, 4, 7-9" className="input font-mono" />
                      </label>
                      <button onClick={() => resolveDest(i)} disabled={resolvingIdx === i}
                        className="text-xs font-semibold px-3 py-2.5 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-40">
                        {resolvingIdx === i ? <Loader2 size={13} className="animate-spin" /> : 'Find bank'}
                      </button>
                      {dests.length > 1 && (
                        <button onClick={() => removeDest(i)} className="px-2.5 py-2.5 rounded-lg text-red-400 hover:bg-red-500/10">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    <div className="flex gap-1.5 flex-wrap mt-2">
                      {d.resolved && <Pill cls="bg-emerald-500/15 text-emerald-300">✔ found · {String(d.qb_id).slice(0, 8)}…</Pill>}
                      {d.error && <Pill cls="bg-red-500/15 text-red-300">{d.error}</Pill>}
                      {!d.resolved && !d.error && d.name && <Pill cls="bg-amber-500/15 text-amber-300">not checked yet</Pill>}
                      {nums.length > 0 && <Pill cls="bg-panel text-muted">{nums.length} question(s)</Pill>}
                      {bad.length > 0 && <Pill cls="bg-red-500/15 text-red-300">unreadable: {bad.join(', ')}</Pill>}
                      {outOfRange.length > 0 && <Pill cls="bg-red-500/15 text-red-300">no such question: {outOfRange.join(', ')}</Pill>}
                    </div>

                    {pickOptions[i]?.length > 0 && (
                      <div className="mt-2">
                        <p className="text-[11px] text-muted2 mb-1">Several matches — pick one:</p>
                        <div className="flex gap-1.5 flex-wrap">
                          {pickOptions[i].map(qb => (
                            <button key={qb.qb_id}
                              onClick={() => { patchDest(i, { qb_id: qb.qb_id, name: qb.qb_name, resolved: true, error: null }); setPickOptions(p => ({ ...p, [i]: null })) }}
                              className="text-[11px] px-2 py-1 rounded-lg bg-panel bg-panel-hover text-muted">
                              {qb.qb_name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex gap-2 flex-wrap">
              <button onClick={addDest} className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-panel bg-panel-hover border border-dashed border-theme">
                <Plus size={15} /> Add destination bank
              </button>
              <button onClick={resolveAll} className="text-sm font-semibold px-4 py-2.5 rounded-lg bg-panel bg-panel-hover text-muted">
                Find all banks
              </button>
            </div>

            <StepNav onBack={() => goTo(0)} backLabel="Back to bank"
              onNext={validateAll} nextLabel="Check assignments" nextDisabled={!dests.length} />
          </Pane>
        )}

        {/* ============ STEP 3 ============ */}
        {step === 2 && (
          <Pane key="review">
            {problems?.list.length > 0 ? (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-200">
                <b>{problems.list.length} thing(s) to fix before moving:</b>
                <ul className="mt-2 flex flex-col gap-1 text-xs">
                  {problems.list.map((p, i) => <li key={i}>• {p}</li>)}
                </ul>
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200/90 flex gap-2">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <div>
                    <b>{problems?.planned} question(s)</b> will move out of "{source?.qb_name}" into {dests.length} bank(s).
                    Moving is not a copy — the questions leave the source bank.
                    {problems?.untouched > 0 && <> {problems.untouched} question(s) are unassigned and stay put.</>}
                    {guessed.length > 0 && (
                      <div className="mt-1.5">
                        The move type for <b>{guessed.join(', ')}</b> is inferred rather than confirmed.
                        A failed batch is retried once with the raw question type.
                      </div>
                    )}
                  </div>
                </div>
                <div className="rounded-xl border border-theme overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-panel text-muted text-left">
                      <tr><th className="px-3 py-2 font-medium">Destination bank</th>
                        <th className="px-3 py-2 font-medium" style={{ width: 60 }}>Qs</th>
                        <th className="px-3 py-2 font-medium">Question numbers</th></tr>
                    </thead>
                    <tbody>
                      {dests.map((d, i) => (
                        <tr key={i} className="bg-panel-hover">
                          <td className="px-3 py-2">{d.name}</td>
                          <td className="px-3 py-2 text-muted2">{d.questions?.length || 0}</td>
                          <td className="px-3 py-2 text-muted2 font-mono text-[11px]">
                            {(d.questions || []).map(q => q._qNum).join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <StepNav onBack={() => goTo(1)} backLabel="Back to destinations"
              onNext={() => goTo(3)} nextLabel="Go to move"
              nextDisabled={!problems || problems.list.length > 0} />
          </Pane>
        )}

        {/* ============ STEP 4 ============ */}
        {step === 3 && (
          <Pane key="run">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={runMoves} disabled={running}
                className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 hover:opacity-90 disabled:opacity-40">
                {running ? <Loader2 size={15} className="animate-spin" /> : <PlayCircle size={15} />}
                Move {progress.total || dests.reduce((n, d) => n + (d.questions?.length || 0), 0)} question(s)
              </button>
              {running && (
                <button onClick={() => { cancelRef.current = true; toast('Stopping after the current batch…', 'info') }}
                  className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30">
                  <StopCircle size={15} /> Stop
                </button>
              )}
              {lastRun && (
                <button onClick={downloadReport}
                  className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-gradient-to-r from-emerald-600 to-green-600 hover:opacity-90">
                  <Download size={15} /> Download report
                </button>
              )}
            </div>

            {progress.total > 0 && (
              <div className="h-1.5 rounded-full bg-panel overflow-hidden">
                <motion.div className="h-full bg-gradient-to-r from-indigo-400 to-violet-400"
                  animate={{ width: `${(progress.done / progress.total) * 100}%` }} transition={{ duration: 0.25 }} />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              {dests.map((d, i) => {
                const row = lastRun?.rows.find(r => r.qb_id === d.qb_id)
                return (
                  <div key={i} className="flex items-center gap-3 rounded-xl border border-theme bg-panel px-3 py-2.5">
                    {row
                      ? (row.error ? <AlertTriangle size={16} className="text-amber-400 shrink-0" />
                        : <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />)
                      : <XCircle size={16} className="text-muted2 shrink-0 opacity-40" />}
                    <span className="flex-1 min-w-0 truncate text-sm">{d.name}</span>
                    <span className="text-xs text-muted2">{row?.moved ?? 0}/{d.questions?.length || 0}</span>
                  </div>
                )
              })}
            </div>

            {log.length > 0 && (
              <div className="rounded-xl border border-theme bg-black/30 p-3 max-h-64 overflow-auto">
                <pre className="text-[11px] leading-relaxed whitespace-pre-wrap text-muted">{log.join('\n')}</pre>
              </div>
            )}

            <StepNav onBack={() => goTo(2)} backLabel="Back to check" hideNext />
          </Pane>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Pane({ children }) {
  return (
    <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }}
      transition={{ duration: 0.18 }} className="flex flex-col gap-4">
      {children}
    </motion.div>
  )
}

function Pill({ cls, children }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cls}`}>{children}</span>
}
