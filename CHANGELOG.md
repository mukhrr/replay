# Changelog

## 0.4.1 — 2026-07-22

- **Clicks now target the control, not its label.** A card-style option — icon plus text inside a pressable wrapper — put the cursor over the label, so that is what the click event named. Component libraries routinely set `pointer-events: none` on text, and Playwright then reports the parent "intercepts pointer events" and retries until it times out. Reproduced exactly: 60 retries, then failure. The recorder now recognises the wrapper (`role`, `tabindex`, `data-focusable`, `onclick`) and selects it by its own visible text — `div[data-focusable="true"]:has-text("Household expenses")` — which clicks first time whether or not the label is transparent to the pointer.

## 0.4.0 — 2026-07-21

The rest of the field report.

### `repro fix` and `repro assert`

Repairing a recording meant hand-editing JSON — nine rounds of it in the report, about forty minutes before a fresh recording would replay at all. That gap is the adoption risk, not any individual papercut. Both commands print what they changed, and `--drop-step` renumbers ids so they keep matching position.

### Verdicts speak about the bug

`BUG REPRODUCED` / `BUG DID NOT REPRODUCE`, and under `--expect-fixed`, `BUG FIXED` / `BUG STILL PRESENT`. Reading `✗ FAIL` as good news is a workflow people route around by keeping two near-identical repros.

### Fixes

- **A polled endpoint is no longer recorded as a caused-by signal.** A keepalive on the app's own API host is invisible to host-based rules; the tell is that it also fires when nothing is happening, which is the same test already used for console output.
- **`finalState` describes where the flow ended.** It was derived from the last step's transitions, so a modal heading that appeared and closed became a required end state and the repro failed its own replay. The recorder now asks the page what actually survived.
- **Console and request invariants are not enforced across environments.** A repro recorded against a minified build and replayed against a dev server failed on React warnings that say nothing about the bug. Under a retarget they are reported as notes instead. Dev-build warnings are also treated as noise outright.
- Recorded timeouts have a more generous floor (5s, ceiling 30s): a warm production build and a cold dev bundle are not the same machine.

## 0.3.0 — 2026-07-21

### Focus assertions

Focus restoration is a large, under-tested class of accessibility bug (WCAG 2.4.3): close a dialog and focus lands on `body` instead of returning to the control that opened it. There is no console error, no failed request, and no DOM difference at the end — it is invisible to every other signal recorded here, and a deterministic replayer is the natural place to catch it.

Every step now records where focus came to rest, as `step.focusedAfter`. It is informational and never asserted automatically: focus is easily perturbed, and a check nobody asked for that fails on a healthy app is how a tool gets switched off. Copy it into the assertion to make it a criterion:

```jsonc
"assertion": {
  "expectedWhenFixed": { "focused": "button[aria-label^=\"Select a currency\"]" }
}
```

`finalState.focused` works the same way for `repro run`. A failure names where focus actually went, not just that it went wrong.

## 0.2.0 — 2026-07-21

From a field report on a production app.

### `repro run <name> --env <url>`

Record where the bug lives, replay where the fix lives. Three things carry an origin and all three now move together: `goto` steps, the app's own network patterns, and the captured session. Doing it by hand meant rewriting every absolute pattern and the `origin` key of the storage-state file — a lot of JSON surgery for what is conceptually one substitution.

`-u` remains the narrow version: it redirects navigation and nothing else. An absolute pattern like `https://staging.example.com/api/*` can never match a same-origin dev proxy, so `-u` alone leaves every network wait unsatisfiable.

Sibling hosts are treated as the same app and move with it; third-party origins are left alone, since rewriting a CDN or analytics endpoint would point someone else's traffic at your dev server.

### Fixes

- **`goto` steps displayed the recorded URL, not the one they navigated to.** The override worked — verified with two servers, the recorded origin received nothing — but the step table showed the recorded URL, so a user retargeting a repro to their local build read the staging URL and concluded the run had gone to staging. Every run now prints the effective origin once, up front, and `goto` steps show where they actually went.
- **A framework-synthesised click after keyboard activation is dropped.** React Native Web turns Enter/Space on a button into a click, so both were recorded; on replay the second fired after the first had already opened a modal and was intercepted by the overlay.
- **`networkIdle` is only recorded when the app actually went idle.** An app holding a websocket or long poll open — chat, live data, anything realtime — never does, so recording it as a required signal made step one fail on every replay forever.
- The search for an identifying ancestor now reaches as far as the CSS path does. A control six levels deep was getting a positional selector while its own test id sat just above it.

