# Changelog

## 0.2.1 — unreleased

Third round in `pdu_html`. The 0.2.0 click fix targeted the wrong mechanism; the real one was found from an event trace.

- **A click can name an element the user never touched.** When a menu opens on `pointerdown` and portals content over the cursor, `pointerup` lands on that new content and the browser dispatches the click on the nearest common ancestor — `<body>`, or `<html>` when the portal is a sibling of the trigger. `<html>` has no selector at all, so the gesture was dropped and the recording was silently missing a step. The recorder now falls back to the `pointerdown` target, which fires before any of that reshuffling. Reproduced with a real portal-over-cursor harness, not a stand-in.
- **Console classification was nondeterministic.** Splitting on "before the first action" meant the same two errors landed in opposite buckets depending on how fast the recording started clicking — and a fast start treated the app's boot chatter as the bug's signature. Now split by causation: an error is evidence only if it lands in some action's reaction window. Noise common to every app is handled by the shared filter and kept out of the per-repro baseline entirely, so it cannot weaken an otherwise dependable invariant.

## 0.2.0 — unreleased

Fixes from a second benchmark round in `pdu_html` (React 18 + Vite + Radix, hash-routed).

- **A menu trigger's click could be recorded zero times.** Echo suppression was tracked against the last click *seen*; if that one was dropped for having no usable selector, the real click was suppressed as its echo and the gesture vanished from the artifact entirely. Now tracked against the last click *recorded*, so a gesture can never net zero. Same-element synthetic re-dispatch (how Radix and MUI primitives open menus) is also collapsed, while two genuine clicks on one button stay two.
- **A flaky boot error silently flipped an invariant.** An error the app logs on *some* loads was absent from one recording, so the compiler inferred "clean app" and enabled the strictest check — which then failed the next replay. Boot-time output is now captured per repro as `observedAtRecord.ambientConsoleErrors`, subtracted at replay, and a strict invariant is no longer inferred from a single quiet recording.
- **`repro run` could not detect a fix for absence-bugs.** The recorded `finalState` says what vanished, never what wrongly failed to appear, so it stayed satisfied after a fix. When `expectedWhenFixed` is present, plain `run` now asserts its inverse.
- `--version` reports the real version. Two builds both saying `0.1.0` could only be told apart by grepping `dist/`.

## 0.1.0 — unreleased

First working version. Record a browser bug once, verify the fix in seconds.

### What it does

- **`repro record <name>`** — instrumented Chromium, click the bug once, writes `.repros/<name>.json`
- **`repro run <name>`** — replays headless at machine speed, pass/fail with the failing step
- **`repro list`** — repros with last result and age
- **`repro-mcp`** — MCP server, so Claude Code / Codex / Gemini / Cursor verify a fix in one tool call
- Programmatic `record()` / `run()` / `list()`; the CLI and MCP server are both thin wrappers

A 10-step flow replays in **2.7s**, 20/20 consecutive runs, zero model calls.

### Design

- **The IR is JSON, not generated code.** Readable, hand-editable, patchable in place.
- **Waits come from observed signals, never sleeps.** Network settling, DOM appearing/disappearing — a step proceeds the instant the app reacts. Timeouts are derived from what was measured, not fixed.
- **Selectors are a candidate ladder**: test id → ARIA role + accessible name → stable CSS path → text anchor, with `>> nth=` only where genuinely ambiguous.
- **The tool never calls a model.** It observes; your agent reasons. Screenshots return as inline image content so the model sees the page rather than a file path.

### Built for Phase 1 from the start

`attachRecorder()` works on any context (hybrid takeover), `record()` takes a `drive(page)` callback (agent-authored repros produce identical IR), the replayer's step-failure path is a hook (LLM re-grounding), IR writes are atomic, and every step carries `author: "human" | "agent"`.

---

## What real codebases changed

The tool was built against a demo app, then run against Expensify (React Native Web, issue #96419) three times. Every round found defects that had passed cleanly on the demo app. These are the ones worth knowing about.

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
- `prepare` script so `npm i github:mukhrr/replay` self-builds
- `commander@14` pinned so the declared `node >= 20` is honest and it installs under `engine-strict`
- MCP gained `headed` (apps that refuse headless were unusable without it), `profile_dir`, `setup_command`, and `REPLAY_ROOT`
- MCP holds one browser across calls instead of launching per verification — 3% on the demo app, expected to be more on a large bundle, unverified
- `--resolve-timeout` for slow-booting SPAs; partial IR written when a driver throws mid-flow

---

## Known limits

- **Recording is a human clicking once.** Agent-driven capture works through `record({ drive })`, but `repro auto` from a bug description is Phase 1.
- **Top frame only.** Actions inside iframes are not recorded.
- **Accessible name is a pragmatic subset** of the accname spec, not the full algorithm.
- **A repro of a DOM-only bug needs a hand-written `expectedWhenFixed`.** Nothing can derive it.
- **Server-mutating flows need `--setup`.** Placeholders make inputs unique but cannot restore a precondition the first run consumed.
- **Every measurement here is from one machine.** The Expensify numbers came from a staging environment that appears to have partially fixed the bug under test.
