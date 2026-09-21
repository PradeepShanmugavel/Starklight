import { useState } from 'react'
import { motion } from 'framer-motion'
import { CheckSquare, Square, Trash2, Landmark, GraduationCap, Target, Compass, Sparkles, Code2, FileCode2, Bug, PlusCircle, Tag, ClipboardList } from 'lucide-react'
import { extractImageUrls, getSolutionsWithBest, getStubCodeBestEffort, getMcqOptionsBestEffort, getCodeConstraints, getSampleCases, getHiddenTestCases, formatCases, findRepeatedTestCases, isDebugQuestion } from '../lib/helpers'
import { PriorityBadge } from './Badges'
import { ImageThumbs } from './RichHtml'
import RichHtml from './RichHtml'

const TYPE_LABELS = {
  mcq_single_correct: 'MCQ - Single Correct',
  mcq_multi_correct: 'MCQ - Multiple Correct',
  programming: 'Programming'
}

const TOPIC_VERDICT_STYLE = {
  pass: 'bg-emerald-500/15 text-emerald-300',
  fail: 'bg-red-500/15 text-red-300',
  warn: 'bg-amber-500/15 text-amber-300'
}
const TOPIC_VERDICT_ICON = { pass: '✅', fail: '❌', warn: '⚠️' }

/**
 * mode="select" — whole card is clickable to toggle selection (not just a tiny checkbox).
 * mode="manage" — whole card is clickable to REMOVE it from the section (not just a trash icon).
 * mode="view"   — read-only (Preview Test) — auto-shows format/constraints/best-solution/stub
 *                 /header/footer; only the OTHER (non-best) language solutions stay collapsed.
 * Any interactive sub-element (expand toggle, image zoom) stops propagation so it never
 * accidentally triggers the whole-card action.
 */
