import { ChevronLeft, ChevronRight, Check } from 'lucide-react'

/**
 * Sticky strip that sits above the results so you can move between sections without
 * scrolling to the bottom of a long table. Shows every section as a chip (ticked ones are
 * the active selection) plus prev/next shortcuts that step through them one at a time.
 */
export default function SectionSwitcherBar({ order, bySection, active, onToggle, onSetOnly, results }) {
  if (!order.length) return null

  const firstActive = order.findIndex(s => active.includes(s))
  const lastActive = order.length - 1 - [...order].reverse().findIndex(s => active.includes(s))

  function step(dir) {
    // Single-section step: move the selection to the next/previous section in order.
    const base = dir < 0 ? firstActive : lastActive
    const target = order[Math.min(order.length - 1, Math.max(0, base + dir))]
    if (target) onSetOnly(target)
  }

  return (
    <div className="sticky top-16 z-30 -mx-1 px-1 py-2 bg-surface-translucent backdrop-blur-md rounded-xl border border-theme">
      <div className="flex items-center gap-2">
        <button
          onClick={() => step(-1)}
          disabled={firstActive <= 0}
          title="Previous section"
          className="shrink-0 p-1.5 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-30"
        >
          <ChevronLeft size={15} />
        </button>

        <div className="flex-1 flex items-center gap-1.5 overflow-x-auto">
          {order.map(name => {
            const on = active.includes(name)
            const qs = bySection[name] || []
            // How many of this section's questions already have a result — lets you see at a
            // glance which sections are still outstanding.
            const done = results ? qs.filter(q => results[q.q_id]).length : 0
            return (
              <button
                key={name}
                onClick={() => onToggle(name)}
                onDoubleClick={() => onSetOnly(name)}
                title={`${name} — ${done}/${qs.length} checked (double-click for this section only)`}
                className={`flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap ${
                  on ? 'bg-accent-pill text-accent-pill' : 'text-muted bg-panel-hover'
                }`}
              >
                {on && <Check size={11} />}
                {name}
                <span className="text-[10px] text-muted2">
                  {done}/{qs.length}
                </span>
              </button>
            )
          })}
        </div>

        <button
          onClick={() => step(1)}
          disabled={lastActive >= order.length - 1}
          title="Next section"
          className="shrink-0 p-1.5 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-30"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  )
}
