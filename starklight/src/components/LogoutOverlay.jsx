import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { LogOut } from 'lucide-react'

// Sign-out confirmation.
//
// This used to be styled as a game-over screen — "GG WP", "VICTORY ROYALE",
// a ROOKIE-to-LEGENDARY rank ladder, a pulsing 🎮 and two confetti cannons.
// Wrong register for a tool people use at work, so it's now a plain, quiet
// confirmation. The animation stays: fade in, lift, and a progress bar that
// tracks the actual delay before the redirect.
export default function LogoutOverlay({ open, stats, onDone }) {
  useEffect(() => {
    if (!open) return
    const t = setTimeout(onDone, 1600)
    return () => clearTimeout(t)
  }, [open, onDone])

  if (!open) return null

  const analyzed = stats?.analyzed ?? 0

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-md"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="text-center px-8"
      >
        <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-5 text-indigo-300">
          <LogOut size={24} strokeWidth={2} />
        </div>

        <h1 className="text-2xl font-semibold text-slate-100 tracking-tight">Signing out</h1>
        <p className="text-sm text-slate-400 mt-1.5 mb-6">
          Your access token has been cleared from this tab.
        </p>

        {analyzed > 0 && (
          <p className="text-xs text-slate-500 mb-6">
            {analyzed} question{analyzed === 1 ? '' : 's'} reviewed this session
          </p>
        )}

        <motion.div
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 1.5, ease: 'linear' }}
          className="h-0.5 w-48 mx-auto bg-indigo-400/70 rounded-full origin-left"
        />
        <p className="text-[11px] text-slate-500 mt-3">Returning to sign-in…</p>
      </motion.div>
    </motion.div>
  )
}
