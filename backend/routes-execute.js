'use strict';
// ---------------------------------------------------------------------------
// Local code execution — runs a candidate solution against a question's REAL
// sample + hidden test cases on this machine.
//
// Why local rather than the portal's own compile service: that service's
// request body is client-side encrypted with a key baked into the portal's
// frontend JS. Running locally gives the same pass/fail-per-testcase answer
// with no encryption to reverse, no rate limits, and no external dependency.
//
// Requires the relevant toolchain to be installed and on PATH:
//   Python -> python (or python3)   C -> gcc   C++ -> g++   Java -> javac/java
// Anything missing is reported clearly as "toolchain not found" rather than
// being mistaken for the candidate's code being wrong.
// ---------------------------------------------------------------------------
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();

const RUN_TIMEOUT_MS = 5000;       // per test case — catches infinite loops in the candidate's logic
const COMPILE_TIMEOUT_MS = 20000;  // compiling (heavy STL includes, cold cache) legitimately takes longer

// Extra directories to look in, on top of whatever PATH the server process
// inherited. A dev server started before a toolchain was installed won't see
// it otherwise (the process captured PATH at launch). Add locations with the
// EXTRA_TOOLCHAIN_PATHS env var — os-appropriate separator, e.g.
//   Windows: set EXTRA_TOOLCHAIN_PATHS=C:\tools\mingw64\bin;C:\jdk21\bin
//   macOS/Linux: export EXTRA_TOOLCHAIN_PATHS=/usr/local/bin:/opt/homebrew/bin
// Env dirs come first (so they win), but they no longer REPLACE the defaults:
// setting the var to point at a JDK used to silently drop the MinGW defaults
// and break C/C++.
const SEP = process.platform === 'win32' ? ';' : ':';
const DEFAULT_EXTRA_DIRS = process.platform === 'win32'
  ? ['C:\\MinGW\\bin', 'C:\\msys64\\mingw64\\bin']
  : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];

// Installers (winget especially) put the toolchain in a versioned directory
// and update the *user* PATH, which a long-running server never picks up.
// Globbing the standard parents means "install it, hit re-check" works
// without restarting the backend. Deliberately generic — parent directories
// only, never a specific machine's user name.
function globChildren(parent, matcher, suffix) {
  try {
    return fs.readdirSync(parent)
      .filter(matcher)
      .map(name => path.join(parent, name, suffix || ''))
      .filter(p => fs.existsSync(p));
  } catch (e) {
    return []; // parent doesn't exist on this machine — normal
  }
}

// Executables worth putting a directory on PATH for. Used to keep the winget
// scan below from appending every package folder on the machine.
const TOOL_EXES = ['gcc.exe', 'g++.exe', 'javac.exe', 'java.exe', 'python.exe'];

function hasAnyTool(dir) {
  try {
    return TOOL_EXES.some(exe => fs.existsSync(path.join(dir, exe)));
  } catch (e) {
    return false;
  }
}

// winget installs a user-scope package into a versioned folder here and puts
// it on the *user* PATH — which a long-running server never picks up, and
// which this Git-Bash/Node process didn't inherit either. Layouts vary
// (mingw64/bin for WinLibs, bin for most JDKs, sometimes a nested version
// dir), so a few shapes are probed and only directories that actually hold a
// toolchain executable are kept.
function wingetDirs(localAppData) {
  if (!localAppData) return [];
  const root = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  let pkgs;
  try {
    pkgs = fs.readdirSync(root);
  } catch (e) {
    return []; // no winget packages on this machine — normal
  }
  const out = [];
  for (const pkg of pkgs) {
    const base = path.join(root, pkg);
    const candidates = [
      base,
      path.join(base, 'bin'),
      path.join(base, 'mingw64', 'bin'),
      path.join(base, 'mingw32', 'bin')
    ];
    // ...plus one nested level, which is how most MSI-style JDKs land.
    try {
      for (const child of fs.readdirSync(base)) {
        candidates.push(path.join(base, child, 'bin'));
      }
    } catch (e) { /* not a directory we can read — skip */ }

    for (const c of candidates) if (hasAnyTool(c)) out.push(c);
  }
  return out;
}

