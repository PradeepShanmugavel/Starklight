import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Search, Loader2, Landmark, FileText, Languages, CheckCircle2,
  XCircle, AlertTriangle, StopCircle, Info, Star
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { getTestQuestions, searchTests, resolveQBNames, getQBQuestions, pushSolution } from '../../lib/qbforge/examlyAPI';

const LANGUAGES = ['Python', 'Java', 'Java17', 'Java21', 'C++', 'C'];

// Every language this question already has a solution for, with its code and
// whether it's marked best — same shape/logic as Solution Manager's own
// allSolutionsOf, duplicated here on purpose: this is a separate, standalone
// project and isn't meant to import from (or ever touch) SolutionManagerPage.
function allSolutionsOf(q) {
  const sols = q.programming_question && q.programming_question.solution;
  if (!Array.isArray(sols)) return [];
  return sols
    .map(s => {
      const sd = (s.solutiondata || []).find(sd => sd.solution) || {};
      return {
        language: s.language, code: sd.solution || '', best: !!sd.solutionbest,
        hasSnippet: !!s.hasSnippet, header: s.header || '', footer: s.footer || '', codeStub: s.codeStub || ''
      };
    })
    .filter(s => s.language && s.code);
}

// The portal's own push endpoint requires non-empty code for every language
// entry — there is no "enable this language with nothing behind it" call.
// So enabling a language you have no solution for yet still needs SOME
// content: a clearly-marked placeholder, never a real (let alone AI-written)
// answer, so nobody mistakes it for a finished solution later.
function placeholderCodeFor(language) {
  const marker = 'TODO: no solution written yet for this language — enabled via Language Manager, not a real answer.';
  return String(language || '').toLowerCase().indexOf('python') !== -1 ? `# ${marker}` : `// ${marker}`;
}
function buildPlaceholderEntry(language) {
  return {
    language,
    solutiondata: [{ solution: placeholderCodeFor(language), solutionExp: null, solutionbest: false, isSolutionExp: false, solutionDebug: null }],
    hasSnippet: false, codeStub: '', hideHeader: false, hideFooter: false
  };
}

const STATUS_ICON = { info: Info, ok: CheckCircle2, warn: AlertTriangle, err: XCircle };
const STATUS_CLASS = {
  info: 'text-indigo-300', ok: 'text-emerald-400', warn: 'text-amber-400', err: 'text-red-400'
};
function StatusMsg({ type = 'info', children, loading }) {
  if (!children && !loading) return null;
  const Icon = STATUS_ICON[type] || Info;
  return (
    <p className={`flex items-start gap-1.5 text-xs mt-2 ${STATUS_CLASS[type] || 'text-muted'}`}>
      {loading ? <Loader2 size={13} className="animate-spin shrink-0 mt-0.5" /> : <Icon size={13} className="shrink-0 mt-0.5" />}
      <span className="whitespace-pre-wrap">{children}</span>
    </p>
  );
}

// What would happen to ONE question given the current global "keep" set and
// best choice. Nothing is ever generated — checking a language just selects
// its NAME. If that language already has a solution, it's kept (or made
// best); if it doesn't, it shows up under `add` — applying pushes it as an
// ENABLED language (multilanguage gains it) with a clearly-marked placeholder
// standing in for the missing solution, never real or AI-written code. Same
// story for best: if the language picked as best has no solution, that's
// surfaced as `desiredBestMissing` instead of ever marking a placeholder
// best; `bestLang` always falls back to a real, existing language so a push
// always has valid code behind whatever it marks best.
function computePlan(q, keepLanguages, preferredBest, bestOverride) {
  const sols = allSolutionsOf(q);
  const existingLangs = sols.map(s => s.language);
  const wanted = LANGUAGES.filter(l => keepLanguages[l]);
  const keep = existingLangs.filter(l => wanted.includes(l));
  const remove = existingLangs.filter(l => !wanted.includes(l));
  const add = wanted.filter(l => !existingLangs.includes(l));

  const desiredBest = bestOverride || null;
  const desiredBestMissing = !!(desiredBest && !keep.includes(desiredBest));

  let bestLang = desiredBest && keep.includes(desiredBest) ? desiredBest : null;
  if (!bestLang) {
    const currentBest = sols.find(s => s.best);
    if (currentBest && keep.includes(currentBest.language)) bestLang = currentBest.language;
  }
  if (!bestLang && keep.includes(preferredBest)) bestLang = preferredBest;
  if (!bestLang) bestLang = keep[0] || null;

  const currentBestLang = (sols.find(s => s.best) || {}).language || null;

  return { sols, existingLangs, keep, remove, add, bestLang, desiredBest, desiredBestMissing, currentBestLang };
}

