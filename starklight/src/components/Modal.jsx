import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'

export default function Modal({ open, onClose, title, children, wide = false }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={e => { if (e.target === e.currentTarget) onClose?.() }}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            className={`bg-surface border border-theme rounded-2xl w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} max-h-[85vh] overflow-y-auto p-6 shadow-2xl`}
          >
            <div className="flex items-center justify-between mb-4">
              {title ? <h2 className="text-lg font-semibold">{title}</h2> : <span />}
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-muted">
                <X size={18} />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
