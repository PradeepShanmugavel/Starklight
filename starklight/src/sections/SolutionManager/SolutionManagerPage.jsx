import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Search, Loader2, Landmark, FileText, Hammer, UploadCloud, Copy,
  CheckCircle2, XCircle, AlertTriangle, StopCircle, Info, PlayCircle
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { getTestQuestions, searchTests, resolveQBNames, getQBQuestions, pushSolution } from '../../lib/qbforge/examlyAPI';
import { translateSolution, translateFragment, translateStub, fixSolution } from '../../lib/qbforge/groqAPI';
import { runTests } from '../../lib/qbforge/executeAPI';

// ── QBForge's Solution Manager, ported as-is ────────────────────────────────
// Every function below (search/resolve, generate, verify+auto-fix, push) is
// QBForge's own logic, unchanged — only the JSX at the bottom is restyled
// with Starlight's own Tailwind design tokens (bg-panel/border-theme/etc.)
// instead of QBForge's plain CSS classes, and it calls QBForge's own backend
// (mounted at /api/examly, /api/groq, /api/execute in backend/server.js,
// see backend/qbforge-routes/) rather than any of Starlight's own endpoints.

// Up to this many automatic fix-and-retest rounds after the initial
// generate, using the REAL demonstrated expected-vs-actual mismatch from
// local test execution (not a guess) to fix a concrete bug. If it still
// isn't passing after this many rounds, stop and show the last failure —
// never push code that hasn't actually passed.
const MAX_FIX_ATTEMPTS = 3;

// CONFIRMED via a real captured multilanguage array on a live question:
// ["Python", "Java", "Java17", "Java21", "C++", "C"] — the versioned Java
// variants are "Java17"/"Java21" (no space, no parentheses), not the
// "Java (17)" style guessed earlier. This is the exact, complete, only set —
// no other variants (Java11, "C (17)", etc.) are supported.
const LANGUAGES = ['Python', 'Java', 'Java17', 'Java21', 'C++', 'C'];

// "Java", "Java17", "Java21" aren't different languages — they're JVM
// version tags for the SAME language, and older Java source is virtually
// always valid as-is on a newer JVM. Asking the AI to "translate" between
// these anyway doesn't modernize anything useful — it just introduces real
// bugs while doing it. Skip AI translation entirely for this case and copy
// the source verbatim — faster, and zero risk of this class of bug.
const JAVA_FAMILY = new Set(['java', 'java17', 'java21']);
function sameJavaFamily(a, b) {
  return JAVA_FAMILY.has(String(a || '').toLowerCase()) && JAVA_FAMILY.has(String(b || '').toLowerCase());
}

// The one solution marked "Best Solution" on the portal for this question
// (falls back to the first solution with code if nothing is marked best).
// `hasSnippet`/`header`/`footer`/`codeStub`: some questions wrap the
// student's code in a fixed header/footer and show a codeStub with an
// INTENTIONAL bug, separate from `code` — most questions don't use this at
// all, and it must stay that way (never invented).
const EMPTY_BEST = { code: '', language: null, hasSnippet: false, header: '', footer: '', codeStub: '' };
function bestSolutionOf(q) {
  const sols = q.programming_question && q.programming_question.solution;
  if (!Array.isArray(sols) || !sols.length) return EMPTY_BEST;
  const isBest = s => Array.isArray(s.solutiondata) && s.solutiondata.some(sd => sd.solutionbest && sd.solution);
  const best = sols.find(isBest) || sols.find(s => Array.isArray(s.solutiondata) && s.solutiondata.some(sd => sd.solution));
  if (!best) return EMPTY_BEST;
  const sd = best.solutiondata.find(sd => sd.solution) || {};
  return {
    code: sd.solution || '', language: best.language || null,
    hasSnippet: !!best.hasSnippet, header: best.header || '', footer: best.footer || '', codeStub: best.codeStub || ''
  };
}

// The question's real test cases — sample I/O (visible) + hidden test cases
// combined — as {input, output, label}. Both come back from the fetch as
// JSON *strings*, not arrays, so they need parsing.
function testCasesOf(q) {
  const pq = q.programming_question || {};
  const out = [];
  try {
    const samples = typeof pq.sample_io === 'string' ? JSON.parse(pq.sample_io) : (pq.sample_io || []);
    samples.forEach((t, i) => out.push({ input: t.input, output: t.output, label: `Sample ${i + 1}` }));
  } catch (e) {}
  try {
    const hidden = typeof pq.testcases === 'string' ? JSON.parse(pq.testcases) : (pq.testcases || []);
    hidden.forEach((t, i) => out.push({ input: t.input, output: t.output, label: `Test ${i + 1}${t.difficulty ? ' (' + t.difficulty + ')' : ''}` }));
  } catch (e) {}
  return out;
}

// Every language this question already has a solution for, with its code and
// whether it's marked best — not just the single best one.
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

// Small, Tailwind-styled status line — same role as QBForge's own StatusMsg,
// restyled to match Starlight's palette instead of introducing its own CSS.
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