export default function LanguageManagerPage() {
  const { token } = useApp();

  const [searchMode, setSearchMode] = useState('test'); // 'test' | 'qb'
  const [searchTerm, setSearchTerm] = useState('');
  const [loadingQs, setLoadingQs] = useState(false);
  const [qStatus, setQStatus] = useState(null);
  const [testsUsed, setTestsUsed] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [candidates, setCandidates] = useState(null);

  // Every language kept ON by default — removal only ever happens after the
  // user explicitly unchecks one, never as a side effect of loading a test/QB.
  const [keepLanguages, setKeepLanguages] = useState(() => Object.fromEntries(LANGUAGES.map(l => [l, true])));
  const [preferredBest, setPreferredBest] = useState(LANGUAGES[0]);
  const [bestOverride, setBestOverride] = useState({}); // id -> language (may or may not actually exist on that question)

  const [selectedIds, setSelectedIds] = useState({});
  const [results, setResults] = useState({}); // id -> { status: 'working'|'done'|'skipped'|'error', reason?, kept?, removed?, best? }
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const bulkStopRequestedRef = useRef(false);

  function toggleKeepLanguage(lang) {
    setKeepLanguages(prev => ({ ...prev, [lang]: !prev[lang] }));
  }

  function toggleSelected(id) {
    setSelectedIds(prev => ({ ...prev, [id]: !prev[id] }));
  }

  function resetForLoad() {
    setQStatus(null);
    setQuestions([]);
    setTestsUsed([]);
    setResults({});
    setSelectedIds({});
    setBestOverride({});
  }

  async function loadTestByName(name) {
    setLoadingQs(true);
    resetForLoad();
    try {
      const res = await getTestQuestions(token, name);
      const pool = res.data || [];
      setQuestions(pool);
      setTestsUsed(res.tests || [name]);
      const notFoundCount = res.notFound?.length || 0;
      const matchedNames = (res.tests || [name]).join(', ');
      setQStatus({
        type: pool.length ? (notFoundCount ? 'warn' : 'ok') : 'warn',
        msg: pool.length
          ? `Loaded ${pool.length} of ${res.requested} question(s) from test "${matchedNames}".` +
            (notFoundCount ? ` ${notFoundCount} question(s) could not be located in any QB you can see.` : '')
          : res.zeroQuestionIds
            ? `Test "${matchedNames}" matched, but it has no questions attached on the portal.`
            : `Test "${name}" matched, but none of its questions could be located in any QB you can see — check you have access to the QB(s) it draws from.`
      });
    } catch (err) {
      setQStatus({ type: 'err', msg: err.response?.data?.error || err.message });
    } finally {
      setLoadingQs(false);
    }
  }

  async function loadQB(qb) {
    setLoadingQs(true);
    resetForLoad();
    try {
      const r = await getQBQuestions(token, qb.id, qb.name);
      const pool = (r.data || []).map(q => ({ ...q, qbId: qb.id, qbName: qb.name }));
      setQuestions(pool);
      setTestsUsed([qb.name]);
      setQStatus({
        type: pool.length ? 'ok' : 'warn',
        msg: pool.length ? `Loaded ${pool.length} question(s) from QB "${qb.name}".` : `QB "${qb.name}" matched but has no questions.`
      });
    } catch (err) {
      setQStatus({ type: 'err', msg: err.response?.data?.error || err.message });
    } finally {
      setLoadingQs(false);
    }
  }

  async function handleFind() {
    if (loadingQs) return;
    const term = searchTerm.trim();
    if (!term) { setQStatus({ type: 'err', msg: searchMode === 'qb' ? 'Enter a QB name.' : 'Enter a test name.' }); return; }

    setLoadingQs(true);
    resetForLoad();

    try {
      if (searchMode === 'qb') {
        const resolved = await resolveQBNames(token, [term]);
        const qbs = resolved.data || [];
        if (!qbs.length) {
          setQStatus({ type: 'err', msg: `No QB found matching "${term}".` });
          setLoadingQs(false);
          return;
        }
        if (qbs.length === 1) { await loadQB(qbs[0]); return; }
        setCandidates({ type: 'qb', items: qbs });
        setQStatus({ type: 'warn', msg: `${qbs.length} QBs match "${term}" — pick the one you mean below.` });
        setLoadingQs(false);
        return;
      }

      const searchRes = await searchTests(token, term);
      const testMatches = searchRes.data || [];
      if (!testMatches.length) {
        setQStatus({ type: 'err', msg: `No test found matching "${term}".` });
        setLoadingQs(false);
        return;
      }
      if (testMatches.length === 1) { await loadTestByName(testMatches[0].name); return; }
      setCandidates({ type: 'test', items: testMatches });
      setQStatus({ type: 'warn', msg: `${testMatches.length} tests match "${term}" — pick the one you mean below.` });
      setLoadingQs(false);
    } catch (err) {
      setQStatus({ type: 'err', msg: err.response?.data?.error || err.message });
      setLoadingQs(false);
    }
  }

  async function applyFor(q) {
    if (q.qbUnresolved) {
      setResults(prev => ({ ...prev, [q.id]: { status: 'skipped', reason: 'This question\'s question bank could not be resolved, so pushing to it risks silently clearing other metadata (topic, difficulty, tags, ...) on the portal — skipped for safety.' } }));
      return false;
    }
    const plan = computePlan(q, keepLanguages, preferredBest, bestOverride[q.id]);
    if (!plan.keep.length && !plan.add.length) {
      setResults(prev => ({ ...prev, [q.id]: { status: 'skipped', reason: 'None of the languages you chose exist on this question — nothing changed.' } }));
      return false;
    }
    if (!plan.keep.length) {
      setResults(prev => ({ ...prev, [q.id]: { status: 'skipped', reason: 'Every existing language would be removed, leaving nothing real to mark as best — keep at least one existing solution.' } }));
      return false;
    }
    if (!plan.remove.length && !plan.add.length && plan.bestLang === plan.currentBestLang) {
      setResults(prev => ({ ...prev, [q.id]: { status: 'skipped', reason: 'Nothing to change — the languages and best solution already match.' } }));
      return false;
    }

    setResults(prev => ({ ...prev, [q.id]: { status: 'working' } }));
    const bestEntry = plan.sols.find(s => s.language === plan.bestLang);
    const filteredExisting = (q.programming_question.solution || []).filter(s => plan.keep.includes(s.language));
    const placeholderEntries = plan.add.map(buildPlaceholderEntry);
    const finalSolution = [...filteredExisting, ...placeholderEntries];
    const realizedLangs = finalSolution.map(s => s.language);
    const rawQuestionTrimmed = { ...q, programming_question: { ...q.programming_question, solution: finalSolution } };

    try {
      await pushSolution(token, q.id, plan.bestLang, bestEntry.code, {
        qbId: q.qbId,
        rawQuestion: rawQuestionTrimmed,
        snippet: { hasSnippet: bestEntry.hasSnippet, header: bestEntry.header, footer: bestEntry.footer, codeStub: bestEntry.codeStub }
      });
      setQuestions(prevQs => prevQs.map(item => {
        if (item.id !== q.id) return item;
        const newSolution = finalSolution.map(s => ({
          ...s,
          solutiondata: Array.isArray(s.solutiondata)
            ? s.solutiondata.map(sd => ({ ...sd, solutionbest: s.language === plan.bestLang }))
            : s.solutiondata
        }));
        return { ...item, multilanguage: realizedLangs, programming_question: { ...item.programming_question, solution: newSolution } };
      }));
      setResults(prev => ({
        ...prev, [q.id]: {
          status: 'done', kept: plan.keep, removed: plan.remove, added: plan.add, best: plan.bestLang,
          desiredBest: plan.desiredBest, desiredBestMissing: plan.desiredBestMissing
        }
      }));
      return true;
    } catch (err) {
      setResults(prev => ({ ...prev, [q.id]: { status: 'error', reason: err.response?.data?.error || err.message } }));
      return false;
    }
  }

  function stopBulk() {
    bulkStopRequestedRef.current = true;
  }

  async function applySelected() {
    const ids = Object.keys(selectedIds).filter(id => selectedIds[id]);
    const targets = questions.filter(q => ids.includes(String(q.id)) && !q.qbUnresolved);
    if (!targets.length) return;
    bulkStopRequestedRef.current = false;
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (bulkStopRequestedRef.current) break;
      await applyFor(targets[i]);
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkRunning(false);
    bulkStopRequestedRef.current = false;
  }

  function selectAllWithChanges() {
    const withChanges = questions.filter(q => {
      if (q.qbUnresolved) return false;
      const p = computePlan(q, keepLanguages, preferredBest, bestOverride[q.id]);
      return p.remove.length > 0 || p.add.length > 0 || p.bestLang !== p.currentBestLang;
    });
    setSelectedIds(Object.fromEntries(withChanges.map(q => [q.id, true])));
  }

  const selectedCount = Object.values(selectedIds).filter(Boolean).length;
  const doneCount = Object.values(results).filter(r => r.status === 'done').length;
  const skippedCount = Object.values(results).filter(r => r.status === 'skipped').length;
  const errorCount = Object.values(results).filter(r => r.status === 'error').length;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold mb-0.5 flex items-center gap-2">
          <Languages size={22} className="text-accent-pill" /> Language Manager
        </h1>
        <p className="text-sm text-muted">
          Give either a test name or a QB name, then pick the language names each question should have. An existing
          language you uncheck is removed from the portal, permanently. A language you check that has no solution yet
          is enabled on the portal too — but with a clearly-marked placeholder standing in for it, never real or
          AI-written code, since nothing is ever generated here. Among whichever languages already have a real
          solution, you pick which one becomes the "Best Solution".
        </p>
      </div>

      <div className="rounded-xl border border-theme bg-panel p-4 flex flex-col gap-3">
        <div className="flex gap-2 flex-wrap">
          <div className="flex rounded-lg border border-theme overflow-hidden shrink-0">
            {[['test', 'Test', FileText], ['qb', 'Question Bank', Landmark]].map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => setSearchMode(id)}
                disabled={loadingQs}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition ${
                  searchMode === id ? 'bg-accent-pill text-accent-pill' : 'text-muted bg-panel-hover'
                }`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[220px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted2 pointer-events-none" />
            <input
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleFind(); }}
              placeholder={searchMode === 'qb' ? 'e.g. NeoColab_Java_COD_Array of Objects' : 'e.g. Java Backend Assessment — Batch 2026'}
              className="input" style={{ paddingLeft: '2.1rem' }}
              disabled={loadingQs}
            />
          </div>
          <button
            onClick={handleFind} disabled={loadingQs}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-sm font-semibold disabled:opacity-50"
          >
            {loadingQs ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {loadingQs ? 'Loading...' : 'Find'}
          </button>
        </div>

        {loadingQs && <StatusMsg loading>Resolving question(s)...</StatusMsg>}
        {!loadingQs && qStatus && <StatusMsg type={qStatus.type}>{qStatus.msg}</StatusMsg>}

        {!loadingQs && candidates && (
          <div className="rounded-lg border border-theme overflow-hidden mt-1">
            {candidates.items.map(item => (
              <button
                key={item.id}
                onClick={() => candidates.type === 'test' ? loadTestByName(item.name) : loadQB(item)}
                className="flex items-center justify-between w-full px-3 py-2.5 text-left bg-panel-hover border-b border-theme last:border-b-0"
              >
                <span className="text-sm text-body-app">{item.name}</span>
                <span className="text-xs text-muted2">
                  {candidates.type === 'test'
                    ? `${item.questionCount ?? '?'} question(s)${item.publishStatus ? ' · ' + item.publishStatus : ''}`
                    : `${item.questionCount ?? '?'} question(s)${item.code ? ' · ' + item.code : ''}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!loadingQs && questions.length > 0 && (
        <div className="rounded-xl border border-theme bg-panel p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm font-semibold text-body-app">
              {testsUsed.join(', ')} <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-accent-pill text-accent-pill">{questions.length}</span>
            </span>
          </div>

          <div className="rounded-lg border border-theme bg-panel-hover p-3 flex flex-col gap-3">
            <div>
              <div className="text-xs font-semibold text-muted mb-1.5">
                Languages you want — unchecked existing ones get removed; a checked one with no solution is enabled with a placeholder, not generated
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {LANGUAGES.map(l => (
                  <label key={l} className="flex items-center gap-1.5 text-xs text-body-app cursor-pointer">
                    <input type="checkbox" checked={!!keepLanguages[l]} onChange={() => toggleKeepLanguage(l)} disabled={bulkRunning} />
                    {l}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted">Preferred best language</span>
              <select
                value={preferredBest}
                onChange={ev => setPreferredBest(ev.target.value)}
                disabled={bulkRunning}
                className="input text-xs w-auto py-1"
                title="Used when the question's current best solution isn't in the kept set"
              >
                {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <span className="text-xs text-muted2">(falls back to whichever kept language exists, if this one isn't present)</span>
            </div>
          </div>

          <StatusMsg type="warn">
            Removing a language deletes that solution from the portal permanently — this cannot be undone. Adding a
            language enables it on the portal too, but with a clearly-marked placeholder in place of a real solution
            — nothing is ever generated or AI-written here, so go write the actual solution for anything added.
            Review each question's plan below before applying.
          </StatusMsg>

          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={questions.some(q => !q.qbUnresolved) && questions.filter(q => !q.qbUnresolved).every(q => selectedIds[q.id])}
                onChange={() => {
                  const selectable = questions.filter(q => !q.qbUnresolved);
                  const allSelected = selectable.length > 0 && selectable.every(q => selectedIds[q.id]);
                  setSelectedIds(allSelected ? {} : Object.fromEntries(selectable.map(q => [q.id, true])));
                }}
                disabled={bulkRunning}
              />
              Select all
            </label>
            <button
              onClick={selectAllWithChanges}
              disabled={bulkRunning}
              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-40"
            >
              Select only questions with changes
            </button>
            <button
              onClick={applySelected}
              disabled={bulkRunning || !selectedCount}
              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-green-600 hover:opacity-90 disabled:opacity-40"
            >
              {bulkRunning
                ? `Applying ${bulkProgress ? bulkProgress.done : 0}/${bulkProgress ? bulkProgress.total : 0}...`
                : `Apply to selected (${selectedCount})`}
            </button>
            {bulkRunning && (
              <button onClick={stopBulk} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30">
                <StopCircle size={13} /> Stop
              </button>
            )}
          </div>

          {bulkRunning && (
            <StatusMsg loading>Applying one question at a time ({bulkProgress?.done || 0}/{bulkProgress?.total || 0} done)...</StatusMsg>
          )}
          {!bulkRunning && (doneCount > 0 || skippedCount > 0 || errorCount > 0) && (
            <StatusMsg type={errorCount > 0 ? 'err' : skippedCount > 0 ? 'warn' : 'ok'}>
              {doneCount} applied.{skippedCount > 0 && ` ${skippedCount} skipped (no change needed or nothing to keep).`}{errorCount > 0 && ` ${errorCount} failed.`}
            </StatusMsg>
          )}

          <div className="flex flex-col gap-2">
            {questions.map(q => {
              const plan = computePlan(q, keepLanguages, preferredBest, bestOverride[q.id]);
              const result = results[q.id];
              const working = result?.status === 'working';
              const hasChanges = plan.remove.length > 0 || plan.add.length > 0 || plan.bestLang !== plan.currentBestLang;
              return (
                <div key={q.id} className="rounded-lg border border-theme bg-panel-hover p-3">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={!!selectedIds[q.id]}
                      onChange={() => toggleSelected(q.id)}
                      disabled={bulkRunning || q.qbUnresolved}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-body-app">{q.title}</span>
                      <div className="text-xs text-muted mt-1">
                        {q.qbUnresolved && <span className="text-amber-400 mr-1.5">QB unknown —</span>}
                        Has: {plan.existingLangs.length ? plan.existingLangs.join(', ') : '—'}
                      </div>
                      {(plan.existingLangs.length > 0 || plan.add.length > 0) && (
                        <div className="text-xs mt-1 flex items-center gap-1 flex-wrap">
                          {plan.keep.length > 0 && <span className="text-emerald-400">Keep: {plan.keep.join(', ')}</span>}
                          {plan.remove.length > 0 && <span className="text-red-400">· Remove: {plan.remove.join(', ')}</span>}
                          {plan.add.length > 0 && <span className="text-sky-400">· Add: {plan.add.join(', ')} (enables with a placeholder — write the real solution after)</span>}
                          {plan.keep.length > 0 && (
                            <span className="flex items-center gap-1 text-accent-pill">
                              · <Star size={11} /> Best:
                              <select
                                value={bestOverride[q.id] || plan.bestLang || ''}
                                onChange={ev => setBestOverride(prev => ({ ...prev, [q.id]: ev.target.value }))}
                                disabled={bulkRunning || working}
                                className="input text-xs w-auto py-0.5"
                              >
                                {LANGUAGES.map(l => <option key={l} value={l}>{l}{plan.keep.includes(l) ? '' : ' (no solution)'}</option>)}
                              </select>
                            </span>
                          )}
                        </div>
                      )}
                      {plan.desiredBestMissing && (
                        <StatusMsg type="warn">
                          You picked {plan.desiredBest} as best, but this question has no {plan.desiredBest} solution yet —
                          add one on the portal and mark it best yourself.
                          {plan.bestLang ? ` Best will stay ${plan.bestLang} for now.` : ' No other language is available to set as best.'}
                        </StatusMsg>
                      )}
                      {result?.status === 'done' && (
                        <StatusMsg type={result.desiredBestMissing ? 'warn' : 'ok'}>
                          Kept {result.kept.join(', ')}
                          {result.added.length > 0 ? ` — enabled ${result.added.join(', ')} with a placeholder (write the real solution on the portal)` : ''}
                          {result.removed.length > 0 ? ` — removed ${result.removed.join(', ')}` : ''}. Best: {result.best}.
                          {result.desiredBestMissing && ` (${result.desiredBest} has no solution — add one and mark it best yourself.)`}
                        </StatusMsg>
                      )}
                      {result?.status === 'skipped' && <StatusMsg type="warn">{result.reason}</StatusMsg>}
                      {result?.status === 'error' && <StatusMsg type="err">{result.reason}</StatusMsg>}
                    </div>
                    <button
                      onClick={() => applyFor(q)}
                      disabled={bulkRunning || working || !hasChanges || q.qbUnresolved}
                      title={q.qbUnresolved ? 'This question\'s bank could not be resolved — pushing to it risks losing other metadata' : !hasChanges ? 'Nothing to change for this question' : undefined}
                      className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 disabled:opacity-40 shrink-0"
                    >
                      {working ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                      {working ? 'Applying...' : 'Apply'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </motion.div>
  );
}
