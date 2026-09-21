import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, FolderSearch2, Loader2 } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { api } from '../../lib/api'
import { assignSectionQuestionNumbers } from '../../lib/helpers'
import SkeletonRows from '../../components/SkeletonRows'

// Parses the confirmed GET /api/questions/test/{id} shape:
// [ { name, duration, noOfQuestions, group_questions: [...], non_group_questions: [...] }, ... ]
function parseQuestionsByTestResponse(root) {
  const arr = Array.isArray(root) ? root : Array.isArray(root?.results) ? root.results : Array.isArray(root?.data) ? root.data : null
  if (!arr) return []
  const merged = []
  for (const section of arr) {
    if (!section || typeof section !== 'object') continue
    const sectionName = section.name || 'Section'
    const lists = [
      ...(Array.isArray(section.non_group_questions) ? section.non_group_questions : []),
      ...(Array.isArray(section.group_questions) ? section.group_questions : [])
    ]
    for (const q of lists) {
      if (q && typeof q === 'object' && q.q_id) {
        if (!q._sectionName) q._sectionName = sectionName
        merged.push(q)
      }
    }
  }
  return merged
}

export default function TestQCPage() {
  const { token, deptIds, noteQcSource, setOpenTestQc } = useApp()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [tests, setTests] = useState([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(null) // testId currently being opened

  async function runSearch() {
    if (!token) { setError('Please paste an access token first.'); return }
    setLoading(true); setError(''); setStatus('Searching…')
    try {
      const body = { branch_id: 'All', department_id: deptIds, limit: 25, mainDepartmentUser: true, page: 1 }
      if (search.trim()) body.search = search.trim()
      const data = await api.searchTests(token, body)
      const results = data.results || data.data || data
      const rows = Array.isArray(results) ? results
        : Array.isArray(results?.tests) ? results.tests
        : Array.isArray(results?.testList) ? results.testList
        : Array.isArray(results?.data) ? results.data
        : []
      setTests(rows)
      setStatus(`Found ${rows.length} test(s).`)
    } catch (err) {
      setError(err.message)
      setStatus('')
    } finally {
      setLoading(false)
    }
  }

  async function openTest(test) {
    const testId = test._id || test.test_id || test.testId || test.id
    const testName = test.testName || test.test_name || test.t_name || test.name || 'Untitled test'
    if (!testId) { setError('This row has no usable test ID.'); return }

    setOpening(testId); setError('')
    try {
      const data = await api.getQuestionsForTest(token, testId)
      const merged = parseQuestionsByTestResponse(data)
      if (!merged.length) {
        setError('This test\'s detail response had no full question data in the expected shape.')
        return
      }
      assignSectionQuestionNumbers(merged)
      noteQcSource(testName) // keeps prior analysis/fixes if this is the same test as before
      setOpenTestQc({ testLabel: testName, questions: merged, selected: new Set(), topicsIncluded: '', topicsExcluded: '' })
      navigate('/test-qc/analyze')
    } catch (err) {
      setError(err.message)
    } finally {
      setOpening(null)
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">🛡️ Test QC</h1>
        <p className="text-sm text-muted">Search a published test by name, open it, then analyze its questions on a dedicated page.</p>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted2 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
            placeholder="e.g. Coding_Skill_Assessment_Unit 3"
            className="input"
            style={{ paddingLeft: '2.25rem' }}
          />
        </div>
        <button
          onClick={runSearch}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 px-4 py-2.5 font-semibold text-sm"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <FolderSearch2 size={16} />} Search
        </button>
      </div>

      {status && <p className="text-sm text-muted">{status}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading && !tests.length && <SkeletonRows />}

      {tests.length > 0 && (
        <div className="rounded-xl border border-theme overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-muted text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Test Name</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Visibility</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t, i) => {
                const testId = t._id || t.test_id || t.testId || t.id
                return (
                  <tr key={testId || i} className="bg-panel-hover">
                    <td className="px-4 py-2.5">{t.testName || t.test_name || t.t_name || t.name || '(unnamed)'}</td>
                    <td className="px-4 py-2.5 text-muted">{t.testType || t.test_type || '—'}</td>
                    <td className="px-4 py-2.5 text-muted">{t.visibility || '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => openTest(t)}
                        disabled={opening === testId}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
                      >
                        {opening === testId ? '⏳ Opening…' : '🚀 Open & QC'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  )
}
