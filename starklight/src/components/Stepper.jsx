import { motion } from 'framer-motion'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * steps: [{ id, label, icon }]
 * current: index of the active step
 * furthest: highest index reached so far — steps up to here are clickable, ones beyond
 *           are locked, so you can't skip ahead past something that isn't filled in yet.
 */
export function StepHeader({ steps, current, furthest, onGo }) {
  return (
    <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto pb-1">
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        const reachable = i <= furthest
        return (
          <div key={s.id} className="flex items-center gap-1 sm:gap-2 shrink-0">
            <button
              onClick={() => reachable && onGo(i)}
              disabled={!reachable}
              className={`relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition ${
                active
                  ? 'bg-accent-pill text-accent-pill'
                  : reachable
                    ? 'text-muted bg-panel-hover cursor-pointer'
                    : 'text-muted2 opacity-50 cursor-not-allowed'
              }`}
            >
              <span
                className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 ${
                  done ? 'bg-emerald-500/25 text-emerald-300' : active ? 'bg-indigo-500 text-white' : 'bg-panel text-muted2'
                }`}
              >
                {done ? <Check size={11} /> : i + 1}
              </span>
              <span className="hidden sm:inline whitespace-nowrap">{s.label}</span>
              {active && (
                <motion.span
                  layoutId="step-underline"
                  className="absolute left-3 right-3 -bottom-0.5 h-0.5 rounded-full bg-indigo-400"
                />
              )}
            </button>
            {i < steps.length - 1 && (
              <span className={`h-px w-4 sm:w-8 shrink-0 ${i < current ? 'bg-emerald-500/40' : 'bg-white/10'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export function StepNav({ onBack, onNext, backLabel = 'Back', nextLabel = 'Next', nextDisabled, hideBack, hideNext, children }) {
  return (
    <div className="flex items-center gap-3 flex-wrap pt-2">
      {!hideBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium px-4 py-2.5 rounded-lg bg-panel bg-panel-hover text-muted"
        >
          <ChevronLeft size={16} /> {backLabel}
        </button>
      )}
      {children}
      {!hideNext && (
        <button
          onClick={onNext}
          disabled={nextDisabled}
          className="ml-auto flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 hover:opacity-90 disabled:opacity-40"
        >
          {nextLabel} <ChevronRight size={16} />
        </button>
      )}
    </div>
  )
}
