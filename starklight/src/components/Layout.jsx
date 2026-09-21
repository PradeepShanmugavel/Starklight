import { useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, ShieldCheck, LogOut, Sun, Moon, Telescope, Code2, FolderTree, Languages } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useTheme } from '../context/ThemeContext'
import LogoutOverlay from './LogoutOverlay'
import Logo from './Logo'


const TABS = [
  { to: '/test-qc', label: 'Test QC', full: 'Test Quality Check', icon: ShieldCheck },
  { to: '/topic-alignment', label: 'Topic Align', full: 'Topic Alignment', icon: Telescope },
  { to: '/solutions', label: 'Solutions', full: 'Solution Manager', icon: Code2 },
  { to: '/qb-organiser', label: 'Organise', full: 'QB Organiser', icon: FolderTree },
  { to: '/language-manager', label: 'Languages', full: 'Language Manager', icon: Languages }
]

// The header mark changes with the route — a small "where am I" cue that's quicker to read
// than the nav highlight. Longest paths first so /test-qc/analyze wins over /test-qc.
const PAGE_MARKS = [
  { match: '/test-qc/analyze', word: 'Analyzing', emoji: '🔬' },
  { match: '/test-qc', word: 'Test Quality Check', emoji: '🛡️' },
  { match: '/topic-alignment', word: 'Topic Alignment', emoji: '🔭' },
  { match: '/solutions', word: 'Solution Manager', emoji: '💻' },
  { match: '/qb-organiser', word: 'QB Organiser', emoji: '🗂️' },
  { match: '/language-manager', word: 'Language Manager', emoji: '🌐' }
]
function markFor(pathname) {
  // Emoji for the per-section marks — they were here from the start and are
  // the quickest "where am I" cue to read.
  //
  // The default is the exception: at home the header shows the brand mark
  // instead, so the sparkle stays the thing that identifies the product.
  return PAGE_MARKS.find(m => pathname.startsWith(m.match)) || { word: 'Starklight', brand: true }
}

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setToken, openTestQc, qcResults } = useApp()
  const { theme, toggleTheme } = useTheme()
  const atHome = location.pathname === '/'
  const mark = markFor(location.pathname)

  // If a test is already open on the analyze page, the Test QC tab returns you straight
  // there instead of dumping you back at the search screen.
  const tabTargets = {
    '/test-qc': openTestQc ? '/test-qc/analyze' : '/test-qc'
  }

  const [loggingOut, setLoggingOut] = useState(false)

  function logout() {
    setLoggingOut(true) // overlay calls back when its animation finishes
  }

  function finishLogout() {
    setLoggingOut(false)
    setToken('')
    navigate('/')
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-theme bg-surface-translucent backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          <AnimatePresence mode="wait">
            {!atHome && (
              <motion.button
                key="back"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                onClick={() => navigate(-1)}
                className="flex items-center gap-1.5 text-sm text-body-app hover-strong px-2 py-1.5 rounded-lg hover:bg-white/10"
              >
                <ArrowLeft size={16} />
              </motion.button>
            )}
          </AnimatePresence>

          <NavLink to="/" className="flex items-center gap-2 font-bold text-lg tracking-tight" title="Back to home">
            <AnimatePresence mode="wait">
              <motion.span
                key={mark.word}
                initial={{ opacity: 0, scale: 0.6, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.6, y: 4 }}
                transition={{ type: 'spring', stiffness: 380, damping: 20 }}
                className="text-indigo-400 leading-none flex items-center text-xl"
              >
                {mark.brand ? <Logo size={22} tile={false} /> : mark.emoji}
              </motion.span>
            </AnimatePresence>
            <span className="hidden sm:inline">
              Stark<span className="text-indigo-400">light</span>
            </span>
            <AnimatePresence mode="wait">
              {mark.word !== 'Starklight' && (
                <motion.span
                  key={mark.word}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 6 }}
                  className="hidden md:inline text-xs font-medium text-muted2 border-l border-theme pl-2 ml-1"
                >
                  {mark.word}
                </motion.span>
              )}
            </AnimatePresence>
          </NavLink>

          <nav className="relative flex items-center gap-0.5 ml-2 overflow-x-auto">
            {TABS.map(t => {
              const isActive = location.pathname.startsWith(t.to)
              return (
                <NavLink
                  key={t.to}
                  to={tabTargets[t.to] || t.to}
                  title={t.full}
                  className="relative flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg transition text-muted hover-strong whitespace-nowrap"
                >
                  {isActive && (
                    <motion.span
                      layoutId="nav-pill"
                      className="absolute inset-0 bg-accent-pill rounded-lg"
                      transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                    />
                  )}
                  <span className={`relative flex items-center gap-1.5 ${isActive ? 'text-accent-pill font-semibold' : ''}`}>
                    <t.icon size={15} /> {t.label}
                  </span>
                </NavLink>
              )
            })}
          </nav>

          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="ml-auto flex items-center justify-center w-9 h-9 rounded-lg bg-panel hover-strong bg-panel-hover transition"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={theme}
                initial={{ opacity: 0, rotate: -90, scale: 0.5 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 90, scale: 0.5 }}
                transition={{ duration: 0.2 }}
              >
                {theme === 'dark' ? <Moon size={16} className="text-accent-pill" /> : <Sun size={16} className="text-amber-500" />}
              </motion.span>
            </AnimatePresence>
          </button>

          <button
            onClick={logout}
            title="Log out"
            className="flex items-center gap-1.5 text-sm text-muted hover:text-red-300 px-2.5 py-1.5 rounded-lg hover:bg-red-500/10 transition"
          >
            <LogOut size={15} /> Log out
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>

      <LogoutOverlay
        open={loggingOut}
        stats={{ analyzed: Object.values(qcResults || {}).filter(e => e && !e.pending && e.analysis).length }}
        onDone={finishLogout}
      />
    </div>
  )
}
