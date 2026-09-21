import { useEffect } from 'react'
import { motion } from 'framer-motion'
import Logo from './Logo'

// A short "warp in" sequence: light streaks converge, the name lands, then it clears.
// Deliberately abstract (speed lines / hyperspace) rather than console-and-joystick imagery.
const ORBITER_COUNT = 18

const jitter = (i, salt) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x) // fractional part → deterministic pseudo-random in [0, 1)
}

// Start points spread around a circle well outside the portal; each particle is animated
// inward to the centre. Precomputed at module scope so render stays pure.
const ORBITERS = Array.from({ length: ORBITER_COUNT }, (_, i) => {
  const angle = (Math.PI * 2 * i) / ORBITER_COUNT + jitter(i, 1) * 0.3
  const dist = 320 + jitter(i, 2) * 160
  return {
    id: i,
    fromX: Math.cos(angle) * dist,
    fromY: Math.sin(angle) * dist,
    delay: jitter(i, 3) * 0.5
  }
})

export default function LoginTransition({ open, name, onDone }) {
  useEffect(() => {
    if (!open) return
    const t = setTimeout(onDone, 1750)
    return () => clearTimeout(t)
  }, [open, onDone])

  if (!open) return null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#0b0d12] overflow-hidden"
    >
      {/* --- Portal: concentric rings that spin up and iris open --- */}
      {[0, 1, 2].map(i => (
        <motion.span
          key={`ring-${i}`}
          aria-hidden
          initial={{ scale: 0.2, opacity: 0, rotate: 0 }}
          animate={{ scale: [0.2, 1.15, 1], opacity: [0, 0.85, 0.25], rotate: 180 * (i % 2 ? -1 : 1) }}
          transition={{ duration: 1.5, delay: i * 0.12, ease: [0.22, 1, 0.36, 1] }}
          style={{ width: 200 + i * 90, height: 200 + i * 90, borderWidth: 2 - i * 0.5 }}
          className="absolute rounded-full border-indigo-400/70"
        />
      ))}

      {/* Dashed outer ring, slowly rotating — reads as the portal "frame" */}
      <motion.span
        aria-hidden
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 0.5, rotate: 360 }}
        transition={{ duration: 1.75, ease: 'easeOut' }}
        style={{ width: 420, height: 420 }}
        className="absolute rounded-full border-2 border-dashed border-sky-300/40"
      />

      {/* Glowing core that blooms then fades as the portal "opens" */}
      <motion.span
        aria-hidden
        initial={{ scale: 0, opacity: 0.9 }}
        animate={{ scale: [0, 1.6, 2.4], opacity: [0.9, 0.5, 0] }}
        transition={{ duration: 1.5, ease: 'easeOut' }}
        className="absolute w-52 h-52 rounded-full bg-gradient-to-br from-indigo-400/60 via-violet-400/40 to-transparent blur-2xl"
      />

      {/* Particles drawn inward, as if pulled through the portal */}
      {ORBITERS.map(o => (
        <motion.span
          key={`orb-${o.id}`}
          aria-hidden
          initial={{ x: o.fromX, y: o.fromY, opacity: 0, scale: 0.6 }}
          animate={{ x: 0, y: 0, opacity: [0, 1, 0], scale: 0.2 }}
          transition={{ duration: 1.25, delay: o.delay, ease: 'easeIn' }}
          className="absolute w-1.5 h-1.5 rounded-full bg-sky-200"
        />
      ))}

      <div className="relative text-center px-8">
        <motion.div
          initial={{ scale: 0.3, opacity: 0, filter: 'blur(14px)' }}
          animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
          transition={{ type: 'spring', stiffness: 190, damping: 15, delay: 0.45 }}
          className="mb-4 flex items-center justify-center text-indigo-300"
        >
          <Logo size={64} />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, letterSpacing: '0.6em', y: 8 }}
          animate={{ opacity: 1, letterSpacing: '0.1em', y: 0 }}
          transition={{ duration: 0.6, delay: 0.55 }}
          className="text-2xl sm:text-3xl font-black tracking-widest bg-gradient-to-r from-indigo-200 via-sky-200 to-violet-200 bg-clip-text text-transparent"
        >
          {name ? `Welcome, ${name}` : 'Welcome'}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.95 }}
          className="text-[11px] tracking-[0.15em] text-slate-500 mt-3"
        >
          Opening workspace
        </motion.p>

        <motion.div
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 1.55, ease: 'easeInOut' }}
          className="h-0.5 w-52 mx-auto mt-4 bg-gradient-to-r from-indigo-400 via-sky-400 to-violet-400 rounded-full origin-left"
        />
      </div>
    </motion.div>
  )
}
