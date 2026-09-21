# Starklight

QC and content tooling for the Examly / iamneo assessment portal
(`api.examly.io`). Replaces a lot of manual clicking through the portal's own
admin UI.

Five sections:

| Route | Section | What it does |
|---|---|---|
| `/test-qc` | **Test Quality Check** | Open a published test, run the AI QC rubric section-by-section, get pasteable fixes, export Excel |
| `/topic-alignment` | **Topic Alignment** | Check a test or question bank against an allowed/restricted topic scope. Every completed report is saved to history for later download |
| `/solutions` | **Solution Manager** | Add or replace a solution in another language — generated, **actually compiled and run** against the real test cases, auto-fixed from real failures, then pushed |
| `/qb-organiser` | **QB Organiser** | Move questions out of one question bank into banks you've already created |
| `/language-manager` | **Language Manager** | Pick which languages a test or QB should keep — unwanted languages are removed from the portal permanently; a picked language with no solution yet is enabled with a placeholder, never generated |

Auth is a JWT access token pasted on the sign-in screen. It lives in memory
for that tab only and is never persisted.

---

## Running locally

```bash
npm run install-all
```

Create `backend/.env` from the template:

```bash
cp backend/.env.example backend/.env
```

Fill in whichever AI keys you have — each is optional, and a provider without
a key is skipped as the chain falls through to the next one. Then, in two
terminals:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

The Vite dev server runs on `:5173` and proxies `/api/*` to `:3000`, so **the
backend must be running** or every request 502s.

### Local code execution

Solution Manager compiles and runs candidate solutions on your machine, so the
relevant toolchain has to be installed:

| Language | Needs | Notes |
|---|---|---|
| Python | `py -3`, `python`, or `python3` | On Windows, make sure this is a real install and **not** the Microsoft Store app-execution alias — the alias is a stub that exits 49 |
| C / C++ | `gcc` / `g++` | Compiled with `-std=c17` / `-std=c++17` to match the portal |
| Java 17 / 21 | `javac` + `java` | Compiled with `--release 17` / `--release 21` |
| Plain Javascript | none | Node already runs the server |

`GET /api/toolchain-check` reports what's available, and the language picker
shows it before you generate. Anything missing is reported as an environment
problem rather than being mistaken for bad generated code.

Common Windows install locations are auto-discovered (including per-user
`winget` packages, which only ever reach the *user* PATH). Add unusual ones
with `EXTRA_TOOLCHAIN_PATHS`.

---

## Deploying to Render

One web service serves both the API and the built UI — no CORS, one URL, and
the free tier only gives you one service anyway.

### What you need

1. **A GitHub repository** with this code pushed to it.
2. **A Render account** connected to that GitHub account.
3. **A Postgres connection string** — only for Topic Alignment history. Any
   Postgres works; see the note below on free options.
4. **Your AI provider keys** — at least one. All four are optional
   individually, but with none configured the AI features cannot run.

Nothing else. No Docker, no build image, no persistent disk.

### Steps

1. Push to GitHub (see below).
2. In Render: **New → Blueprint**, point it at the repo. `render.yaml` is
   picked up automatically and configures the service.
3. Set the environment variables when prompted, or afterwards under the
   service's **Environment** tab:

   | Variable | Required | Notes |
   |---|---|---|
   | `GROQ_API_KEY` | one of these | fastest, generous free tier |
   | `OPENROUTER_API_KEY` | one of these | free-tagged models only |
   | `GEMINI_API_KEY` | one of these | free tier |
   | `HF_API_KEY` | one of these | last in the fallback chain |
   | `DATABASE_URL` | for history | Postgres connection string |
   | `SCHOOL_ID` | for Solution Manager / Language Manager | your Examly `school-id`; `EXAMLY_BASE_URL` is already set in `render.yaml` |

4. Deploy. Health check is `/api/history/status`, which responds whether or
   not a database is configured.

Render sets `PORT` itself; the server reads it.

### Choosing a free database

`DATABASE_URL` is a plain Postgres connection string, so these are
interchangeable — pick one and paste it:

- **Neon** — free tier does not expire. Recommended for a free setup.
- **Supabase** — also free, same idea.
- **Render Postgres** — most convenient (same dashboard), but note Render
  **deletes free Postgres instances after 30 days**, taking the history with
  them. Fine for a trial, not for a long-lived record.

Add `?sslmode=require` if your provider asks for it. Set `DATABASE_SSL=off`
only for a local Postgres with no TLS.

**Without `DATABASE_URL` the app still runs.** Test QC and Solution Manager
are unaffected; Topic Alignment works but its history panel reports itself as
unconfigured instead of erroring.

### Free-tier caveats

- The service **sleeps after ~15 minutes idle**; the next request takes
  30-60s to wake it.
- Solution Manager's local execution needs compilers, and Render's Node
  runtime **does not include `gcc`, `g++`, or a JDK**. Python and Plain
  Javascript will verify on Render; C, C++ and Java will report their
  toolchain as missing. Run Solution Manager locally for those, or move the
  service to a Docker runtime with the compilers installed.

---

## Pushing to GitHub

Create an empty repo on GitHub (no README/.gitignore/license — this repo
brings its own), then from the project root:

```bash
git init && git add . && git commit -m "Initial commit"
```

```bash
git remote add origin https://github.com/<you>/<repo>.git
```

```bash
git branch -M main && git push -u origin main
```

### Before you push — secrets

API keys are **not** in the source. They were moved to environment variables
before the first commit, so no key has ever been in git history. `.gitignore`
excludes `backend/.env`.

Verify at any time:

```bash
git log -p --all | grep -cE "gsk_|sk-or-v1-|hf_[A-Za-z0-9]{20}"
```

`0` means clean. Anything else means a key reached history and must be rotated.

---

## Layout

```
starklight/
├── package.json          workspace scripts (install-all, render-build, start)
├── render.yaml           Render blueprint — one web service
├── backend/
│   ├── server.js         Express proxy, AI chain, QC + push routes
│   ├── routes-execute.js local compile/run + toolchain discovery
│   ├── routes-history.js Topic Alignment report history API
│   ├── db.js             Postgres access (optional, degrades cleanly)
│   ├── qbforge-routes/   Solution Manager / Language Manager's own Examly + AI + execute routes
│   └── .env              your keys — gitignored
└── starklight/           React + Vite client
```