function discoveredDirs() {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA || '';
  const isPy = n => /^Python3\d*$/i.test(n);
  const isJdk = n => /(jdk|java|temurin|zulu|corretto)/i.test(n);
  return [
    // Python — per-user and machine-wide. The interpreter sits in the root.
    ...(localAppData ? globChildren(path.join(localAppData, 'Programs', 'Python'), isPy, '') : []),
    // ...and the layout the `py` launcher / Store build uses, which is NOT on
    // PATH at all: %LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe
    ...(localAppData ? globChildren(path.join(localAppData, 'Python'), n => /^pythoncore/i.test(n), '') : []),
    ...globChildren('C:\\Program Files', isPy, ''),
    ...globChildren('C:\\', isPy, ''),
    // JDKs — the tools sit in bin/.
    ...globChildren('C:\\Program Files\\Java', isJdk, 'bin'),
    ...globChildren('C:\\Program Files\\Eclipse Adoptium', isJdk, 'bin'),
    ...globChildren('C:\\Program Files\\Microsoft', isJdk, 'bin'),
    ...(localAppData ? globChildren(path.join(localAppData, 'Programs', 'Eclipse Adoptium'), isJdk, 'bin') : []),
    // Toolchains installed by `winget install --scope user`, which land under
    // WinGet\Packages and only ever reach the *user* PATH.
    ...wingetDirs(localAppData)
  ];
}

function extraDirs() {
  const fromEnv = (process.env.EXTRA_TOOLCHAIN_PATHS || '').split(SEP).filter(Boolean);
  const seen = new Set();
  return [...fromEnv, ...DEFAULT_EXTRA_DIRS, ...discoveredDirs()]
    .filter(d => { const k = d.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function childEnv() {
  return Object.assign({}, process.env, {
    PATH: extraDirs().join(SEP) + SEP + (process.env.PATH || '')
  });
}

// Windows ships "App execution alias" stubs at
// %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe (and python3.exe) when
// Python isn't installed. They are NOT interpreters: they exit 49 and print
// "Python was not found; run without arguments to install from the Microsoft
// Store..." to stderr.
//
// This is the nastiest possible failure mode here, because the stub *spawns
// successfully* — ENOENT never fires, so nothing was flagged as a missing
// toolchain and the stub's message flowed onward as if it were the
// candidate's program output. Solution Forge then read it as six wrong
// answers and burned all three AI fix attempts trying to "correct" perfectly
// good code. Detect it explicitly and report it as what it is: not installed.
const STORE_STUB_RE = /was not found; run without arguments to install from the Microsoft Store/i;

function isStoreAliasStub(text) {
  return STORE_STUB_RE.test(String(text || ''));
}

function runProcess(cmd, args, input, cwd, timeoutMs) {
  timeoutMs = timeoutMs || RUN_TIMEOUT_MS;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, env: childEnv() });
    } catch (e) {
      return resolve({ ok: false, error: 'Could not start ' + cmd + ': ' + e.message, missingTool: cmd });
    }
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ ok: false, error: 'Timed out after ' + timeoutMs + 'ms (possible infinite loop)' });
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // ENOENT here means the compiler/interpreter isn't installed — a very
      // different problem from the submitted code being wrong, so it's flagged.
      const missing = e.code === 'ENOENT';
      resolve({
        ok: false,
        error: missing ? ('Toolchain not found: "' + cmd + '" is not installed or not on PATH') : e.message,
        missingTool: missing ? cmd : undefined
      });
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Checked before anything else: the stub "succeeds" at the process
      // level, so any later branch would treat its message as real output.
      if (isStoreAliasStub(stderr) || isStoreAliasStub(stdout)) {
        return resolve({
          ok: false,
          exitCode: code,
          error: 'Toolchain not found: "' + cmd + '" on this machine is the Windows App-execution-alias ' +
                 'placeholder, not a real interpreter. Install Python (python.org or `winget install ' +
                 'Python.Python.3.12`), or turn the alias off under Settings > Apps > Advanced app ' +
                 'settings > App execution aliases.',
          missingTool: cmd
        });
      }
      // stdout is carried on the failure path too: some compilers (dotnet in
      // particular) print their diagnostics there, and dropping it left a
      // build failure with no explanation attached.
      if (code !== 0 && stderr) return resolve({ ok: false, exitCode: code, stdout, error: stderr.trim() || ('exit code ' + code) });
      resolve({ ok: true, exitCode: code, stdout, stderr });
    });

    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

