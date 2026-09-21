import { useState } from 'react'
import { motion } from 'framer-motion'
import { KeyRound, ArrowRight, ShieldCheck, Sun, Moon, Telescope, Code2, Lock } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { useTheme } from '../context/ThemeContext'
import { decodeJwtPayload } from '../lib/api'
import LoginTransition from './LoginTransition'
import Logo from './Logo'

// Kept in step with the three sections in App.jsx — this is the first thing
// anyone sees, so it must not advertise features that no longer exist.
const FEATURES = [
  { icon: ShieldCheck, label: 'Quality check', tint: 'text-indigo-300' },
  { icon: Telescope, label: 'Topic alignment', tint: 'text-violet-300' },
  { icon: Code2, label: 'Solution manager', tint: 'text-emerald-300' }
]

export default function LoginPage() {
  const { setToken } = useApp()
  const toast = useToast()
  const { theme, toggleTheme } = useTheme()
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  // Hold the token aside and play the warp-in first; it's committed when the animation ends.
  const [entering, setEntering] = useState(null) // { token, name } | null

  const payload = value.trim() ? decodeJwtPayload(value.trim()) : null

  function handleEnter() {
    const trimmed = value.trim()
    if (!trimmed) { setError('Paste your access token to continue.'); return }
    const decoded = decodeJwtPayload(trimmed)
    setEntering({ token: trimmed, name: decoded?.name ? decoded.name.split(/[\s$]/)[0] : '' })
  }

  function finishEntering() {
    if (!entering) return
    toast(entering.name ? `Welcome back, ${entering.name}!` : 'Welcome to Starklight!', 'success')
    setToken(entering.token)
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      <LoginTransition open={!!entering} name={entering?.name} onDone={finishEntering} />

      {/* Bright, slow-drifting aurora — the login screen is otherwise a lot of empty space,
          so this carries most of the visual interest. Sits behind everything, non-interactive. */}
      <motion.div
        aria-hidden
        animate={{ x: [0, 40, -15, 0], y: [0, -28, 14, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -top-40 -left-32 w-[30rem] h-[30rem] rounded-full bg-indigo-500/10 blur-[130px] pointer-events-none"
      />
      <motion.div
        aria-hidden
        animate={{ x: [0, -40, 20, 0], y: [0, 34, -14, 0] }}
        transition={{ duration: 30, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -bottom-48 -right-32 w-[32rem] h-[32rem] rounded-full bg-sky-500/[0.07] blur-[140px] pointer-events-none"
      />

      <motion.button
        whileHover={{ scale: 1.1, rotate: 15 }}
        whileTap={{ scale: 0.9 }}
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="absolute top-5 right-5 flex items-center justify-center w-11 h-11 rounded-xl bg-surface-glass border border-theme backdrop-blur-xl shadow-lg z-10"
      >
        {theme === 'dark' ? <Moon size={18} className="text-accent-pill" /> : <Sun size={18} className="text-amber-500" />}
      </motion.button>

      <motion.div
        initial={{ opacity: 0, y: 28, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 22 }}
        className="w-full max-w-md relative z-10"
      >
        {/* Gradient ring wrapper — gives the card a bright edge without washing out its inside */}
        <div className="rounded-[1.75rem] p-px bg-gradient-to-b from-white/15 to-white/5 shadow-2xl shadow-black/40">
          <div className="rounded-[1.65rem] bg-surface-glass backdrop-blur-2xl px-9 py-10">
            <div className="flex flex-col items-center mb-7">
              {/* The mark carries its own tile (same artwork as the
                  favicon), so no extra gradient square around it. A slow
                  float plus the halo below, instead of the old
                  wobble-and-pulse. */}
              <motion.div
                animate={{ y: [0, -3, 0] }}
                transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
                className="relative mb-4"
              >
                {/* Soft halo, breathing slightly out of phase with the float
                    so the two don't look like one motion. Behind the mark
                    and non-interactive. */}
                <motion.span
                  aria-hidden
                  animate={{ opacity: [0.35, 0.6, 0.35], scale: [0.95, 1.12, 0.95] }}
                  transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute inset-0 -z-10 rounded-[1.4rem] bg-indigo-500/50 blur-2xl pointer-events-none"
                />
                <Logo size={72} className="shadow-xl shadow-indigo-500/30" />
              </motion.div>
              <h1 className="text-[1.7rem] font-extrabold tracking-tight text-body-app">
                Stark<span className="text-indigo-400">light</span>
              </h1>
              <p className="text-sm text-muted mt-1.5">Quality check, topic alignment and solutions for the Examly portal.</p>
            </div>

            <div className="relative mb-2">
              <KeyRound size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted2 pointer-events-none" />
              <input
                type="password"
                value={value}
                onChange={e => { setValue(e.target.value); setError('') }}
                onKeyDown={e => e.key === 'Enter' && handleEnter()}
                placeholder="Paste your access token"
                className="input"
                style={{ paddingLeft: '2.5rem', paddingTop: '0.7rem', paddingBottom: '0.7rem' }}
                autoFocus
              />
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: [0, -5, 5, -3, 0] }}
                transition={{ duration: 0.4 }}
                className="text-xs text-red-400 mb-2"
              >
                {error}
              </motion.p>
            )}

            {payload?.name && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-3 py-2.5 mb-4"
              >
                <ShieldCheck size={15} /> Recognized as <b className="font-semibold">{payload.name}</b>
              </motion.div>
            )}

            <motion.button
              whileHover={{ scale: 1.02, boxShadow: '0 10px 30px -10px rgba(99,102,241,0.55)' }}
              whileTap={{ scale: 0.97 }}
              onClick={handleEnter}
              className="w-full mt-3 flex items-center gap-2 justify-center rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3.5 font-semibold text-white transition shadow-lg shadow-indigo-500/25"
            >
              Enter Starklight <ArrowRight size={17} />
            </motion.button>

            <div className="grid grid-cols-3 gap-2 mt-8 pt-6 border-t border-theme">
              {FEATURES.map((f, i) => (
                <motion.div
                  key={f.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 + i * 0.1 }}
                  whileHover={{ y: -3 }}
                  className="flex flex-col items-center gap-2 text-center"
                >
                  <div className="w-9 h-9 rounded-xl bg-panel border border-theme flex items-center justify-center">
                    <f.icon size={16} className={f.tint} />
                  </div>
                  <span className="text-[10px] text-muted2 leading-tight">{f.label}</span>
                </motion.div>
              ))}
            </div>
          </div>
        </div>

        <p className="text-[11px] text-muted2 text-center mt-5 flex items-center justify-center gap-1.5 px-6">
          <Lock size={11} className="shrink-0" />
          Your token stays in this tab — it is only ever sent to your own local server.
        </p>
      </motion.div>
    </div>
  )
}
