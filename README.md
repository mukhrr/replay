# fast-replay

[![CI](https://github.com/mukhrr/fast-replay/actions/workflows/ci.yml/badge.svg)](https://github.com/mukhrr/fast-replay/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fast-replay)](https://www.npmjs.com/package/fast-replay)

Record a browser bug once. Verify the fix in seconds, with no model in the loop.

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
```

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

### Record on staging, verify on localhost

```bash
repro record checkout-crash --url https://staging.example.com
# fix the code, then:
repro run checkout-crash --env http://localhost:3000 --expect-fixed
```

`--env` moves `goto` steps, the app's own network patterns and the captured session onto the target origin. Sibling hosts (`api.example.com`) move with the app; third-party origins are left alone.

`-u` is the narrow version — it redirects navigation only, which leaves absolute network patterns unsatisfiable.

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

## Results

Measured on one machine, same flow both ways.

| | fast-replay | Playwright MCP |
|---|---|---|
| Per verification | **2.7 s** | ~24–32 s |
| Tool calls | **1** | 3–14 |
| Model calls | **0** | 1 per action |
| Context added | ~120 tokens | ~700–2 000 |

10-step flow: 20/20 consecutive replays, slowest 2.77 s.

The sharper claim is not speed. In a real app it caught a **736–779 ms** window where a total failed to render — a state that heals before a snapshot returns, so a model-in-the-loop tool structurally cannot see it. Two independent first passes with Playwright MCP concluded "no bug" and were wrong.

## Expectations

Honest limits, from six benchmark rounds against two production codebases (React Native Web; React + Vite + Radix):

- **If you already have a Playwright suite, keep using it.** Authoring a spec costs about what recording costs, and a spec is legible where an IR is not. This earns its keep for throwaway repros and agent loops, not as a test framework.
- **Recording is a human clicking once.** Driving it programmatically means writing Playwright locators, which defeats the point. `repro auto` from a bug description is not built.
- **A bug with no console error or failed request needs one hand-written line** — `assertion.expectedWhenFixed` — or `--expect-fixed` refuses to answer rather than return a green that checked nothing.
- **A flow that mutates server state is single-shot.** Use `--setup` to reset, or `{{random:name}}` placeholders to make inputs unique.
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
npm test          # 117 tests, unit + real-browser integration
npm run stress    # records once, replays 20x, fails on a single flake
npm run demo      # examples/demo-app
```

`src/recorder/agent/` runs inside the browser and is bundled by esbuild into `agent-bundle.generated.ts`. `npm run build:agent` regenerates it; a test fails if it goes stale.

MIT.