// Python may be `python`, `python3`, or (Windows) the `py` launcher depending
// on the platform/install. Each candidate is *probed* and only accepted if it
// really answers --version: the previous version fell back to `python3`
// whenever `python` failed, without checking, which on Windows just swapped
// one Store-alias stub for another.
//
// Returns { cmd, prefix } or null when there is no working interpreter —
// null is what makes prepare() report a missing toolchain instead of letting
// the forge loop retry code that was never the problem.
let pythonCmdCache;

async function pythonCmd() {
  if (pythonCmdCache !== undefined) return pythonCmdCache;
  // `py -3` first on Windows: the official launcher is installed by python.org
  // and resolves a real interpreter even when PATH is cluttered with aliases.
  const candidates = process.platform === 'win32'
    ? [{ cmd: 'py', prefix: ['-3'] }, { cmd: 'python', prefix: [] }, { cmd: 'python3', prefix: [] }]
    : [{ cmd: 'python3', prefix: [] }, { cmd: 'python', prefix: [] }];
  for (const c of candidates) {
    const probe = await runProcess(c.cmd, [...c.prefix, '--version'], null, os.tmpdir(), 5000);
    if (probe.ok) { pythonCmdCache = c; return pythonCmdCache; }
  }
  pythonCmdCache = null;
  return null;
}

// The probe result is cached (it's stable for the life of the process and
// runs on every test case otherwise), so installing Python needs a way to
// invalidate it short of restarting the backend — /toolchain-check calls this.
function resetToolchainCache() {
  pythonCmdCache = undefined;
}

// Which local runner (if any) handles a given PORTAL language name.
//
// Keyed on the portal's exact names — substring matching cannot survive the
// real catalogue: "Plain Javascript" contains "java", so `lang.includes('java')`
// happily fed JavaScript to javac; "Cc++11" starts with "c" but is C++;
// "Java_jdbc" needs a database, not just a JDK. Anything absent from this map
// has no local runner and is reported as such instead of being guessed at.
const RUNNER_KIND = {
  'python': 'python',
  'python3.12': 'python',
  'java': 'java',
  'java17': 'java',
  'java21': 'java',
  'c': 'c',
  'cc++11': 'c',
  'c++': 'cpp',
  'c++c++11': 'cpp',
  'plain javascript': 'node'
  // C# is deliberately absent — not offered, so any request for it is
  // refused as "no local runner" rather than quietly handled.
};

function runnerKind(language) {
  return RUNNER_KIND[String(language || '').trim().toLowerCase()] || null;
}

// The language standard the PORTAL compiles with. Pinned explicitly because
// the local gcc is much newer (16.x) and defaults to a far later standard —
// so C23/C++23-only code would compile clean here and then fail on the
// portal, which is exactly the false "verified" this tool exists to prevent.
const STD_FLAG = {
  'c': ['-std=c17'],
  'c++': ['-std=c++17'],
  'cc++11': ['-std=c11'],
  'c++c++11': ['-std=c++11'],
  // Same idea for Java: one JDK is installed, but `--release N` makes it
  // compile against N's API and reject anything newer, so "Java17" really
  // means Java 17 rather than whatever JDK happens to be on this machine.
  'java17': ['--release', '17'],
  'java21': ['--release', '21']
};

function stdFlags(language) {
  return STD_FLAG[String(language || '').trim().toLowerCase()] || [];
}

