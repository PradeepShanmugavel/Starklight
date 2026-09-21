import { api } from './api'
import { stripHtml, bestSolutionOf, testCasesOf, getCodeConstraints } from './helpers'

// How many automatic fix-and-retest rounds after the first generate. Each
// round feeds the REAL demonstrated failure (compiler output, or the actual
// expected-vs-actual mismatch from running it) back to the model — never a
// guess. If it still isn't passing after this, we stop and report the last
// failure rather than handing back code that was never verified.
export const MAX_FIX_ATTEMPTS = 3

// How many times to throw the whole attempt away and generate a fresh one
// after those fixes are exhausted. Patching a single bad attempt repeatedly
// tends to converge on nothing — once the model has committed to a wrong
// approach, three more patches usually just shuffle it. Starting over, while
// telling the model what already failed, is far more likely to land.
//
// Total worst case per language: (1 + MAX_RESTARTS) generations, each with up
// to MAX_FIX_ATTEMPTS fixes.
export const MAX_RESTARTS = 2

/**
 * Generates a solution for `question` in `language`, verifies it by actually
 * running it, and self-corrects on failure.
 *
 * onProgress({ phase, attempt, passedCount, totalCount, note }) is called at
 * each stage so the UI can narrate what's happening.
 *
 * Resolves to:
 *   { ok: true,  code, language, results, attempts, snippet }  — verified passing
 *   { ok: false, code, language, results, compileError, attempts, reason }
 * `ok: false` always means it did NOT pass; the code is returned anyway so it
 * can be inspected or hand-edited, but callers must not treat it as verified.
 */
// AbortController rejects with a DOMException named "AbortError" (fetch) or,
// depending on the browser, a plain Error with that same name — checked by
// name rather than instanceof so both shapes match.
function isAbortError(err) {
  return !!err && err.name === 'AbortError'
}

