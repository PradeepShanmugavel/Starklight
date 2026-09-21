import { useState } from 'react'
import { Wrench, Copy, Check, AlertTriangle, Lightbulb } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { api } from '../../lib/api'
import { stripHtml, getSolutionCode, getCodeConstraints, getSampleCases, getHiddenTestCases, formatCases, findRepeatedTestCases, getMcqData, getDebugCodeBestEffort, isDebugQuestion, getFillupData, normalizeRectification } from '../../lib/helpers'
import { copyRich } from '../../lib/clipboard'
import RichHtml from '../../components/RichHtml'

// onFixesUpdated(qId, newFixNeededArray) — caller (QCResultsPanel) applies this immutably
// to qcResults, so no state object here is ever mutated directly.
export default function FixNeededCell({ q, analysis, onFixesUpdated }) {
  const { token } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fixes = Array.isArray(analysis.fix_needed) ? analysis.fix_needed : []

  if (!fixes.length) return <span className="text-muted2 text-sm">– none</span>

  const pending = fixes.filter(f => !f.rectification)

  async function getFixes() {
    if (!token) { setError('Paste an access token first.'); return }
    setBusy(true); setError('')
    const pq = q.programming_question || {}
    try {
      const data = await api.qcRectify(token, {
        question_text: stripHtml(q.question_data || ''),
        input_format: stripHtml(pq.input_format || ''),
        output_format: stripHtml(pq.output_format || ''),
        // Sent as DISTINCT fields — merging these was making the constraints check judge
        // test-case data instead of the actual constraints.
        constraints: getCodeConstraints(q),
        sample_cases: formatCases(getSampleCases(q)),
        hidden_test_cases: formatCases(getHiddenTestCases(q), { withScores: true }),
        repeated_cases: findRepeatedTestCases(q),
        solution_code: getSolutionCode(q),
        question_type: q.question_type,
        mcq_data: getMcqData(q),
        debug_code: isDebugQuestion(q) ? getDebugCodeBestEffort(q) : '',
        fillup_data: q.fillup_questions ? JSON.stringify(getFillupData(q), null, 2) : '',
        fix_needed: pending.map(f => ({ area: f.area, severity: f.severity, issue: f.issue }))
      })
      const rects = data.rectifications || []
      let rectIdx = 0
      const newFixNeeded = fixes.map(f => {
        if (f.rectification) return f // already fetched earlier — leave as-is
        const r = rects[rectIdx]; rectIdx++
        if (!r) return f
        // normalizeRectification unwraps any JSON envelope the model may have returned and
        // produces plain text that keeps newlines/indentation, so code fixes stay pasteable.
        const norm = normalizeRectification(r.replacement_text)
        return {
          ...f,
          rectification: {
            where_to_replace: r.where_to_replace || '',
            html: norm.html,
            text: norm.text
          }
        }
      })
      onFixesUpdated(q.q_id, newFixNeeded)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 min-w-[220px]">
      {fixes.map((f, idx) => (
        <div key={idx}>
          <div className="text-xs flex items-start gap-1.5">
            {f.severity === 'must-fix'
              ? <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />
              : <Lightbulb size={13} className="text-amber-400 mt-0.5 shrink-0" />}
            <span><b className="text-body-app">{f.area}</b>: <span className="text-muted">{f.issue}</span></span>
          </div>
          {f.rectification && (
            <div className="mt-1.5 rounded-lg border border-theme bg-black/40 p-2">
              {f.rectification.where_to_replace && (
                <div className="text-[10px] uppercase tracking-wide text-muted2 mb-1.5">
                  {f.rectification.where_to_replace}
                </div>
              )}
              {looksLikeCode(f.rectification.text) ? (
                // Code fixes render in a <pre> so indentation survives and the copy is
                // pasteable straight back into the portal.
                <pre className="text-[11px] leading-[1.55] max-h-52 overflow-auto whitespace-pre font-mono text-body-app">
                  {f.rectification.text}
                </pre>
              ) : (
                <RichHtml html={f.rectification.html} className="text-xs leading-relaxed max-h-40 overflow-auto" />
              )}
              <CopyButton html={f.rectification.html} text={f.rectification.text} />
            </div>
          )}
        </div>
      ))}
      {pending.length > 0 && (
        <button
          onClick={getFixes}
          disabled={busy}
          className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 self-start"
        >
          <Wrench size={13} /> {busy ? 'Getting fixes…' : 'Get Fixes'}
        </button>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  )
}

function CopyButton({ html, text }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => { const ok = await copyRich(html, text); if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }}
      className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md bg-white/10 hover:bg-white/15"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

// Heuristic: does this rectification look like source code rather than prose? Code needs a
// <pre> (indentation preserved); prose reads better as normal wrapped text.
function looksLikeCode(text) {
  const t = String(text || '')
  if (!t.includes('\n')) return false
  const codeSignals = /[;{}]|^\s*(#include|import |def |class |public |private |for |while |if )/m
  const indented = /\n[ \t]{2,}\S/.test(t)
  return codeSignals.test(t) && (indented || t.split('\n').length > 3)
}