// One compile step (where needed) plus a per-test-case run step.
// Returns { run } on success, or { compileError, missingTool? }.
async function prepare(language, code, dir) {
  const lang = String(language || '').toLowerCase();

  const kind = runnerKind(language);

  if (kind === 'python') {
    const file = path.join(dir, 'main.py');
    fs.writeFileSync(file, code, 'utf8');
    const py = await pythonCmd();
    if (!py) {
      return {
        compileError: 'Toolchain not found: no working Python interpreter. Tried ' +
          (process.platform === 'win32' ? '`py -3`, `python` and `python3`' : '`python3` and `python`') +
          '. Install Python (python.org or `winget install Python.Python.3.12`) and re-check, or set ' +
          'EXTRA_TOOLCHAIN_PATHS if it lives somewhere unusual. On Windows, make sure `python` resolves ' +
          'to a real install and not the Microsoft Store app-execution alias.',
        missingTool: 'python'
      };
    }
    return { run: input => runProcess(py.cmd, [...py.prefix, file], input, dir) };
  }

  if (kind === 'c') {
    const src = path.join(dir, 'main.c');
    const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main.out');
    fs.writeFileSync(src, code, 'utf8');
    const r = await runProcess('gcc', [...stdFlags(language), src, '-o', exe], null, dir, COMPILE_TIMEOUT_MS);
    if (!r.ok || r.exitCode !== 0) {
      // A non-zero exit with nothing on stderr still means the compile failed;
      // treating it as success left us running a binary that was never built.
      return { compileError: r.error || ("Compiler exited with code " + r.exitCode), missingTool: r.missingTool };
    }
    return { run: input => runProcess(exe, [], input, dir) };
  }

  if (kind === 'cpp') {
    const src = path.join(dir, 'main.cpp');
    const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main.out');
    fs.writeFileSync(src, code, 'utf8');
    const r = await runProcess('g++', [...stdFlags(language), src, '-o', exe], null, dir, COMPILE_TIMEOUT_MS);
    if (!r.ok || r.exitCode !== 0) {
      // A non-zero exit with nothing on stderr still means the compile failed;
      // treating it as success left us running a binary that was never built.
      return { compileError: r.error || ("Compiler exited with code " + r.exitCode), missingTool: r.missingTool };
    }
    return { run: input => runProcess(exe, [], input, dir) };
  }

  if (kind === 'java') {
    // Generated Java always uses `public class Main`, so the file must be Main.java.
    const src = path.join(dir, 'Main.java');
    fs.writeFileSync(src, code, 'utf8');
    const r = await runProcess('javac', [...stdFlags(language), src], null, dir, COMPILE_TIMEOUT_MS);
    if (!r.ok || r.exitCode !== 0) {
      // A non-zero exit with nothing on stderr still means the compile failed;
      // treating it as success left us running a binary that was never built.
      return { compileError: r.error || ("Compiler exited with code " + r.exitCode), missingTool: r.missingTool };
    }
    return { run: input => runProcess('java', ['-cp', dir, 'Main'], input, dir) };
  }

  if (kind === 'node') {
    // Node is always available — it's running this server — so "Plain
    // Javascript" is verifiable with no extra toolchain to install.
    const file = path.join(dir, 'main.js');
    fs.writeFileSync(file, code, 'utf8');
    return { run: input => runProcess(process.execPath, [file], input, dir) };
  }

  // No local runner. This is an environment/capability limit, not bad code, so
  // it carries missingTool and the forge loop aborts instead of "fixing" code
  // that was never going to be run here.
  return {
    compileError: 'No local runner for "' + language + '". Solution Forge can only verify ' +
      Object.keys(RUNNER_KIND).length + ' of the portal\'s languages locally (Python, Python3.12, ' +
      'Java, Java17, Java21, C, Cc++11, C++, C++c++11, Plain Javascript). Nothing is pushed unverified.',
    missingTool: 'runner:' + language
  };
}