## 0.1.1 — 2026-07-21

- **Client-side routing is no longer recorded as a `goto` step.** Playwright fires `framenavigated` for History-API route changes, which every SPA performs on every interaction — so a recording of a routed app filled up with `goto` steps back to the page it was already on, and replay reloaded instead of exercising the flow. A navigation now becomes a step only when a document actually loaded.
- The window for attributing a navigation to the click that caused it widens from 1 s to 5 s. On a production app a click can take seconds to settle into a route change, and mis-attributing that was the other half of the same symptom.
- Repeated navigation to the same URL collapses to one step.

## 0.1.0 — 2026-07-21

First release.

### What it does

- **`repro record <name>`** — instrumented Chromium, click the bug once, writes `.repros/<name>.json`
- **`repro run <name>`** — replays headless at machine speed, pass/fail with the failing step
- **`repro run <name> --expect-fixed`** — passes when the bug no longer happens
- **`repro list`** — repros with last result and age
- **`repro-mcp`** — MCP server, so Claude Code / Codex / Gemini / Cursor verify a fix in one tool call
- Programmatic `record()` / `run()` / `list()`; the CLI and MCP server are both thin wrappers

A 10-step flow replays in **2.7s**, 20/20 consecutive runs, zero model calls.

### Design

- **The IR is JSON, not generated code.** Readable, hand-editable, patchable in place.
- **Waits come from observed signals, never sleeps.** Network settling, DOM appearing/disappearing — a step proceeds the instant the app reacts. Timeouts are derived from what was measured, not fixed.
- **Selectors are a candidate ladder**: test id → `name` → ARIA role + accessible name → labelled ancestor → stable CSS path → text anchor, with `>> nth=` only where genuinely ambiguous.
- **The tool never calls a model.** It observes; your agent reasons. Screenshots return as inline image content so the model sees the page rather than a file path.
- **It refuses to answer rather than guess.** `--expect-fixed` fails when the repro records nothing that could distinguish fixed from broken, and a replay that could not drive the app reports `COULD NOT VERIFY`, never `NOT FIXED`.

### Designed so agent-authored repros bolt on

`attachRecorder()` works on any context (hybrid takeover), `record()` takes a `drive(page)` callback (agent-driven recording produces identical IR), the replayer's step-failure path is a hook (LLM re-grounding), IR writes are atomic, and every step carries `author: "human" | "agent"`.

---

## What real codebases changed

The tool was built against a demo app, then benchmarked six times against two production codebases — Expensify (React Native Web) and a React + Vite + Radix app. Every round found defects that had passed cleanly on the demo app. Sixteen in total; these are the ones worth knowing about.

### Silent failures — the whole category

Three separate bugs where the tool produced a confident wrong answer rather than an error.

- **The recorder captured nothing, silently.** The in-page agent was serialized with `Function.prototype.toString()`, so esbuild's `keepNames` injected `__name()` calls that are undefined in page scope. It threw on line one and every recording came back empty — with the entire test suite green, because vitest's transform happened not to do that. Now the agent is a proper esbuild bundle, checked at build time for leaked helpers, with a readiness flag that turns a non-installing agent into a loud error.
- **`assertion.finalState` was a dead field.** Compiler-populated, schema-validated, documented as *the* assertion seam — and never read. A hand-edited assertion returned green without being checked.
- **`--expect-fixed` certified fixes it never checked.** Step-wait failures downgrade to notes under that polarity (correct — a fix changes behaviour), which left nothing able to fail for a bug with no console error and no failed request. It reported FIXED five times against a visibly broken page. A repro must now state `expectedWhenFixed`; without one, and with no bug signature to fall back on, the run **fails and says why**.

### Session seeding — what made real apps possible at all

- `storageState()` omits IndexedDB by default, so apps keeping auth there (Onyx, Dexie, Firebase Auth) produced a state file that looked complete and restored nothing. Now captured. Verified: 27 bytes without the flag, 235 with.
- `--profile <dir>` for a persistent Chromium profile, which also sidesteps non-idempotent signup — you never sign in twice.

### Waits that failed healthy apps

Recording "everything that changed after an action" is wrong on a busy React app, where most DOM churn is unrelated to what you did. Four species had to be excluded:

- **transient churn** — an appearance must survive until the next action (flushed on that action, not a timer, because replay stops waiting exactly then)
- **spinners** — excluded by what they are; they survive a cold run and never render on a warm one
- **static assets and telemetry** — a content-hashed bundle breaks on the next deploy *and* on the next replay, since the browser has it cached
- **re-render churn** — a selector that vanishes on one step and returns on the next is a component re-mounting, and replay can satisfy neither half

### Noise, and the danger of fixing one side

Ambient console output (CORS, `net::ERR_`, extension chatter) was poisoning the bug signature, so `--expect-fixed` reported "still broken" forever. Filtering it **only at record time** made things worse: the compiler inferred "this app is clean" and enabled the strictest invariants while the replayer checked raw output, so every replay failed. The filter now lives in one module both sides use. Aborted requests no longer count as failures — only 4xx/5xx.

### Selectors on a real component library

- `data-sentry-label` added to the top tier. Real apps label for telemetry far more consistently than they add test ids.
- React Native Web atomic hashes (`r-1awozwy`, `r-dnmrzs`) and per-session announcer ids (`fvbiask-aria`) rejected.
- A labelled ancestor is offered as a fallback when a click lands on an inner node, instead of descending into a style hash with nothing behind it.
- Playwright's `text=` matches the *smallest* element containing the text; the `nth` index was counting ancestors, so it could emit a selector matching nothing.

### Repros that can only run once

A flow that mutates server state can't be replayed as recorded — run two finds the work already done, so `--expect-fixed` goes green regardless. Added `--setup <cmd>` to reset state and `{{random}}` / `{{uuid}}` placeholders to make inputs unique. Placeholders can be **named** (`{{random:sensor}}`) so one value resolves identically across every value, selector and wait in a run — without that, making an input unique breaks every selector derived from it. A warning fires when a fix "passes" while the assertion step behaved nothing like the recording.

### Other

- Agent split from one 740-line closure into ten modules, which immediately made the `text=` bug findable
- `prepare` script so `npm i github:mukhrr/fast-replay` self-builds
- `commander@14` pinned so the declared `node >= 20` is honest and it installs under `engine-strict`
- MCP gained `headed` (apps that refuse headless were unusable without it), `profile_dir`, `setup_command`, and `REPLAY_ROOT`
- MCP holds one browser across calls instead of launching per verification — 3% on the demo app, expected to be more on a large bundle, unverified
- `--resolve-timeout` for slow-booting SPAs; partial IR written when a driver throws mid-flow

### Portals, layout probes and a wrong fix

The second codebase broke the *recorder* in ways the first never could.

- **A layout probe became step zero.** `element-resize-detector` scrolls an offscreen element during layout; it was recorded as a user action and ordered *before* the navigation that created the page, so its selector could never resolve and step one failed in every recording.
- **A menu trigger's click could be recorded zero times.** Not the duplicate it looked like: only one click event fires, and when a menu opens on `pointerdown` and portals content over the cursor, the browser dispatches that click on the common ancestor of the down and up targets — `<html>`, which has no selector. The recorder now falls back to the `pointerdown` target, which fires before any of the reshuffling. My first fix for this addressed a mechanism I had inferred from my own code rather than observed; it was wrong, and an event trace from the app showed why.
- **Console classification was nondeterministic.** Splitting boot noise from bug evidence on *timing* meant the same two errors landed in opposite buckets depending on how fast the recording started clicking — and a fast start treated the app's own chatter as the bug's signature. Now split on causation: an error counts as evidence only if it lands in the wake of an action.
- **`repro run` could not detect a fix for absence-bugs.** A recorded end state names what vanished, never what wrongly failed to appear, so it stayed satisfied after a fix. When `expectedWhenFixed` is present, plain `run` now asserts its inverse.
- Hash fragments are part of the address. `pathOf` returned pathname and query only, so a recording at `/app.html#/sensors` replayed against `/app.html`.

---

## Known limits

- **Recording is a human clicking once.** Agent-driven capture works through `record({ drive })`, but `repro auto` from a bug description is Phase 1.
- **Top frame only.** Actions inside iframes are not recorded.
- **Accessible name is a pragmatic subset** of the accname spec, not the full algorithm.
- **A repro of a DOM-only bug needs a hand-written `expectedWhenFixed`.** Nothing can derive it.
- **Server-mutating flows need `--setup`.** Placeholders make inputs unique but cannot restore a precondition the first run consumed.
- **Every measurement here is from one machine.** The Expensify numbers came from a staging environment that appears to have partially fixed the bug under test.