export default function SolutionManagerPage() {
  const { token } = useApp();

  const [searchMode, setSearchMode] = useState('test'); // 'test' | 'qb'
  const [searchTerm, setSearchTerm] = useState('');

  const [loadingQs, setLoadingQs] = useState(false);
  const [qStatus, setQStatus] = useState(null);
  const [testsUsed, setTestsUsed] = useState([]);
  const [questions, setQuestions] = useState([]);
  // { type: 'test'|'qb', items: [...] } when a search matched more than one
  // test/QB — shown as a picker so the user selects the exact one instead of
  // us guessing or silently pooling everything together.
  const [candidates, setCandidates] = useState(null);

  // id -> { code, loading, error, pushed, pushError, copied, language }
  const [gen, setGen] = useState({});
  // id -> language currently selected in that question's own dropdown
  const [pushLangByQ, setPushLangByQ] = useState({});
  // id -> which existing solution's language is currently shown in the
  // "Existing" viewer (defaults to the best one, but you can view any)
  const [viewLangByQ, setViewLangByQ] = useState({});
  // id -> true for questions checked for the bulk "Update selected" action
  const [selectedIds, setSelectedIds] = useState({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null); // { done, total }
  const [bulkLanguage, setBulkLanguage] = useState(LANGUAGES[0]);

  // ── "Set Best Language" mode — a separate, lighter-weight feature from
  // generating new solutions above: given a test/QB (same search), just
  // re-flag which ALREADY-EXISTING language's solution is the portal's
  // "Best Solution" for each question. No AI, no code execution — it just
  // re-pushes that language's own existing code/header/footer/codeStub
  // completely unchanged, which is what actually flips the best flag on
  // the portal (confirmed: pushing any language marks it best and clears
  // every other language's flag — see pushFor below). A question that
  // doesn't already have a solution in the requested language is skipped
  // and clearly reported, never invented.
  const [mode, setMode] = useState('generate'); // 'generate' | 'best'
  const [bestLanguage, setBestLanguage] = useState(LANGUAGES[0]);
  // id -> { status: 'working'|'done'|'skipped'|'error', reason? }
  const [bestResults, setBestResults] = useState({});
  const [bestPerQLang, setBestPerQLang] = useState({}); // id -> language picked in that row's own dropdown
  const [bestBulkRunning, setBestBulkRunning] = useState(false);
  const [bestBulkProgress, setBestBulkProgress] = useState(null);
  const bestBulkStopRequestedRef = useRef(false);

  const abortControllersRef = useRef({});
  const bulkAbortControllerRef = useRef(null);
  const bulkStopRequestedRef = useRef(false);

  function isAbortError(err) {
    return err && (err.name === 'CanceledError' || err.code === 'ERR_CANCELED' || err.message === 'canceled');
  }

  function languageFor(q) {
    return pushLangByQ[q.id] || LANGUAGES[0];
  }

  function toggleSelected(id) {
    setSelectedIds(prev => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleSelectAll() {
    const selectableIds = questions.filter(q => bestSolutionOf(q).code && !q.qbUnresolved).map(q => q.id);
    const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds[id]);
    const next = {};
    if (!allSelected) {
      selectableIds.forEach(id => { next[id] = true; });
      setPushLangByQ(prev => {
        const langNext = { ...prev };
        selectableIds.forEach(id => { langNext[id] = bulkLanguage; });
        return langNext;
      });
    }
    setSelectedIds(next);
  }

  function resetForLoad() {
    setQStatus(null);
    setQuestions([]);
    setTestsUsed([]);
    setGen({});
    setPushLangByQ({});
    setCandidates(null);
    setBestResults({});
    setBestPerQLang({});
    setSelectedIds({});
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

  // Either a test name OR a QB name works — whichever you actually have on
  // hand. Searches first (every match, not auto-resolved to one) — a single
  // match loads straight away; more than one shows a picker.
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

  // Runs code against the question's real test cases; on failure, asks Groq
  // to fix it using the ACTUAL demonstrated expected-vs-actual mismatch, then
  // re-tests — up to MAX_FIX_ATTEMPTS times.
  async function verifyAndFix(q, initialCode, language, snippet, signal) {
    const cases = testCasesOf(q);
    if (!cases.length) {
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], runError: 'No test cases found on this question — cannot verify automatically.' } }));
      return { passed: true, unverifiable: true, code: initialCode };
    }

    const header = snippet && snippet.header ? snippet.header : '';
    const footer = snippet && snippet.footer ? snippet.footer : '';
    const fullOf = mid => (header ? header + '\n\n' : '') + mid + (footer ? '\n\n' + footer : '');

    let code = initialCode;
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: true, runError: null, fixAttempt: attempt } }));
      let rr;
      try {
        rr = await runTests(language, fullOf(code), cases, signal);
      } catch (err) {
        if (isAbortError(err)) { setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, stopped: true } })); return { passed: false, code, stopped: true }; }
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, runError: err.response?.data?.error || err.message } }));
        return { passed: false, code };
      }

      var failures;
      if (rr.compileError) {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, runResult: null, runError: 'Compile error: ' + rr.compileError } }));
        if (attempt >= MAX_FIX_ATTEMPTS) return { passed: false, code };
        failures = [{ input: '(compiling)', expected: 'compiles successfully', actual: rr.compileError, label: 'Compile error' }];
      } else {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, runResult: rr, runError: null } }));
        if (rr.allPassed) return { passed: true, code };
        if (attempt >= MAX_FIX_ATTEMPTS) return { passed: false, code };
        failures = rr.results.filter(r => !r.passed).map(r => ({
          input: cases[r.index] ? cases[r.index].input : '',
          expected: r.expected, actual: r.actual != null ? r.actual : r.error, label: r.label
        }));
      }

      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: true } }));
      let fixRes;
      try {
        fixRes = await fixSolution({ code, language, question_text: q.title, failures, header, footer }, signal);
      } catch (err) {
        if (isAbortError(err)) { setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: false, stopped: true } })); return { passed: false, code, stopped: true }; }
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: false, runError: err.response?.data?.error || err.message } }));
        return { passed: false, code };
      }
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: false } }));
      if (!fixRes.ok) {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], runError: fixRes.error || 'Fix attempt failed' } }));
        return { passed: false, code };
      }
      code = fixRes.code;
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], code } }));
    }
    return { passed: false, code };
  }

  async function generateFor(q, languageOverride, externalSignal) {
    const best = bestSolutionOf(q);
    const targetLanguage = languageOverride || languageFor(q);
    const ownController = externalSignal ? null : new AbortController();
    if (ownController) abortControllersRef.current[q.id] = ownController;
    const signal = externalSignal || (ownController && ownController.signal);
    setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], loading: true, error: null, stopped: false, pushed: false, pushError: null, runResult: null, runError: null, fixAttempt: 0 } }));
    try {
      if (sameJavaFamily(best.language, targetLanguage)) {
        setGen(prev => ({ ...prev, [q.id]: {
          ...prev[q.id], code: best.code, language: targetLanguage, loading: false, error: null,
          hasSnippet: best.hasSnippet, header: best.header, footer: best.footer, codeStub: best.codeStub
        } }));
        const snippet = (best.header || best.footer) ? { header: best.header, footer: best.footer } : undefined;
        const result = await verifyAndFix(q, best.code, targetLanguage, snippet, signal);
        return { ...result, language: targetLanguage, hasSnippet: best.hasSnippet, header: best.header, footer: best.footer, codeStub: best.codeStub };
      }

      const usesSnippetFields = !!(best.header || best.footer || best.codeStub);
      if (usesSnippetFields) {
        const fromLanguage = best.language || 'the original language';
        const solRes = await translateSolution({
          code: best.code || '', fromLanguage, toLanguage: targetLanguage, question_text: q.title
        }, signal);
        if (!solRes.ok) throw new Error(solRes.error || 'Translation failed');

        const headerRes = best.header
          ? await translateFragment({ code: best.header, fromLanguage, toLanguage: targetLanguage, kind: 'header' }, signal)
          : { ok: true, code: '' };
        if (!headerRes.ok) throw new Error(headerRes.error || 'Header translation failed');

        const footerRes = best.footer
          ? await translateFragment({ code: best.footer, fromLanguage, toLanguage: targetLanguage, kind: 'footer' }, signal)
          : { ok: true, code: '' };
        if (!footerRes.ok) throw new Error(footerRes.error || 'Footer translation failed');

        const stubRes = best.codeStub
          ? await translateStub({
              codeStub: best.codeStub, originalSolution: best.code || '', translatedSolution: solRes.code,
              fromLanguage, toLanguage: targetLanguage, question_text: q.title
            }, signal)
          : { ok: true, code: '' };
        if (!stubRes.ok) throw new Error(stubRes.error || 'Code stub translation failed');

        setGen(prev => ({ ...prev, [q.id]: {
          ...prev[q.id], code: solRes.code, language: targetLanguage, loading: false, error: null,
          hasSnippet: best.hasSnippet, header: headerRes.code, footer: footerRes.code, codeStub: stubRes.code
        } }));
        const result = await verifyAndFix(q, solRes.code, targetLanguage, { header: headerRes.code, footer: footerRes.code }, signal);
        return { ...result, language: targetLanguage, hasSnippet: best.hasSnippet, header: headerRes.code, footer: footerRes.code, codeStub: stubRes.code };
      }
      const res = await translateSolution({
        code: best.code || '',
        fromLanguage: best.language || 'the original language',
        toLanguage: targetLanguage,
        question_text: q.title
      }, signal);
      if (!res.ok) throw new Error(res.error || 'Translation failed');
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], code: res.code, language: targetLanguage, loading: false, error: null, hasSnippet: false, header: '', footer: '', codeStub: '' } }));
      const result = await verifyAndFix(q, res.code, targetLanguage, undefined, signal);
      return { ...result, language: targetLanguage, hasSnippet: false };
    } catch (err) {
      if (isAbortError(err)) {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], loading: false, stopped: true } }));
        return { passed: false, stopped: true };
      }
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], loading: false, error: err.response?.data?.error || err.message } }));
      return { passed: false };
    } finally {
      if (ownController) delete abortControllersRef.current[q.id];
    }
  }

  function stopFor(q) {
    var controller = abortControllersRef.current[q.id];
    if (controller) controller.abort();
  }

  async function generateAll() {
    const targets = questions.filter(q => bestSolutionOf(q).code);
    if (!targets.length) return;

    bulkStopRequestedRef.current = false;
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (bulkStopRequestedRef.current) break;
      const q = targets[i];
      const controller = new AbortController();
      bulkAbortControllerRef.current = controller;
      await generateFor(q, undefined, controller.signal);
      bulkAbortControllerRef.current = null;
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkRunning(false);
    bulkStopRequestedRef.current = false;
  }

  function stopBulk() {
    bulkStopRequestedRef.current = true;
    if (bulkAbortControllerRef.current) bulkAbortControllerRef.current.abort();
  }

  async function updateSelected() {
    const ids = Object.keys(selectedIds).filter(id => selectedIds[id]);
    const targets = questions.filter(q => ids.includes(String(q.id)) && bestSolutionOf(q).code && !q.qbUnresolved);
    if (!targets.length) return;

    bulkStopRequestedRef.current = false;
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (bulkStopRequestedRef.current) break;
      const q = targets[i];
      setPushLangByQ(prev => ({ ...prev, [q.id]: bulkLanguage }));
      const controller = new AbortController();
      bulkAbortControllerRef.current = controller;
      const result = await generateFor(q, bulkLanguage, controller.signal);
      bulkAbortControllerRef.current = null;
      if (bulkStopRequestedRef.current) { setBulkProgress({ done: i + 1, total: targets.length }); break; }
      if (result.passed) {
        await pushFor(q, {
          code: result.code, language: result.language,
          hasSnippet: result.hasSnippet, header: result.header, footer: result.footer, codeStub: result.codeStub
        });
      }
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkRunning(false);
    bulkStopRequestedRef.current = false;
  }

  function editCode(id, code) {
    setGen(prev => ({ ...prev, [id]: { ...prev[id], code, runResult: null, runError: null } }));
  }

  async function runTestsFor(q) {
    const entry = gen[q.id];
    if (!entry?.code) return;
    const language = entry.language || languageFor(q);
    const snippet = (entry.header || entry.footer) ? { header: entry.header, footer: entry.footer } : undefined;
    const controller = new AbortController();
    abortControllersRef.current[q.id] = controller;
    setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], stopped: false } }));
    try {
      await verifyAndFix(q, entry.code, language, snippet, controller.signal);
    } finally {
      delete abortControllersRef.current[q.id];
    }
  }

  async function copyFor(q) {
    const entry = gen[q.id];
    if (!entry?.code) return;
    try {
      await navigator.clipboard.writeText(entry.code);
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], copied: true } }));
      setTimeout(() => setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], copied: false } })), 2000);
    } catch (err) {
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], error: 'Could not copy — select the text in the box above and copy it manually.' } }));
    }
  }

  async function pushFor(q, override) {
    const entry = override || gen[q.id];
    if (!entry?.code) return false;
    const pushLanguage = entry.language || languageFor(q);
    const hasSnippetContent = !!(entry.header || entry.footer || entry.codeStub);
    const snippetExtra = hasSnippetContent
      ? { snippet: { hasSnippet: !!entry.hasSnippet, header: entry.header || '', footer: entry.footer || '', codeStub: entry.codeStub || '' } }
      : { snippet: { hasSnippet: false } };
    setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], pushing: true, pushError: null } }));
    try {
      await pushSolution(token, q.id, pushLanguage, entry.code, {
        qbId: q.qbId,
        rawQuestion: q,
        ...snippetExtra
      });
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], pushing: false, pushed: true } }));
      setQuestions(prevQs => prevQs.map(item => {
        if (item.id !== q.id) return item;
        const pq = item.programming_question || {};
        const rawSolutionArr = Array.isArray(pq.solution) ? pq.solution : [];
        const solutionArr = rawSolutionArr.map(s => ({
          ...s,
          solutiondata: Array.isArray(s.solutiondata) ? s.solutiondata.map(sd => ({ ...sd, solutionbest: false })) : s.solutiondata
        }));
        const sIdx = solutionArr.findIndex(s => String(s.language).toLowerCase() === String(pushLanguage).toLowerCase());
        const prevEntry = sIdx !== -1 ? solutionArr[sIdx] : null;
        const newSolEntry = hasSnippetContent
          ? {
              language: pushLanguage, hasSnippet: !!entry.hasSnippet,
              header: entry.header || (prevEntry && prevEntry.header) || '',
              footer: entry.footer || (prevEntry && prevEntry.footer) || '',
              codeStub: entry.codeStub || (prevEntry && prevEntry.codeStub) || '',
              solutiondata: [{ solution: entry.code, solutionExp: null, solutionbest: true, isSolutionExp: false, solutionDebug: null }],
              hideHeader: prevEntry ? !!prevEntry.hideHeader : false, hideFooter: prevEntry ? !!prevEntry.hideFooter : false
            }
          : {
              language: pushLanguage, codeStub: '', hasSnippet: false,
              solutiondata: [{ solution: entry.code, solutionExp: null, solutionbest: true, isSolutionExp: false, solutionDebug: null }],
              hideHeader: false, hideFooter: false
            };
        if (sIdx === -1) solutionArr.push(newSolEntry);
        else solutionArr[sIdx] = { ...solutionArr[sIdx], ...newSolEntry };

        const newMultilang = Array.isArray(item.multilanguage) ? item.multilanguage.slice() : [];
        if (!newMultilang.some(l => String(l).toLowerCase() === String(pushLanguage).toLowerCase())) newMultilang.push(pushLanguage);

        return {
          ...item,
          multilanguage: newMultilang,
          programming_question: { ...pq, solution: solutionArr, multilanguage: newMultilang }
        };
      }));
      return true;
    } catch (err) {
      setGen(prev => ({
        ...prev,
        [q.id]: {
          ...prev[q.id], pushing: false,
          pushError: err.response?.data?.error || err.message
        }
      }));
      return false;
    }
  }

  // ── "Set Best Language" processing ────────────────────────────────────────
  // Re-pushes an ALREADY-EXISTING language's solution for `q`, completely
  // unchanged, purely to flip which one the portal marks "Best Solution" —
  // reuses pushFor as-is (the same function the generate flow above uses),
  // just with an override built from the existing solution instead of a
  // freshly-generated one. If this question has no solution in `language` at
  // all, nothing is pushed — it's reported as skipped, never invented.
  function bestLanguageFor(q) {
    return bestPerQLang[q.id] || bestSolutionOf(q).language || LANGUAGES[0];
  }

  async function setBestFor(q, language) {
    const existing = allSolutionsOf(q).find(s => s.language === language);
    if (!existing) {
      setBestResults(prev => ({ ...prev, [q.id]: { status: 'skipped', reason: `No existing ${language} solution on this question — nothing to set as best.` } }));
      return { ok: false, skipped: true };
    }
    setBestResults(prev => ({ ...prev, [q.id]: { status: 'working' } }));
    const ok = await pushFor(q, {
      code: existing.code, language,
      hasSnippet: existing.hasSnippet, header: existing.header, footer: existing.footer, codeStub: existing.codeStub
    });
    setBestResults(prev => ({ ...prev, [q.id]: ok ? { status: 'done' } : { status: 'error', reason: gen[q.id]?.pushError || 'Push failed.' } }));
    return { ok };
  }

  async function setBestForSelected() {
    const ids = Object.keys(selectedIds).filter(id => selectedIds[id]);
    const targets = questions.filter(q => ids.includes(String(q.id)) && !q.qbUnresolved);
    if (!targets.length) return;

    bestBulkStopRequestedRef.current = false;
    setBestBulkRunning(true);
    setBestBulkProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (bestBulkStopRequestedRef.current) break;
      await setBestFor(targets[i], bestLanguage);
      setBestBulkProgress({ done: i + 1, total: targets.length });
    }
    setBestBulkRunning(false);
    bestBulkStopRequestedRef.current = false;
  }

  function stopBestBulk() {
    bestBulkStopRequestedRef.current = true;
  }

  const readyToPush = questions.filter(q => gen[q.id]?.code && !gen[q.id]?.pushed);
  const bestSkippedCount = Object.values(bestResults).filter(r => r.status === 'skipped').length;
  const bestDoneCount = Object.values(bestResults).filter(r => r.status === 'done').length;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold mb-0.5 flex items-center gap-2">
          <Hammer size={22} className="text-accent-pill" /> Solution Manager
        </h1>
        <p className="text-sm text-muted">
          {mode === 'generate'
            ? 'Give either a test name or a QB name — whichever you have. Every question that already has a solution gets a new one generated in whatever language you pick per question, for you to review before pushing.'
            : 'Give either a test name or a QB name, then pick which already-existing language should become the portal\'s "Best Solution" for each question — no generation, no code changes, just re-flagging. Questions that don\'t already have a solution in that language are skipped and reported, never invented.'}
        </p>
        <div className="flex rounded-lg border border-theme overflow-hidden w-fit mt-2">
          {[
            { id: 'generate', label: 'Generate solutions' },
            { id: 'best', label: 'Set best language' }
          ].map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`px-3 py-1.5 text-xs font-semibold transition ${
                mode === m.id ? 'bg-accent-pill text-accent-pill' : 'text-muted bg-panel-hover'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
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
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={questions.some(q => bestSolutionOf(q).code && !q.qbUnresolved) && questions.filter(q => bestSolutionOf(q).code && !q.qbUnresolved).every(q => selectedIds[q.id])}
                  onChange={toggleSelectAll}
                  disabled={bulkRunning || bestBulkRunning}
                />
                Select all
              </label>
              {mode === 'generate' ? (
                <>
                  <button onClick={generateAll} disabled={bulkRunning} className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-40">
                    ⚡ Generate all
                  </button>
                  <select
                    value={bulkLanguage}
                    onChange={ev => {
                      const lang = ev.target.value;
                      setBulkLanguage(lang);
                      setPushLangByQ(prev => {
                        const next = { ...prev };
                        Object.keys(selectedIds).forEach(id => { if (selectedIds[id]) next[id] = lang; });
                        return next;
                      });
                    }}
                    disabled={bulkRunning}
                    className="input text-xs w-auto"
                    title="Language applied to every selected question"
                  >
                    {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <button
                    onClick={updateSelected}
                    disabled={bulkRunning || !Object.values(selectedIds).some(Boolean)}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-green-600 hover:opacity-90 disabled:opacity-40"
                  >
                    {bulkRunning
                      ? `Updating ${bulkProgress ? bulkProgress.done : 0}/${bulkProgress ? bulkProgress.total : 0}...`
                      : `🚀 Update selected (${Object.values(selectedIds).filter(Boolean).length})`}
                  </button>
                  {bulkRunning && (
                    <button onClick={stopBulk} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30">
                      <StopCircle size={13} /> Stop
                    </button>
                  )}
                </>
              ) : (
                <>
                  <select
                    value={bestLanguage}
                    onChange={ev => setBestLanguage(ev.target.value)}
                    disabled={bestBulkRunning}
                    className="input text-xs w-auto"
                    title="The language to make 'Best Solution' for every selected question that has it"
                  >
                    {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <button
                    onClick={setBestForSelected}
                    disabled={bestBulkRunning || !Object.values(selectedIds).some(Boolean)}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-green-600 hover:opacity-90 disabled:opacity-40"
                  >
                    {bestBulkRunning
                      ? `Setting ${bestBulkProgress ? bestBulkProgress.done : 0}/${bestBulkProgress ? bestBulkProgress.total : 0}...`
                      : `⭐ Set best for selected (${Object.values(selectedIds).filter(Boolean).length})`}
                  </button>
                  {bestBulkRunning && (
                    <button onClick={stopBestBulk} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30">
                      <StopCircle size={13} /> Stop
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {bulkRunning && mode === 'generate' && (
            <StatusMsg loading>
              Running one question at a time — generate, verify, auto-fix, push ({bulkProgress?.done || 0}/{bulkProgress?.total || 0} done)...
            </StatusMsg>
          )}
          {bestBulkRunning && mode === 'best' && (
            <StatusMsg loading>
              Re-pushing one question at a time ({bestBulkProgress?.done || 0}/{bestBulkProgress?.total || 0} done)...
            </StatusMsg>
          )}
          {!bestBulkRunning && mode === 'best' && (bestDoneCount > 0 || bestSkippedCount > 0) && (
            <StatusMsg type={bestSkippedCount > 0 ? 'warn' : 'ok'}>
              {bestDoneCount} question(s) set to {bestLanguage} as best.
              {bestSkippedCount > 0 && ` ${bestSkippedCount} skipped — no existing ${bestLanguage} solution on those (see below).`}
            </StatusMsg>
          )}

          <div className="flex flex-col gap-3">
            {questions.map((q, qIdx) => {
              const e = gen[q.id] || {};
              const best = bestSolutionOf(q);
              const targetLanguage = languageFor(q);
              const allSols = allSolutionsOf(q);
              const viewLang = viewLangByQ[q.id] || best.language;
              const viewing = allSols.find(s => s.language === viewLang) || best;
              const languageMismatch = !!(e.code && e.language && e.language !== targetLanguage);
              const canVerify = testCasesOf(q).length > 0;
              const verified = !canVerify || (e.runResult && e.runResult.allPassed);
              const busy = e.loading || e.running || e.fixing;

              return (
                <div key={q.id} className="rounded-lg border border-theme bg-panel-hover p-3">
                  <div className="flex items-start gap-2.5 mb-1">
                    {best.code && !q.qbUnresolved && (
                      <input
                        type="checkbox"
                        checked={!!selectedIds[q.id]}
                        onChange={() => toggleSelected(q.id)}
                        disabled={bulkRunning || bestBulkRunning}
                        className="mt-1"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-mono text-muted2">Q{qIdx + 1}</span>
                        <span className="text-sm text-body-app">{q.title}</span>
                      </div>
                      <p className="text-xs text-muted2 mt-1">
                        {q.qbUnresolved ? 'QB unknown' : q.qbName} · Already has solutions in: {allSols.length ? allSols.map(s => s.language + (s.best ? ' (best)' : '')).join(', ') : 'none'}
                        {!best.code && ' — no solution code found on this question'}
                        {(viewing.header || viewing.footer || viewing.codeStub) && ' · Has a header/footer/code-stub — kept exactly as-is on every push'}
                      </p>
                    </div>
                  </div>

                  {mode === 'generate' ? (
                  <>
                  {best.code && (
                    <div className="grid sm:grid-cols-2 gap-3 mt-2">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[11px] font-semibold text-muted">Existing solution ({viewing.language || 'Unknown'}{viewing.best ? ' — best' : ''})</span>
                          {allSols.length > 1 && (
                            <select
                              value={viewLang || ''}
                              onChange={ev => setViewLangByQ(prev => ({ ...prev, [q.id]: ev.target.value }))}
                              className="input text-xs w-auto ml-auto py-0.5"
                            >
                              {allSols.map(s => <option key={s.language} value={s.language}>{s.language}{s.best ? ' (best)' : ''}</option>)}
                            </select>
                          )}
                        </div>
                        <pre className="text-[11px] leading-[1.5] bg-black/40 border border-theme rounded-lg p-2.5 h-[140px] overflow-auto whitespace-pre font-mono">{viewing.code || ''}</pre>
                        {(viewing.header || viewing.codeStub || viewing.footer) && (
                          <div className="rounded-lg border border-theme bg-panel p-2.5 mt-2">
                            <p className="text-[11px] text-muted2 mb-1.5">
                              This solution also has a header/code-stub/footer on the portal — shown in the same order as the portal, carried forward exactly as-is on every push, never regenerated.
                            </p>
                            {viewing.header && <SnippetBlock label="Header" code={viewing.header} />}
                            {viewing.codeStub && <SnippetBlock label="Code stub (shown to students)" code={viewing.codeStub} />}
                            {viewing.footer && <SnippetBlock label="Footer" code={viewing.footer} />}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[11px] font-semibold text-muted">Generated ({e.code ? (e.language || targetLanguage) : targetLanguage})</span>
                          <select
                            value={targetLanguage}
                            onChange={ev => setPushLangByQ(prev => ({ ...prev, [q.id]: ev.target.value }))}
                            className="input text-xs w-auto ml-auto py-0.5"
                          >
                            {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                          </select>
                        </div>
                        <textarea
                          className="input font-mono text-[11px] leading-[1.5]"
                          style={{ height: '140px' }}
                          value={e.code || ''}
                          placeholder="Choose a language above, then click Generate..."
                          onChange={ev => editCode(q.id, ev.target.value)}
                        />
                        {(e.header || e.codeStub || e.footer) && (
                          <div className="rounded-lg border border-theme bg-panel p-2.5 mt-2">
                            <p className="text-[11px] text-muted2 mb-1.5">
                              Translated into {e.language || targetLanguage} along with the solution — shown in the same order as the portal.
                            </p>
                            {e.header && <SnippetBlock label="Header" code={e.header} />}
                            {e.codeStub && <SnippetBlock label="Code stub (shown to students)" code={e.codeStub} />}
                            {e.footer && <SnippetBlock label="Footer" code={e.footer} />}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {languageMismatch && (
                    <StatusMsg type="warn">
                      This code was generated in {e.language}, but the dropdown is now set to {targetLanguage} —
                      Run tests / Push are disabled until you click Generate again for {targetLanguage}.
                    </StatusMsg>
                  )}
                  {e.error && <StatusMsg type="err">{e.error}</StatusMsg>}
                  {e.fixing && (
                    <StatusMsg loading>
                      Test case(s) failed — asking the AI to fix it using the actual failure (attempt {(e.fixAttempt || 0) + 1}/{MAX_FIX_ATTEMPTS + 1})...
                    </StatusMsg>
                  )}
                  {e.runError && <StatusMsg type="err">{e.runError}</StatusMsg>}
                  {e.runResult && !e.fixing && (
                    <StatusMsg type={e.runResult.allPassed ? 'ok' : 'warn'}>
                      {e.runResult.passedCount}/{e.runResult.totalCount} test case(s) passed
                      {!e.runResult.allPassed && (
                        <span className="block mt-1.5 flex flex-col gap-1">
                          {e.runResult.results.filter(r => !r.passed).map(r => (
                            <span key={r.index} className="block text-[11px] font-mono whitespace-pre-wrap">
                              ✗ {r.label || `Case ${r.index + 1}`}{r.error ? `: ${r.error}` : (
                                `\n  expected: ${JSON.stringify(r.expected)}\n  actual:   ${JSON.stringify(r.actual)}`
                              )}
                            </span>
                          ))}
                          {(e.fixAttempt || 0) >= MAX_FIX_ATTEMPTS && (
                            <span className="block text-[11px] text-amber-300/90 mt-1">Still failing after {MAX_FIX_ATTEMPTS} automatic fix attempt(s) — Push stays disabled. Edit the code manually and Run tests again, or try Generate once more.</span>
                          )}
                        </span>
                      )}
                    </StatusMsg>
                  )}
                  {e.code && canVerify && !verified && !e.fixing && !e.runResult && (
                    <StatusMsg type="warn">Not verified yet — click Run tests before pushing.</StatusMsg>
                  )}
                  {e.pushError && <StatusMsg type="err">{e.pushError}</StatusMsg>}
                  {e.pushed && <StatusMsg type="ok">Pushed to the portal.</StatusMsg>}
                  {e.stopped && <StatusMsg type="warn">Stopped.</StatusMsg>}
                  {q.qbUnresolved && (
                    <StatusMsg type="warn">
                      Couldn't determine which QB this question lives in, so it's shown for review/generation only —
                      pushing is disabled here (missing subject/topic metadata would risk clearing those on the portal).
                      Find and push it via its QB name instead once you know it.
                    </StatusMsg>
                  )}

                  {best.code && (
                    <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
                      {busy ? (
                        <button onClick={bulkRunning ? stopBulk : () => stopFor(q)} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30">
                          <StopCircle size={12} /> Stop
                        </button>
                      ) : (
                        <button onClick={() => generateFor(q)} disabled={bulkRunning} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-indigo-500/80 hover:bg-indigo-500 disabled:opacity-40">
                          <Hammer size={12} /> Generate
                        </button>
                      )}
                      {busy && (
                        <span className="text-xs text-muted2 flex items-center gap-1">
                          <Loader2 size={11} className="animate-spin" /> {e.loading ? 'Generating...' : e.fixing ? 'Fixing...' : 'Running...'}
                        </span>
                      )}
                      <button onClick={() => copyFor(q)} disabled={!e.code} className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-40">
                        <Copy size={12} /> {e.copied ? 'Copied' : 'Copy code'}
                      </button>
                      <button onClick={() => runTestsFor(q)} disabled={!e.code || busy || languageMismatch || bulkRunning} className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-panel bg-panel-hover text-muted disabled:opacity-40">
                        <PlayCircle size={12} /> Run tests
                      </button>
                      <button onClick={() => pushFor(q)} disabled={!e.code || e.pushing || e.pushed || languageMismatch || busy || !verified || bulkRunning || q.qbUnresolved} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 disabled:opacity-40">
                        <UploadCloud size={12} /> {e.pushing ? 'Pushing...' : e.pushed ? 'Pushed' : 'Push this one'}
                      </button>
                    </div>
                  )}
                  </>
                  ) : (
                    <BestLanguageRow
                      allSols={allSols}
                      language={bestLanguageFor(q)}
                      onLanguageChange={lang => setBestPerQLang(prev => ({ ...prev, [q.id]: lang }))}
                      result={bestResults[q.id]}
                      onSetBest={() => setBestFor(q, bestLanguageFor(q))}
                      busy={bestBulkRunning}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {readyToPush.length > 0 && (
            <StatusMsg type="info">
              {readyToPush.length} question(s) have a generated solution ready but not yet pushed — push each one above
              (pushes are one at a time and hit your live portal, so there's no bulk-push button here on purpose).{' '}
              <button
                disabled={bulkRunning}
                onClick={() => setSelectedIds(Object.fromEntries(readyToPush.map(q => [q.id, true])))}
                className="text-xs font-semibold px-2 py-1 rounded-lg bg-panel bg-panel-hover text-muted underline"
                title="Check exactly these questions below, so Update selected only retries them instead of all of them"
              >
                Select these {readyToPush.length}
              </button>
            </StatusMsg>
          )}
        </div>
      )}
    </motion.div>
  );
}

function SnippetBlock({ label, code }) {
  return (
    <div className="mb-1.5">
      <div className="text-[10px] font-semibold text-muted2 mb-0.5">{label}</div>
      <pre className="text-[10px] leading-[1.5] bg-black/40 border border-theme rounded-lg p-2 max-h-[70px] overflow-auto whitespace-pre font-mono">{code}</pre>
    </div>
  );
}

// "Set Best Language" mode's per-question row — deliberately much lighter
// than the generate-mode card above: a language picker (marked when this
// question doesn't actually have that language, so the outcome is obvious
// before even clicking) and one button. No code view, nothing to edit —
// this mode never touches the code itself, only which existing language is
// flagged best.
function BestLanguageRow({ allSols, language, onLanguageChange, result, onSetBest, busy }) {
  const hasLanguage = allSols.some(s => s.language === language);
  const working = result?.status === 'working';
  return (
    <div className="flex items-center gap-2 flex-wrap mt-1">
      <select
        value={language}
        onChange={ev => onLanguageChange(ev.target.value)}
        disabled={busy || working}
        className="input text-xs w-auto py-1"
      >
        {LANGUAGES.map(l => (
          <option key={l} value={l}>{l}{allSols.some(s => s.language === l) ? '' : ' (no existing solution)'}</option>
        ))}
      </select>
      <button
        onClick={onSetBest}
        disabled={busy || working || !hasLanguage}
        title={!hasLanguage ? `This question has no existing ${language} solution to set as best.` : undefined}
        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 disabled:opacity-40"
      >
        {working ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
        {working ? 'Setting...' : 'Set as best'}
      </button>
      {result?.status === 'done' && <StatusMsg type="ok">Set — {language} is now the best solution.</StatusMsg>}
      {result?.status === 'skipped' && <StatusMsg type="warn">{result.reason}</StatusMsg>}
      {result?.status === 'error' && <StatusMsg type="err">{result.reason}</StatusMsg>}
    </div>
  );
}
