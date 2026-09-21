import { Sparkles } from 'lucide-react'

/**
 * The Starklight mark: the sparkle on an indigo→violet tile — the "light" in
 * Starklight, and the original mark this app shipped with.
 *
 * It exists as one component so the header, the sign-in card, the transition
 * and the dashboard can never drift apart. Each of those used to draw its
 * own icon, which is how the sign-in screen ended up showing something
 * different from everywhere else.
 *
 * Kept visually in step with public/favicon.svg (the same sparkle on the
 * same gradient) — change both together, or the browser tab stops matching
 * the app.
 *
 * `tile={false}` gives the bare glyph in currentColor, for places already
 * sitting on a panel. It must be currentColor rather than white there, or
 * the mark would disappear in the light theme.
 */
export default function Logo({ size = 32, tile = true, className = '' }) {
  if (!tile) {
    return <Sparkles size={size} className={className} aria-label="Starklight" />
  }

  return (
    <div
      className={`rounded-[22%] bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="Starklight"
    >
      <Sparkles
        size={Math.round(size * 0.5)}
        strokeWidth={2}
        className="text-white drop-shadow"
      />
    </div>
  )
}