// Comparison against the portal's expected output.
//
// Only two things are normalised, and both are genuine local artefacts:
//   - CRLF -> LF. The program runs on Windows here but on Linux at the
//     portal, so \r is noise we introduced, not something the solution did.
//   - trailing spaces/tabs at the end of each LINE.
//
// The FINAL NEWLINE is deliberately NOT normalised away. This used to end
// with `.replace(/\n+$/, '')`, stripping trailing newlines from both sides —
// so a program printing "2" compared equal to the expected "2\n", passed
// here, and was then rejected by the real portal. A false "verified" is the
// one outcome this whole tool exists to prevent, so the trailing newline is
// now compared exactly, like the portal does.
function normaliseOutput(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

// A trailing-newline mismatch is invisible in a side-by-side diff — expected
// and actual both just look like "2". Detected explicitly so the failure can
// say what's actually wrong, otherwise the fix round gets a diff it cannot
// see and flails.
function differsOnlyByTrailingWhitespace(a, b) {
  return a !== b && a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

function describeTrailingDiff(actual, expected) {
  const ends = s => (/\n$/.test(s) ? 'ends with a newline' : 'does NOT end with a newline');
  return 'Output is correct but the trailing newline is wrong: expected output ' +
    ends(expected) + ', your output ' + ends(actual) +
    '. Print a newline after the final line of output (e.g. `endl` or "\\n").';
}

// POST /api/run-tests { language, code, testcases: [{input, output, label?}] }
router.post('/run-tests', async (req, res) => {
  const { language, code } = req.body || {};
  const testcases = Array.isArray(req.body && req.body.testcases) ? req.body.testcases : [];
  if (!language || !code) return res.status(400).json({ error: '"language" and "code" are required' });
  if (!testcases.length) return res.status(400).json({ error: '"testcases" must be a non-empty array' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starklight-run-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

  try {
    const prep = await prepare(language, code, dir);
    if (prep.compileError) {
      cleanup();
      return res.json({
        ok: false,
        compileError: prep.compileError,
        missingTool: prep.missingTool || null,
        results: []
      });
    }

    // Test cases are independent (each spawns its own process, no shared
    // state) so they run concurrently — a big win for Java especially, where
    // every run otherwise pays a fresh JVM startup.
    const results = await Promise.all(testcases.map(async (tc, i) => {
      const r = await prep.run(tc.input != null ? String(tc.input) : '');
      if (!r.ok) {
        return { index: i, label: tc.label || null, passed: false, error: r.error, expected: tc.output, actual: null };
      }
      const actual = normaliseOutput(r.stdout);
      const expected = normaliseOutput(tc.output);
      const passed = actual === expected;
      const trailingOnly = !passed && differsOnlyByTrailingWhitespace(actual, expected);
      return {
        index: i, label: tc.label || null, passed,
        expected: tc.output, actual: r.stdout, stderr: r.stderr || undefined,
        // Carried so the UI and the fix prompt can explain a difference that
        // is otherwise invisible.
        whitespaceOnly: trailingOnly || undefined,
        note: trailingOnly ? describeTrailingDiff(actual, expected) : undefined
      };
    }));

    cleanup();
    const passedCount = results.filter(r => r.passed).length;
    res.json({
      ok: true, passedCount, totalCount: results.length,
      allPassed: passedCount === results.length, results
    });
  } catch (err) {
    cleanup();
    res.status(500).json({ error: err.message });
  }
});

// GET /api/toolchain-check — which languages can actually be executed here.
// Surfaced in the UI so a missing compiler is obvious up front rather than
// looking like every generated solution is broken.
router.get('/toolchain-check', async (_req, res) => {
  const tmp = os.tmpdir();
  // "re-check" exists to be pressed right after installing something, so the
  // cached interpreter probe (and the discovered PATH dirs, recomputed on
  // every call) must not pin the answer to what was true at startup.
  resetToolchainCache();

  const out = {};

  // Python goes through the same resolver the runner uses, so the badge can
  // never disagree with what actually happens on a run.
  const py = await pythonCmd();
  if (py) {
    const r = await runProcess(py.cmd, [...py.prefix, '--version'], null, tmp, 5000);
    out.Python = {
      available: !!r.ok,
      version: r.ok ? String(r.stdout || r.stderr || '').split('\n')[0].trim() : null,
      command: [py.cmd, ...py.prefix].join(' '),
      error: r.ok ? null : r.error
    };
  } else {
    out.Python = {
      available: false,
      version: null,
      command: null,
      error: 'No working Python interpreter found' +
        (process.platform === 'win32'
          ? ' (`py -3`, `python`, `python3` all failed or are Microsoft Store alias placeholders).'
          : ' (`python3`, `python` both failed).')
    };
  }

  // javac compiles and java runs — a JRE-only install passes one and fails
  // the other, so both must be green before Java counts as available.
  const rest = [
    { language: 'C', cmds: [['gcc', ['--version']]] },
    { language: 'C++', cmds: [['g++', ['--version']]] },
    { language: 'Java', cmds: [['javac', ['-version']], ['java', ['-version']]] }
  ];
  // Node runs this server, so JavaScript is verifiable by definition.
  out.JavaScript = { available: true, version: 'Node ' + process.version, command: process.execPath, error: null };

  for (const p of rest) {
    let available = true, version = null, error = null;
    for (const [cmd, args] of p.cmds) {
      const r = await runProcess(cmd, args, null, tmp, 5000);
      if (!r.ok) { available = false; error = r.error; break; }
      if (!version) version = String(r.stdout || r.stderr || '').split('\n')[0].trim();
    }
    out[p.language] = { available, version: available ? version : null, error };
  }

  res.json({ ok: true, toolchains: out, extraPathDirs: extraDirs() });
});

module.exports = router;
