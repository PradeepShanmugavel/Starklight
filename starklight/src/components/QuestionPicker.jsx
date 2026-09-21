import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Eye, Trash2, CheckSquare, Square, FolderOpen, Filter, Copy, X } from 'lucide-react'
import { stripHtml, extractImageUrls, groupBySection, getMatchedExcludedTests, getUniqueTags, findDuplicateQuestionIds, sortByPriority } from '../lib/helpers'
import { PriorityBadge } from './Badges'
import { ImageThumbs } from './RichHtml'
import QuestionDetailCard from './QuestionDetailCard'

/**
 * mode="select"  — checkbox per question, used for picking questions to add somewhere.
 *                  Already-used (excludedTestNames) and already-in-this-test
 *                  (alreadyIncludedIds) questions are BLOCKED, not just grayed out.
 * mode="manage"  — no checkbox; a trash-can button per question, used when editing an
 *                  existing test's contents (remove-only).
 * variant="compact"  — one line per question (default; best for Test QC's long lists).
 * variant="detailed" — full rich card (statement, options, best-solution/stub code,
 *                       metadata, stats) — matches the portal's own "Add Questions" screen.
 */
export default function QuestionPicker({
  questions,
  mode = 'select',
  variant = 'compact',
  selectedIds,
  onToggle,
  onToggleSection,
  onPick, // used with mode="pick" — a single click immediately moves the question elsewhere
  topicCheckTargets, // Set of q_ids ticked for the opt-in topic-alignment check (independent of onPick)
  onToggleTopicCheckMark,
  onRemove,
  onView,
  excludedTestNames = [],
  alreadyIncludedIds, // Set of q_ids already assigned to some section of the test being built
  dupMapOverride, // optional Map<q_id, dupOfId> computed against a WIDER set than `questions`
                   // (e.g. the whole test, not just the currently loaded pool) — see ManualPackingWizard
  topicChecks, // optional Map/object of q_id -> { verdict, note } from the opt-in topic-alignment check
  emptyLabel = 'No questions loaded yet.'
}) {
  const [query, setQuery] = useState('')
  const [activeTags, setActiveTags] = useState(new Set())
  const [tagMode, setTagMode] = useState('OR') // 'OR' (any selected tag) | 'AND' (all selected tags)
  const [filterOpen, setFilterOpen] = useState(false)

  const allTags = useMemo(() => getUniqueTags(questions), [questions])
  const dupMap = useMemo(() => dupMapOverride || findDuplicateQuestionIds(questions), [questions, dupMapOverride])

  const filtered = useMemo(() => {
    let list = questions
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(item => {
        const text = stripHtml(item.question_data || '').toLowerCase()
        const type = (item.question_type || '').toLowerCase()
        const topic = (item.topic?.name || '').toLowerCase()
        const tags = Array.isArray(item.tags) ? item.tags.map(t => (t.name || '').toLowerCase()).join(' ') : ''
        return text.includes(q) || type.includes(q) || topic.includes(q) || tags.includes(q)
      })
    }
    if (activeTags.size) {
      list = list.filter(item => {
        const itemTags = new Set(Array.isArray(item.tags) ? item.tags.map(t => t.name) : [])
        return tagMode === 'AND'
          ? [...activeTags].every(t => itemTags.has(t))
          : [...activeTags].some(t => itemTags.has(t))
      })
    }
    return list
  }, [questions, query, activeTags, tagMode])

  const { order, bySection } = useMemo(() => {
    const grouped = groupBySection(filtered)
    const sorted = {}
    grouped.order.forEach(sec => { sorted[sec] = sortByPriority(grouped.bySection[sec]) })
    return { order: grouped.order, bySection: sorted }
  }, [filtered])
  const excludedLower = useMemo(() => excludedTestNames.map(t => t.trim().toLowerCase()), [excludedTestNames])

  function toggleTag(tag) {
    setActiveTags(prev => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag); else next.add(tag)
      return next
    })
  }

  if (!questions.length) {
    return <div className="text-sm text-muted py-6 text-center">{emptyLabel}</div>
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted2 pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by text, type, topic, or tag..."
            className="w-full bg-black/30 border border-theme rounded-lg py-2 text-sm outline-none focus:border-indigo-400/60"
            style={{ paddingLeft: '2.25rem', paddingRight: '0.75rem' }}
          />
        </div>

        {allTags.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setFilterOpen(v => !v)}
              className={`relative flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm shrink-0 ${
                activeTags.size ? 'bg-indigo-500/20 border-indigo-400/40 text-indigo-200' : 'bg-black/30 border-theme text-muted hover:bg-white/5'
              }`}
              title="Filter by tags"
            >
              <Filter size={15} />
              {activeTags.size > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-indigo-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {activeTags.size}
                </span>
              )}
            </button>

            <AnimatePresence>
              {filterOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 mt-2 w-72 bg-surface border border-theme rounded-xl shadow-2xl z-30 p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-body-app">🏷️ Filter by tags</span>
                    <button onClick={() => setFilterOpen(false)} className="text-muted2 hover-strong"><X size={14} /></button>
                  </div>

                  <div className="flex gap-1 mb-3 bg-black/30 rounded-lg p-1">
                    <button
                      onClick={() => setTagMode('OR')}
                      className={`flex-1 text-xs font-semibold py-1.5 rounded-md ${tagMode === 'OR' ? 'bg-indigo-500/30 text-indigo-200' : 'text-muted2 hover-strong'}`}
                    >
                      Match ANY (|)
                    </button>
                    <button
                      onClick={() => setTagMode('AND')}
                      className={`flex-1 text-xs font-semibold py-1.5 rounded-md ${tagMode === 'AND' ? 'bg-indigo-500/30 text-indigo-200' : 'text-muted2 hover-strong'}`}
                    >
                      Match ALL (&)
                    </button>
                  </div>

                  <div className="max-h-52 overflow-y-auto flex flex-col gap-1">
                    {allTags.map(tag => (
                      <label key={tag} className="flex items-center gap-2 text-sm px-2 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer">
                        <input type="checkbox" checked={activeTags.has(tag)} onChange={() => toggleTag(tag)} />
                        {tag}
                      </label>
                    ))}
                  </div>

                  {activeTags.size > 0 && (
                    <button onClick={() => setActiveTags(new Set())} className="mt-2 text-xs text-muted2 hover:text-red-300 underline">
                      Clear all ({activeTags.size})
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {activeTags.size > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-2">
          <span className="text-xs text-muted2">Filtering ({tagMode === 'AND' ? 'all of' : 'any of'}):</span>
          {[...activeTags].map(tag => (
            <span key={tag} className="flex items-center gap-1 text-xs bg-indigo-500/15 text-indigo-200 px-2 py-0.5 rounded-full">
              {tag} <button onClick={() => toggleTag(tag)}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}

      {order.map(sectionName => {
        const sectionQs = bySection[sectionName]
        const selectableQs = sectionQs.filter(q =>
          getMatchedExcludedTests(q, excludedLower).length === 0 && !alreadyIncludedIds?.has(q.q_id)
        )
        const allSelected = mode === 'select' && selectableQs.length > 0 && selectableQs.every(q => selectedIds?.has(q.q_id))
        return (
          <div key={sectionName} className="rounded-xl border border-theme bg-panel overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-white/5 border-b border-theme">
              <FolderOpen size={15} className="text-indigo-300" />
              <span className="font-semibold text-sm">{sectionName}</span>
              <span className="text-xs text-muted">({sectionQs.length})</span>
              {mode === 'select' && onToggleSection && selectableQs.length > 0 && (
                <button
                  onClick={() => onToggleSection(sectionName, selectableQs, !allSelected)}
                  className="ml-auto flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                >
                  {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>

            <div className={variant === 'detailed' ? 'flex flex-col gap-2 p-2' : ''}>
              <AnimatePresence initial={false}>
                {sectionQs.map((q, i) => {
                  const usedIn = getMatchedExcludedTests(q, excludedLower)
                  const alreadyInTest = alreadyIncludedIds?.has(q.q_id)
                  const blocked = usedIn.length > 0 || alreadyInTest
                  return (
                    <motion.div
                      key={q.q_id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -12, height: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i, 8) * 0.02 }}
                    >
                      {variant === 'detailed' ? (
                        <QuestionDetailCard
                          q={q}
                          mode={mode}
                          selected={selectedIds?.has(q.q_id)}
                          onToggle={onToggle}
                          onRemove={onRemove}
                          onPick={onPick}
                          topicCheckMarked={topicCheckTargets?.has(q.q_id)}
                          onToggleTopicCheckMark={onToggleTopicCheckMark}
                          blocked={blocked}
                          usedIn={usedIn}
                          alreadyInTest={alreadyInTest}
                          dupOfId={dupMap.get(q.q_id)}
                          topicCheck={topicChecks?.[q.q_id]}
                        />
                      ) : (
                        <QuestionRow
                          q={q}
                          mode={mode}
                          selected={selectedIds?.has(q.q_id)}
                          onToggle={onToggle}
                          onRemove={onRemove}
                          onView={onView}
                          blocked={blocked}
                          usedIn={usedIn}
                          alreadyInTest={alreadyInTest}
                          dupOfId={dupMap.get(q.q_id)}
                        />
                      )}
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function QuestionRow({ q, mode, selected, onToggle, onRemove, onView, blocked, usedIn, alreadyInTest, dupOfId }) {
  const text = stripHtml(q.question_data || '')
  const short = text.length > 200 ? text.slice(0, 200) + '…' : text
  const images = extractImageUrls(q)
  const difficulty = q.manual_difficulty || q.automatic_difficulty || '—'
  const canToggle = mode === 'select' && !blocked

  return (
    <div
      onClick={() => canToggle && onToggle?.(q)}
      className={`flex items-start gap-3 px-4 py-3 bg-panel-hover transition-colors ${blocked ? 'opacity-50' : ''} ${canToggle ? 'cursor-pointer' : ''}`}
    >
      {mode === 'select' && (
        <span className="mt-0.5 shrink-0" title={blocked ? 'Blocked — already used or already in this test' : 'Click anywhere on this row to select'}>
          {selected ? <CheckSquare size={18} className="text-indigo-400" /> : <Square size={18} className={blocked ? 'text-muted2' : 'text-muted2'} />}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-xs font-mono text-muted2">Q{q._qNum ?? '?'}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-body-app">{q.question_type || '—'}</span>
          <PriorityBadge q={q} />
          <span className="text-xs text-muted">{difficulty}</span>
          {alreadyInTest && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300">🔒 already in this test</span>
          )}
          {usedIn.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300">🚫 used in: {usedIn.join(', ')}</span>
          )}
          {dupOfId && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 flex items-center gap-1">
              <Copy size={10} /> possible duplicate
            </span>
          )}
        </div>
        <p className="text-sm text-body-app leading-snug break-words">{short}</p>
        <ImageThumbs urls={images} size={56} />
      </div>

      <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
        <button onClick={() => onView?.(q)} title="View full question" className="p-1.5 rounded-lg hover:bg-white/10 text-body-app">
          <Eye size={16} />
        </button>
        {mode === 'manage' && (
          <button onClick={() => onRemove?.(q)} title="Remove from test" className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-400">
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