export default function QuestionDetailCard({ q, mode = 'select', selected, onToggle, onRemove, onPick, blocked, usedIn = [], alreadyInTest, dupOfId, topicCheck, topicCheckMarked, onToggleTopicCheckMark }) {
  const isPreview = mode === 'view'
  const [expanded, setExpanded] = useState(isPreview) // preview: core code content auto-shown
  const [otherSolutionsExpanded, setOtherSolutionsExpanded] = useState(false)

  const qText = q.question_data || ''
  const images = extractImageUrls(q)
  const breadcrumb = [q.subject?.name, q.topic?.name, q.sub_topic?.name].filter(Boolean).join(' / ')
  const typeLabel = TYPE_LABELS[q.question_type] || q.question_type || '—'
  const isMcq = (q.question_type || '').includes('mcq')
  const isCoding = q.question_type === 'programming'
  const isDebugQb = isDebugQuestion(q)

  const pq = q.programming_question || {}
  const options = isMcq ? getMcqOptionsBestEffort(q) : null
  const solutions = isCoding ? getSolutionsWithBest(q) : []
  const bestSolution = solutions.find(s => s.isBest) || solutions[0]
  const otherSolutions = solutions.filter(s => s !== bestSolution)
  const stub = isCoding ? getStubCodeBestEffort(q) : ''
  const constraints = isCoding ? getCodeConstraints(q) : ''
  const sampleCases = isCoding ? getSampleCases(q) : []
  const hiddenCases = isCoding ? getHiddenTestCases(q) : []
  const repeats = isCoding ? findRepeatedTestCases(q) : { hasAny: false }
  const testsAdded = Array.isArray(q.question_testName) ? q.question_testName : []

  function handleCardClick() {
    if (blocked) return
    if (mode === 'select') onToggle?.(q)
    else if (mode === 'manage') onRemove?.(q)
    else if (mode === 'pick') onPick?.(q)
  }
  const clickable = mode === 'select' || mode === 'manage' || mode === 'pick'
  const accentBorder = isDebugQb ? 'border-l-fuchsia-500' : isMcq ? 'border-l-sky-500' : 'border-l-amber-500'

  return (
    <motion.div
      onClick={clickable ? handleCardClick : undefined}
      whileHover={clickable && !blocked ? { x: 3 } : undefined}
      whileTap={clickable && !blocked ? { scale: 0.985 } : undefined}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      className={`relative rounded-lg border border-theme bg-surface-2 border-l-4 transition ${isPreview ? 'px-3 py-2' : 'px-3 py-2.5'} ${
        blocked ? 'border-l-slate-700 opacity-50' : accentBorder
      } ${clickable && !blocked ? 'cursor-pointer bg-panel-hover' : ''}`}
    >
      <div className="flex items-start gap-3">
        {mode === 'select' && (
          <span className="mt-0.5 shrink-0">
            {selected ? <CheckSquare size={18} className="text-indigo-400" /> : <Square size={18} className={blocked ? 'text-muted2' : 'text-muted2'} />}
          </span>
        )}
        {mode === 'pick' && (
          <span className="mt-0.5 shrink-0" title={blocked ? '' : 'Click anywhere to move into the target section'}>
            <PlusCircle size={18} className={blocked ? 'text-muted2' : 'text-emerald-400'} />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap text-xs text-muted mb-0.5">
            <Landmark size={12} /> Question Bank: <span className="text-body-app">{q._qb_name || '—'}</span>
            {isDebugQb && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-fuchsia-500/15 text-fuchsia-300 flex items-center gap-1">
                <Bug size={10} /> Debug Question
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <span className="text-xs font-semibold text-body-app">{typeLabel}</span>
            <PriorityBadge q={q} />
            {alreadyInTest && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300">🔒 already in this test</span>}
            {usedIn.length > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300">🚫 used in: {usedIn.join(', ')}</span>}
            {dupOfId && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300">⚠️ possible duplicate</span>}
            {topicCheck && topicCheck.verdict !== 'na' && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1 ${TOPIC_VERDICT_STYLE[topicCheck.verdict] || 'bg-white/10 text-body-app'}`} title={topicCheck.note}>
                {TOPIC_VERDICT_ICON[topicCheck.verdict] || ''} Topic: {topicCheck.verdict}
              </span>
            )}
            {onToggleTopicCheckMark && (
              <label
                className="flex items-center gap-1 text-[10px] text-violet-300 bg-violet-500/10 px-1.5 py-0.5 rounded-full cursor-pointer"
                onClick={e => e.stopPropagation()}
              >
                <input type="checkbox" checked={!!topicCheckMarked} onChange={() => onToggleTopicCheckMark(q)} className="w-3 h-3" />
                🎯 mark for check
              </label>
            )}
          </div>
          {breadcrumb && <div className="text-xs text-muted2 mb-2 italic">{breadcrumb}</div>}
          {Array.isArray(q.tags) && q.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mb-2">
              <Tag size={10} className="text-muted2" />
              {q.tags.map((t, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-panel border border-theme text-muted">
                  {t.name}
                </span>
              ))}
            </div>
          )}
          {topicCheck && topicCheck.verdict !== 'na' && topicCheck.verdict !== 'pass' && topicCheck.note && (
            <div className="text-xs text-amber-300/90 mb-2">🎯 {topicCheck.note}</div>
          )}

          <div className="flex gap-2">
            <span className="text-sm font-bold text-body-app shrink-0">Q{q._qNum ?? '?'}</span>
            <div className="text-xs text-body-app leading-relaxed min-w-0">
              <RichHtml html={qText} className="" />
              <ImageThumbs urls={images} size={64} />
            </div>
          </div>

          {isMcq && (
            <div className="mt-2 ml-6 space-y-1">
              {options ? options.map((o, i) => (
                <div key={i} className={`text-sm flex gap-2 ${o.isCorrect ? 'text-emerald-300 font-medium' : 'text-body-app'}`}>
                  <span>{i + 1}.</span> <span>{o.text}</span> {o.isCorrect && <span>✅</span>}
                </div>
              )) : (
                <div className="text-xs text-muted2 italic">
                  ⚠️ Option data isn't in a recognized shape yet — raw: <code className="text-[10px]">{JSON.stringify(q.mcq_questions)?.slice(0, 120)}</code>
                </div>
              )}
            </div>
          )}

          {isCoding && (pq.input_format || pq.output_format || constraints || sampleCases.length > 0 || hiddenCases.length > 0) && (
            <div className="mt-3 ml-6 space-y-2">
              {pq.input_format && (
                <div>
                  <div className="text-[11px] font-semibold text-muted mb-0.5">Input Format</div>
                  <RichHtml html={pq.input_format} className="text-xs" />
                </div>
              )}
              {pq.output_format && (
                <div>
                  <div className="text-[11px] font-semibold text-muted mb-0.5">Output Format</div>
                  <RichHtml html={pq.output_format} className="text-xs" />
                </div>
              )}
              {constraints && (
                <div>
                  <div className="text-[11px] font-semibold text-muted mb-0.5">Constraints</div>
                  <pre className={`bg-black/30 border border-theme rounded-lg p-2 text-[11px] overflow-x-auto text-muted whitespace-pre-wrap ${isPreview ? "max-h-20" : "max-h-28"}`}>{constraints}</pre>
                </div>
              )}
              {sampleCases.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-muted mb-0.5">Sample I/O ({sampleCases.length})</div>
                  <pre className={`bg-black/30 border border-theme rounded-lg p-2 text-[11px] overflow-x-auto text-muted whitespace-pre-wrap ${isPreview ? "max-h-24" : "max-h-32"}`}>{formatCases(sampleCases)}</pre>
                </div>
              )}
              {hiddenCases.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-muted mb-0.5 flex items-center gap-1.5">
                    Hidden Test Cases ({hiddenCases.length})
                    {repeats.hasAny && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300 font-normal">
                        ⚠️ {repeats.sampleReusedInHidden.length + repeats.duplicateHidden.length} repeated
                      </span>
                    )}
                  </div>
                  {repeats.hasAny && (
                    <div className="text-[10px] text-red-300 mb-1">
                      {repeats.sampleReusedInHidden.map(r => `hidden #${r.hiddenIndex} = sample #${r.sampleIndex}`)
                        .concat(repeats.duplicateHidden.map(r => `hidden #${r.hiddenIndex} = hidden #${r.firstIndex}`))
                        .join(' · ')}
                    </div>
                  )}
                  <pre className={`bg-black/30 border border-theme rounded-lg p-2 text-[11px] overflow-x-auto text-muted whitespace-pre-wrap ${isPreview ? "max-h-24" : "max-h-32"}`}>{formatCases(hiddenCases, { withScores: true })}</pre>
                </div>
              )}
            </div>
          )}

          {isCoding && (solutions.length > 0 || stub) && (
            <div className="mt-3 ml-6" onClick={e => e.stopPropagation()}>
              {!isPreview && (
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-indigo-300 hover:text-indigo-200"
                >
                  <Code2 size={13} /> {expanded ? 'Hide code' : `Show code (${solutions.length} solution${solutions.length !== 1 ? 's' : ''}${stub ? ' + stub' : ''})`}
                </button>
              )}
              {expanded && (
                <div className="mt-2 space-y-2">
                  {stub && (
                    <CodeBlock label="Stub / starter code" icon={<FileCode2 size={12} />} labelClass="text-amber-300" code={stub} />
                  )}
                  {bestSolution && (
                    <div>
                      <div className="text-[11px] font-semibold flex items-center gap-1 mb-1 text-emerald-300">⭐ Best solution · {bestSolution.language}</div>
                      {bestSolution.header && <LockedBlock label="Header (locked)" code={bestSolution.header} />}
                      <pre className={`bg-black/40 border border-theme rounded-lg p-2.5 text-xs overflow-x-auto ${isPreview ? "max-h-32" : "max-h-48"}`}>{bestSolution.code}</pre>
                      {bestSolution.footer && <LockedBlock label="Footer (locked)" code={bestSolution.footer} />}
                    </div>
                  )}
                  {otherSolutions.length > 0 && (
                    <div>
                      <button
                        onClick={() => setOtherSolutionsExpanded(v => !v)}
                        className="text-xs font-medium text-muted hover-strong"
                      >
                        {otherSolutionsExpanded ? '▾' : '▸'} {otherSolutionsExpanded ? 'Hide' : 'Show'} {otherSolutions.length} other solution{otherSolutions.length !== 1 ? 's' : ''}
                      </button>
                      {otherSolutionsExpanded && (
                        <div className="mt-2 space-y-2">
                          {otherSolutions.map((s, i) => (
                            <div key={i}>
                              <div className="text-[11px] font-semibold flex items-center gap-1 mb-1 text-muted">· {s.language}</div>
                              {s.header && <LockedBlock label="Header (locked)" code={s.header} />}
                              <pre className="bg-black/40 border border-theme rounded-lg p-2.5 text-xs overflow-x-auto max-h-48">{s.code}</pre>
                              {s.footer && <LockedBlock label="Footer (locked)" code={s.footer} />}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-4 flex-wrap mt-3 ml-6 text-[11px] text-muted2">
            <span className="flex items-center gap-1"><Target size={11} /> Difficulty: {q.automatic_difficulty ?? q.manual_difficulty ?? '—'}</span>
            <span className="flex items-center gap-1"><GraduationCap size={11} /> Bloom's: {q.blooms_taxonomy || '—'}</span>
            <span className="flex items-center gap-1"><Compass size={11} /> CO: {q.course_outcome || '—'}</span>
            <span className="flex items-center gap-1"><Sparkles size={11} /> PO: {q.program_outcome || '—'}</span>
          </div>

          {testsAdded.length > 0 && (
            <div
              className="mt-2 ml-6 text-[11px] text-muted2 flex items-center gap-1"
              title={testsAdded.join('\n')}
            >
              <ClipboardList size={11} /> Already in {testsAdded.length} test{testsAdded.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>

        {mode === 'manage' && (
          <Trash2 size={16} className="text-red-400 shrink-0 mt-0.5" />
        )}
      </div>
    </motion.div>
  )
}

function CodeBlock({ label, icon, labelClass, code }) {
  return (
    <div>
      <div className={`text-[11px] font-semibold flex items-center gap-1 mb-1 ${labelClass}`}>{icon} {label}</div>
      <pre className="bg-black/40 border border-theme rounded-lg p-2.5 text-xs overflow-x-auto max-h-48">{code}</pre>
    </div>
  )
}

function LockedBlock({ label, code }) {
  return (
    <div className="mb-1">
      <div className="text-[10px] text-muted2 mb-0.5">{label}</div>
      <pre className="bg-black/30 border border-theme rounded-lg p-2 text-[11px] overflow-x-auto max-h-24 text-muted">{code}</pre>
    </div>
  )
}
