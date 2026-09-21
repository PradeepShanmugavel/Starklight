import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from './context/AppContext'
import LoginPage from './components/LoginPage'
import Layout from './components/Layout'
import Home from './sections/Home'
import TestQCPage from './sections/TestQC/TestQCPage'
import TestQCAnalyzePage from './sections/TestQC/TestQCAnalyzePage'
import TopicAnalyserPage from './sections/TopicAnalyser/TopicAnalyserPage'
import SolutionManagerPage from './sections/SolutionManager/SolutionManagerPage'
import QbOrganiserPage from './sections/QbOrganiser/QbOrganiserPage'
import LanguageManagerPage from './sections/LanguageManager/LanguageManagerPage'

export default function App() {
  const { token } = useApp()

  if (!token) return <LoginPage />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/test-qc" element={<TestQCPage />} />
        <Route path="/test-qc/analyze" element={<TestQCAnalyzePage />} />
        <Route path="/topic-alignment" element={<TopicAnalyserPage />} />
        <Route path="/solutions" element={<SolutionManagerPage />} />
        <Route path="/qb-organiser" element={<QbOrganiserPage />} />
        <Route path="/language-manager" element={<LanguageManagerPage />} />

        {/* Old paths kept as redirects so existing bookmarks and any link
            written down before the rename still land somewhere useful. */}
        <Route path="/topic-analyser" element={<Navigate to="/topic-alignment" replace />} />
        <Route path="/solution-forge" element={<Navigate to="/solutions" replace />} />
        <Route path="/manual-packing/*" element={<Navigate to="/" replace />} />
        <Route path="/smart-packer" element={<Navigate to="/" replace />} />

        {/* Anything else falls back to the dashboard rather than a blank page. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
