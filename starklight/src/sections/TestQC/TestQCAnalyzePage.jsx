import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { SearchX, FolderOpen, Target, ShieldCheck, ArrowLeftCircle, Check } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { parseCsv, groupBySection } from '../../lib/helpers'
import QuestionPicker from '../../components/QuestionPicker'
import QuestionDetailModal from '../../components/QuestionDetailModal'
import { StepHeader, StepNav } from '../../components/Stepper'
import SectionSwitcherBar from '../../components/SectionSwitcherBar'
import QCResultsPanel from './QCResultsPanel'

const STEPS = [
  { id: 'scope', label: 'Topic Scope', icon: Target },
  { id: 'section', label: 'Choose Section', icon: FolderOpen },
  { id: 'run', label: 'Run QC', icon: ShieldCheck }
]

export default function TestQCAnalyzePage() {
  const { openTestQc, setOpenTestQc, qcResults } = useApp()
  const navigate = useNavigate()
  const [viewQ, setViewQ] = useState(null)
  const [step, setStep] = useState(0)
  const [furthest, setFurthest] = useState(0)

  // EVERY hook must run before the "no test open" early return below. When
  // openTestQc flips from null to a loaded test, a hook that sits after that
  // return would change the hook count between renders and React throws
  // ("Rendered more hooks than during the previous render"). So all the
  // derived state is computed unconditionally, with empty-safe fallbacks.
  const questions = openTestQc?.questions
  const { order, bySection } = useMemo(
    () => groupBySection(questions || []),
    [questions]
  )

  // Multiple sections can be worked on at once. Falls back to the first section
  // until a choice is made, so the list is never empty on arrival.
  const chosen = Array.isArray(openTestQc?.activeSections) ? openTestQc.activeSections : []
  const activeSections = chosen.filter(s => order.includes(s))
  const effectiveSections = activeSections.length ? activeSections : order.slice(0, 1)
  const sectionKey = effectiveSections.join('|')
  const sectionQuestions = useMemo(
    () => effectiveSections.flatMap(s => bySection[s] || []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bySection, sectionKey]
  )

  if (!openTestQc) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
        <SearchX size={40} className="text-muted2" />
        <p className="text-muted">No test is open yet.</p>
        <button
          onClick={() => navigate('/test-qc')}
          className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400"
        >
          Go search for one
        </button>
      </div>
    )
  }

  const { testLabel, selected, topicsIncluded, topicsExcluded } = openTestQc
  const sectionLabel = effectiveSections.length === 1
    ? effectiveSections[0]
    : `${effectiveSections.length} sections`

  function toggleSectionChoice(name) {
    update(prev => {
      const cur = Array.isArray(prev.activeSections) ? prev.activeSections : effectiveSections
      const next = cur.includes(name) ? cur.filter(s => s !== name) : [...cur, name]
      return { activeSections: next.length ? next : [name] } // never allow an empty selection
    })
  }

  function update(patch) {
    setOpenTestQc(prev => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))
  }

  function goTo(i) {
    setStep(i)
    setFurthest(f => Math.max(f, i))
  }

  function toggle(q) {
    update(prev => {
      const next = new Set(prev.selected)
      if (next.has(q.q_id)) next.delete(q.q_id); else next.add(q.q_id)
      return { selected: next }
    })
  }
  function toggleSection(_name, qs, checked) {
    update(prev => {
      const next = new Set(prev.selected)
      qs.forEach(q => { if (checked) next.add(q.q_id); else next.delete(q.q_id) })
      return { selected: next }
    })
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5">
      {/* ---- Header: which test, and a way back to search ---- */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold mb-0.5">{testLabel}</h1>
          <p className="text-sm text-muted">{questions.length} question(s) across {order.length} section(s)</p>
        </div>
        <button
          onClick={() => navigate('/test-qc')}
          className="flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg bg-panel bg-panel-hover text-muted"
        >
          <ArrowLeftCircle size={16} /> Different test
        </button>
      </div>

      <StepHeader steps={STEPS} current={step} furthest={furthest} onGo={goTo} />

      <AnimatePresence mode="wait">
        {/* ================= STEP 1 — topic scope ================= */}
        {step === 0 && (
          <motion.div
            key="scope"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-4"
          >
            <div className="rounded-xl border border-theme bg-panel p-5">
              <h2 className="font-semibold mb-1">Topic scope <span className="text-muted2 font-normal text-sm">(optional)</span></h2>
              <p className="text-sm text-muted mb-4">
                If you fill these in, QC also checks whether each question stays inside the syllabus. Leave both
                blank to skip that check entirely.
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted">✅ Topics that SHOULD be covered</span>
                  <input
                    value={topicsIncluded}
                    onChange={e => update({ topicsIncluded: e.target.value })}
                    placeholder="e.g. arrays, loops, if-else"
                    className="input"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted">⛔ Restricted / future topics</span>
                  <input
                    value={topicsExcluded}
                    onChange={e => update({ topicsExcluded: e.target.value })}
                    placeholder="e.g. recursion, OOP, generics"
                    className="input"
                  />
                </label>
              </div>
            </div>

            <StepNav hideBack onNext={() => goTo(1)} nextLabel="Choose section" />
          </motion.div>
        )}

        {/* ================= STEP 2 — pick a section ================= */}
        {step === 1 && (
          <motion.div
            key="section"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-4"
          >
            {/* Sections sit in a narrow right rail so the question list gets the full width
                on the left — the old stacked layout left a lot of dead space beside the
                dropdown. Order is reversed on mobile so the picker comes first. */}
            <div className="grid lg:grid-cols-[1fr_260px] gap-4 items-start">
              <div className="rounded-xl border border-theme bg-panel p-4 order-2 lg:order-1 min-w-0">
                <QuestionPicker
                  questions={sectionQuestions}
                  mode="select"
                  variant="detailed"
                  selectedIds={selected}
                  onToggle={toggle}
                  onToggleSection={toggleSection}
                  onView={setViewQ}
                  emptyLabel="Pick a section on the right to see its questions."
                />
              </div>

              <div className="rounded-xl border border-theme bg-panel p-4 order-1 lg:order-2 lg:sticky lg:top-20">
                <h3 className="text-xs font-semibold uppercase text-muted mb-2">📂 Sections</h3>
                <p className="text-[11px] text-muted2 mb-3">
                  Tick one or more — questions from every ticked section are analysed together.
                </p>
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

            <StepNav onBack={() => goTo(0)} backLabel="Back to topics" onNext={() => goTo(2)} nextLabel="Go to QC" nextDisabled={!sectionQuestions.length} />
          </motion.div>
        )}

        {/* ================= STEP 3 — run QC ================= */}
        {step === 2 && (
          <motion.div
            key="run"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-4"
          >
            <SectionSwitcherBar
              order={order}
              bySection={bySection}
              active={effectiveSections}
              results={qcResults}
              onToggle={toggleSectionChoice}
              onSetOnly={name => update({ activeSections: [name] })}
            />

            <QCResultsPanel
              questions={sectionQuestions}
              selected={selected}
              testLabel={`${testLabel} — ${sectionLabel}`}
              topicsIncluded={parseCsv(topicsIncluded)}
              topicsExcluded={parseCsv(topicsExcluded)}
            />

            <StepNav
              onBack={() => goTo(1)}
              backLabel="Back to section"
              hideNext
            >
              <button
                onClick={() => goTo(1)}
                className="text-sm font-medium px-4 py-2.5 rounded-lg bg-panel bg-panel-hover text-muted"
              >
                Switch section
              </button>
            </StepNav>
          </motion.div>
        )}
      </AnimatePresence>

      <QuestionDetailModal question={viewQ} onClose={() => setViewQ(null)} />
    </motion.div>
  )
}