export async function forgeSolution({ token, question, language, onProgress = () => {}, signal }) {
  const testcases = testCasesOf(question)
  if (!testcases.length) {
    return { ok: false, reason: 'This question has no sample or hidden test cases to verify against.', attempts: 0 }
  }

  const ref = bestSolutionOf(question)
  const pq = question.programming_question || {}
  const context = {
    question_text: stripHtml(question.question_data || ''),
    input_format: stripHtml(pq.input_format || ''),
    output_format: stripHtml(pq.output_format || ''),
    constraints: getCodeConstraints(question)
  }

  // A short, human-readable account of how an attempt failed. Fed back into
  // the next FRESH generation so it doesn't walk into the same wall.
  function describeFailure(run) {
    if (!run) return '(no run captured)'
    if (run.compileError) return 'It did not compile:\n' + String(run.compileError).slice(0, 1200)
    const bad = (run.results || []).filter(r => !r.passed).slice(0, 3)
    if (!bad.length) return '(failed without detail)'
    return `${run.passedCount || 0}/${run.totalCount || testcases.length} test cases passed. Examples:\n` +
      bad.map(r =>
        `  input: ${JSON.stringify(testcases[r.index]?.input ?? '')}\n` +
        `  expected: ${JSON.stringify(r.expected)}\n` +
        `  actual: ${JSON.stringify(r.actual)}` + (r.error ? `\n  error: ${r.error}` : '')
      ).join('\n')
  }

  let code = null
  let lastRun = null
  let totalAttempts = 0

  // Outer loop: each pass is a completely fresh solution. Inner loop patches
  // that solution against real measured failures.
  for (let restart = 0; restart <= MAX_RESTARTS; restart++) {
    if (signal?.aborted) return { ok: false, code, language, attempts: totalAttempts, reason: 'Stopped.', stopped: true }
    onProgress({ phase: 'generating', attempt: 0, restart })

    try {
      const gen = await api.translateSolution(token, {
        target_language: language,
        reference_code: ref.code,
        reference_language: ref.language,
        testcases,
        // Only present from the second pass onward — see the retry block in
        // /api/translate-solution.
        ...(restart > 0 ? { previous_attempt: code, previous_failure: describeFailure(lastRun) } : {}),
        ...context
      }, signal)
      code = gen.code
    } catch (err) {
      if (isAbortError(err)) return { ok: false, code, language, attempts: totalAttempts, reason: 'Stopped.', stopped: true }
      if (restart === MAX_RESTARTS) {
        return { ok: false, code, language, attempts: totalAttempts, reason: 'Could not generate a solution: ' + err.message }
      }
      continue // transient AI failure — try a fresh generation
    }
    if (!code) {
      if (restart === MAX_RESTARTS) return { ok: false, language, attempts: totalAttempts, reason: 'The model returned no code.' }
      continue
    }

    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      if (signal?.aborted) return { ok: false, code, language, attempts: totalAttempts, reason: 'Stopped.', stopped: true }
      onProgress({ phase: 'running', attempt, restart })

      let run
      try {
        run = await api.runTests({ language, code, testcases }, signal)
      } catch (err) {
        if (isAbortError(err)) return { ok: false, code, language, attempts: totalAttempts, reason: 'Stopped.', stopped: true }
        return { ok: false, code, language, attempts: totalAttempts, reason: 'Could not run the tests locally: ' + err.message }
      }
      lastRun = run
      totalAttempts++

      // A missing compiler is an environment problem, not a code problem —
      // no amount of regenerating can fix it, so stop immediately. This must
      // stay OUTSIDE the retry logic or a missing toolchain would burn every
      // restart as well as every fix.
      if (run.missingTool) {
        return {
          ok: false, code, language, attempts: totalAttempts, compileError: run.compileError,
          reason: `${language} can't be run here — ${run.missingTool} isn't installed or isn't on PATH. ` +
                  `Install it (or set EXTRA_TOOLCHAIN_PATHS) and try again.`,
          environmentProblem: true
        }
      }

      if (run.ok && run.allPassed) {
        onProgress({ phase: 'passed', attempt, restart, passedCount: run.passedCount, totalCount: run.totalCount })
        // Port any snippet fragments only if the reference genuinely had them —
        // a plain question must never have header/footer/codeStub invented.
        const snippet = await portSnippet({ token, ref, language, onProgress, signal })
        return { ok: true, code, language, results: run.results, attempts: totalAttempts, restarts: restart, snippet }
      }

      if (attempt === MAX_FIX_ATTEMPTS) break

      const failures = (run.results || [])
        .filter(r => !r.passed)
        .map(r => ({ ...r, input: testcases[r.index]?.input }))

      onProgress({
        phase: 'fixing',
        attempt: attempt + 1,
        restart,
        passedCount: run.passedCount || 0,
        totalCount: run.totalCount || testcases.length,
        note: run.compileError ? 'compile error' : `${failures.length} test case(s) failing`
      })

      try {
        const fixed = await api.fixSolution(token, {
          language, code,
          compile_error: run.compileError || '',
          failures,
          ...context
        }, signal)
        if (!fixed.code) break
        code = fixed.code
      } catch (err) {
        if (isAbortError(err)) return { ok: false, code, language, attempts: totalAttempts, reason: 'Stopped.', stopped: true }
        break // AI unavailable for this pass — fall out and try a fresh generation
      }
    }

    if (restart < MAX_RESTARTS) {
      onProgress({ phase: 'restarting', restart: restart + 1, note: 'starting over with a different approach' })
    }
  }

  const passed = lastRun?.passedCount ?? 0
  const total = lastRun?.totalCount ?? testcases.length
  const rounds = `${MAX_RESTARTS + 1} attempt(s) × up to ${MAX_FIX_ATTEMPTS} fixes`
  return {
    ok: false, code, language,
    results: lastRun?.results || [],
    compileError: lastRun?.compileError || null,
    attempts: totalAttempts,
    restarts: MAX_RESTARTS,
    reason: lastRun?.compileError
      ? `Still not compiling after ${rounds}.`
      : `Still failing after ${rounds} (best run ${passed}/${total} passing).`
  }
}

// Ports header/footer/codeStub into the target language, but ONLY where the
// reference actually has that content. Returns undefined for a plain question
// so the push route leaves those fields alone entirely.
async function portSnippet({ token, ref, language, onProgress, signal }) {
  const hasContent = !!(ref.header || ref.footer || ref.codeStub)
  if (!hasContent) return undefined

  onProgress({ phase: 'porting-snippet' })
  const out = { hasSnippet: ref.hasSnippet }

  for (const kind of ['header', 'footer', 'codeStub']) {
    if (!ref[kind]) continue
    try {
      const r = await api.translateFragment(token, {
        target_language: language,
        fragment: ref[kind],
        kind,
        reference_language: ref.language
      }, signal)
      out[kind] = r.fragment || ref[kind]
    } catch {
      out[kind] = ref[kind] // fall back to the original rather than dropping it — an
      // abort here mid-snippet-port also just falls back rather than losing content
    }
  }
  return out
}
