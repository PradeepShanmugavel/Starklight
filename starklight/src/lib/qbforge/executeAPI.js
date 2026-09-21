import axios from 'axios';

// Runs code against real test cases LOCALLY on this machine (Python/gcc/g++/
// JDK installed on the server host) — no dependency on the portal's compile
// service, whose request body turned out to be client-side encrypted.
// `signal` (optional): an AbortController's signal — lets the caller cancel
// a still-running compile/test-run (the "Stop" button during generation).
export async function runTests(language, code, testcases, signal) {
  const r = await axios.post('/api/execute/run-tests', { language, code, testcases }, { signal });
  return r.data; // { ok, passedCount, totalCount, allPassed, results: [{index,label,passed,expected,actual,error?}], compileError? }
}
