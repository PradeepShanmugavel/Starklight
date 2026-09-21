import { Trophy, Star, CheckCircle2, XCircle, AlertTriangle, Minus } from 'lucide-react'
import { PRIORITY_LABELS, getPriorityRank } from '../lib/helpers'

const PRIORITY_COLORS = ['badge-yellow', 'badge-slate', 'badge-amber', 'badge-blue', 'badge-green']

export function PriorityBadge({ q }) {
  const rank = getPriorityRank(q)
  if (rank >= PRIORITY_LABELS.length) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-white/5 text-muted text-xs font-semibold px-2 py-0.5">— Unverified</span>
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full text-xs font-bold px-2 py-0.5 ${PRIORITY_COLORS[rank]}`}>
      <Trophy size={12} /> {PRIORITY_LABELS[rank]}
    </span>
  )
}

export function StarRating({ n }) {
  const rating = Math.max(1, Math.min(5, parseInt(n, 10) || 0))
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} size={14} className={i < rating ? 'fill-yellow-400 text-yellow-400' : 'text-muted2'} />
      ))}
    </span>
  )
}

export function VerdictBadge({ check }) {
  if (!check) return <Minus size={16} className="text-muted2" />
  const { verdict, note } = check
  const icon =
    verdict === 'pass' ? <CheckCircle2 size={16} className="text-green-400" /> :
    verdict === 'fail' ? <XCircle size={16} className="text-red-400" /> :
    verdict === 'warn' ? <AlertTriangle size={16} className="text-amber-400" /> :
    <Minus size={16} className="text-muted2" />
  return (
    <div className="flex flex-col items-start gap-0.5">
      {icon}
      {note ? <span className="text-[10px] text-muted max-w-[140px] leading-snug">{note}</span> : null}
    </div>
  )
}

// Debug questions get their syntax/logical error counts shown as explicit numbers, not buried
// inside a note string — these are confirmed separate numeric fields from the QC endpoint.
export function DebugAnalysisBadge({ check }) {
  if (!check || check.verdict === 'na') return <Minus size={16} className="text-muted2" />
  const { verdict, syntax_error_count, logical_error_count, note } = check
  const icon =
    verdict === 'pass' ? <CheckCircle2 size={16} className="text-green-400" /> :
    verdict === 'fail' ? <XCircle size={16} className="text-red-400" /> :
    verdict === 'warn' ? <AlertTriangle size={16} className="text-amber-400" /> :
    <Minus size={16} className="text-muted2" />
  return (
    <div className="flex flex-col items-start gap-0.5">
      <div className="flex items-center gap-1.5">{icon}</div>
      <div className="flex gap-1.5 text-[11px]">
        <span className="text-badge-fuchsia">🔤 Syntax: {syntax_error_count ?? '—'}</span>
        <span className="text-badge-cyan">🧠 Logical: {logical_error_count ?? '—'}</span>
      </div>
      {note ? <span className="text-[10px] text-muted max-w-[160px] leading-snug">{note}</span> : null}
    </div>
  )
}
