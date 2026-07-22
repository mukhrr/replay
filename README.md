# fast-replay

[![CI](https://github.com/mukhrr/fast-replay/actions/workflows/ci.yml/badge.svg)](https://github.com/mukhrr/fast-replay/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fast-replay)](https://www.npmjs.com/package/fast-replay)

Turn an expensive, unrepeatable setup into a cheap, repeatable question.

Some bugs live behind state you can only create once — a transferred workspace, a consumed invite, a migrated account. Getting there costs half an hour. Checking whether your fix worked should not cost it again. Record the observation once, and you own a few-second check you can run forever, with no model in the loop.

```
$ repro run sensor-delete-crash

STEP  ACTION  ACT   WAIT   TOTAL  WHAT
s1    fill    26ms  492ms  518ms  New sensor name textbox in the section labelled "Sensors"
s5    click   7ms   25ms   32ms   Delete Sensor 2 button in the row containing "Sensor 2"
s10   click   23ms  1.79s  1.81s  Generate report button

✓ PASS  sensor-delete-crash — 10 steps in 2.84s
```

Repros are disposable. They live in `.repros/`, and you delete them when the bug is fixed.

## Install

```bash
npm install -D fast-replay
npx playwright install chromium
```

Node >= 20.

## Use

```bash
repro record checkout-crash --url http://localhost:3000   # click the bug once
repro run checkout-crash                                  # bug still reproduces?
repro run checkout-crash --expect-fixed                   # did my fix work?
repro list
repro watch checkout-crash --expect-fixed                 # fix-verify loop
repro rm checkout-crash                                   # once it's fixed
```

`repro watch` holds the browser open and replays on Enter. Every `repro run` otherwise boots the app from a cold cache, which on a heavy single-page app costs several times the replay itself. It trades isolation for speed — state carries over between replays, so pair it with `--setup` if your flow changes anything.

**Delete a repro when its bug is fixed.** That is what makes this different from a test suite: a repro captures one bug and is finished the moment that bug is gone. Left behind, it rots against a moving app and becomes a test nobody meant to write. `repro run --expect-fixed` reminds you, and the MCP server exposes `repro_delete` so an agent can clean up after verifying its own fix.

Stop recording with **Ctrl/Cmd + Shift + X**, or just close the browser.

Exit `0` on pass, `1` on fail. On failure you get the failing step, what it does in plain language, expected vs observed, and `.repros/<name>/artifacts/` with a screenshot, console tail and network log.

| Flag | |
|---|---|
| `--expect-fixed` | pass when the bug no longer happens |
| `--env <url>` | replay a repro recorded elsewhere against this deployment |
| `--headed` | visible browser; some apps refuse headless |
| `--storage-state <file>` / `--profile <dir>` | get past a login |
| `--setup <cmd>` | reset state before replaying |
| `--timeout-scale <n>` | multiply recorded waits, for a slower machine |

`repro run` answers in terms of the bug — `BUG REPRODUCED` / `BUG DID NOT REPRODUCE`, and with `--expect-fixed`, `BUG FIXED` / `BUG STILL PRESENT`. A run that could not drive the app says `COULD NOT VERIFY` instead of passing judgement on the bug.

### Record on staging, verify on localhost

```bash
repro record checkout-crash --url https://staging.example.com
# fix the code, then:
repro run checkout-crash --env http://localhost:3000 --expect-fixed
```

`--env` moves `goto` steps, the app's own network patterns and the captured session onto the target origin. Sibling hosts (`api.example.com`) move with the app; third-party origins are left alone.

`-u` is the narrow version — it redirects navigation only, which leaves absolute network patterns unsatisfiable.

### Repairing a recording

A recording is a first draft. Repairing one used to mean hand-editing JSON:

```bash
repro fix my-bug --scale-timeouts 3 --min-timeout 8000
repro fix my-bug --relax-network --drop-wait 'role=img[name="Loading..."]'
repro fix my-bug --drop-step s4 --add-candidate 's2=[data-testid="save"]'

repro assert my-bug --fixed --appeared 'text=Total spend'
repro assert my-bug --fixed --focused '[data-testid="opener"]'
```

Every edit prints what it changed. `--drop-step` renumbers ids so they keep matching position.

## From a coding agent

```json
{ "mcpServers": { "replay": { "command": "npx", "args": ["repro-mcp"] } } }
```

`repro_run` returns the verdict, the failing step, console, network and **the page as an inline image** — in one call. Works with Claude Code, Codex, Gemini CLI, Cursor.

## What makes it fast

Replay never sleeps. Every wait is a signal the recording actually observed — a request settling, an element appearing or vanishing — so a step proceeds the instant the app reacts. Timeouts are derived from what was measured, not guessed.

The recording is JSON, not generated code. It is meant to be read and hand-edited.

```jsonc
{
  "id": "s5",
  "action": "click",
  "target": {
    "candidates": ["role=button[name=\"Delete Sensor 2\"]", "[data-testid=\"sensor-row-2\"] > button"],
    "semantic": "Delete Sensor 2 button in the row containing \"Sensor 2\""
  },
  "waitAfter": {
    "network": [{ "urlPattern": "/api/sensors/*", "method": "DELETE" }],
    "domGone": ["[data-testid=\"sensor-row-2\"]"],
    "timeoutMs": 3000
  }
}
```

Selectors are a ladder: test id → `name` → ARIA role + accessible name → labelled ancestor → stable CSS path → text. Build-generated class names are skipped, and a path unique only by sibling position ranks below the text anchor.

### Focus assertions

Every step records where focus came to rest (`step.focusedAfter`). Nothing asserts it automatically — copy it into the assertion when it is the thing you care about:

```jsonc
"assertion": { "expectedWhenFixed": { "focused": "[data-testid=\"currency-picker\"]" } }
```

Focus restoration (WCAG 2.4.3) leaves no console error, no failed request and no DOM difference, so it is invisible to every other signal — and a deterministic replayer settles it in one line.

## The technique that makes it work

**Do the irreversible part by hand. Record only the observation downstream of it.**

Almost every interesting bug sits behind state you cannot recreate on demand. Transfer the ownership, consume the invite, run the migration — once, manually. Then record the flow that *looks at* the result, which is cheap, deterministic and mutates nothing.

That split is what makes a repro replayable a hundred times, and it turns the single-shot limitation below from a disqualification into a normal part of authoring.

Recording programmatically is a first-class path, not a fallback:

```ts
import { record } from 'fast-replay';

await record({
  name: 'transfer-owner-lockout',
  baseUrl: 'https://staging.example.com',
  drive: async (page) => {
    // your setup already needs Playwright locators; reuse them here and
    // you get a durable artifact for free
  },
});
```

## Results

Measured on one machine, same flow both ways.

| | fast-replay | Playwright MCP |
|---|---|---|
| Per verification | **2.7 s** | ~24–32 s |
| Tool calls | **1** | 3–14 |
| Model calls | **0** | 1 per action |
| Context added | ~120 tokens | ~700–2 000 |

10-step flow: 20/20 consecutive replays, slowest 2.77 s.

Read that as the cost of *asking again*, not of the whole job — the setup behind a real bug dwarfs it. The point is that the setup is paid once and the question is paid every time.

The sharper claim is not speed. In a real app it caught a **736–779 ms** window where a total failed to render — a state that heals before a snapshot returns, so a model-in-the-loop tool structurally cannot see it. Two independent first passes with Playwright MCP concluded "no bug" and were wrong.

## Expectations

Honest limits, from six benchmark rounds against two production codebases (React Native Web; React + Vite + Radix):

- **If you already have a Playwright suite, keep using it.** Authoring a spec costs about what recording costs, and a spec is legible where an IR is not. This earns its keep for throwaway repros and agent loops, not as a test framework.
- **You still have to get to the bug yourself.** Recording captures the observation; reaching the state it observes is your problem. `repro auto` from a bug description is not built.
- **A bug with no console error or failed request needs one hand-written line** — `assertion.expectedWhenFixed` — or `--expect-fixed` refuses to answer rather than return a green that checked nothing.
- **A flow that mutates server state is single-shot.** Use `--setup` to reset, or `{{random:name}}` placeholders to make inputs unique.
- **It refuses rather than guesses.** If a selector resolves to something that is not what was recorded — a list that gained a row, so a positional match landed on the wrong record — the run reports `COULD NOT VERIFY` instead of a verdict. A wrong answer you have no reason to doubt is worse than no answer.
- Top frame only. No iframes. Drag-and-drop and file upload are untested.

## Programmatic

```ts
import { record, run, list } from 'fast-replay';

const result = await run({ name: 'my-bug', expectFixed: true });
if (!result.passed) console.log(result.failure.semantic, result.failure.artifacts.screenshot);
```

The CLI and MCP server are both thin wrappers over these.

## Develop

```bash
npm test          # 141 tests, unit + real-browser integration
npm run stress    # records once, replays 20x, fails on a single flake
npm run demo      # examples/demo-app
```

`src/recorder/agent/` runs inside the browser and is bundled by esbuild into `agent-bundle.generated.ts`. `npm run build:agent` regenerates it; a test fails if it goes stale.

MIT.
