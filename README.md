# Replay

Record a bug once. Verify the fix in seconds.

You reproduce a bug in a browser one time, clicking through it while Replay records both what you did and how the app reacted. It compiles that into a deterministic replay script with an assertion. From then on you re-verify the whole flow after every code change in a couple of seconds instead of clicking through it again.

A ten-step flow replays in under three seconds.

This is **not** a test framework. Repros are disposable — they live in `.repros/`, and you delete them when the bug is fixed.

```
$ repro run sensor-delete-crash

STEP  ACTION  ACT   WAIT   TOTAL  WHAT
s1    fill    26ms  492ms  518ms  New sensor name textbox in the section labelled "Sensors"
s2    click   53ms  3ms    57ms   Add sensor button in the section labelled "Sensors"
s5    click   7ms   25ms   32ms   Delete Sensor 2 button in the row containing "Sensor 2"
s10   click   23ms  1.79s  1.81s  Generate report button

✓ PASS  sensor-delete-crash — 10 steps in 2.84s
```

## Install

Requires Node >= 20.

```bash
npm install -D replay-repro
npx playwright install chromium
```

Or without installing:

```bash
npx -p replay-repro repro record my-bug --url http://localhost:3000
```

## Commands

### `repro record <name> --url <baseUrl>`

Launches an instrumented Chromium. Reproduce the bug by hand, then press **Ctrl/Cmd + Shift + X** — or just close the browser. Writes `.repros/<name>.json`.

```bash
repro record sensor-delete-crash --url http://localhost:3000 --path /sensors
```

| Option | Default | |
|---|---|---|
| `-u, --url <baseUrl>` | required | your dev server |
| `-p, --path <startPath>` | `/` | where to start recording |
| `--viewport <WxH>` | `1440x900` | browser viewport |
| `--storage-state <file>` | — | seed cookies/localStorage from a Playwright state file, for apps behind a login |

Session state (cookies + localStorage) is snapshotted at the **start** of the recording into `.repros/<name>/state.json`, so replay begins from the same session you recorded from.

### `repro run <name>`

Replays the flow headless at machine speed and asserts the recorded outcome. Exit code `0` on pass, `1` on fail.

```bash
repro run sensor-delete-crash          # verify
repro run sensor-delete-crash --headed # watch it happen
repro run sensor-delete-crash -u http://localhost:4000
```

On failure it prints the failing step, what that step *meant* in plain language, what was expected, what actually happened — and writes `.repros/<name>/artifacts/`:

```
screenshot.png   full-page, at the moment of failure
console.log      last 50 console errors
network.log      every request since the previous step, with status and duration
failure.json     the same summary, machine-readable
```

### `repro list`

```
NAME                 STEPS  LAST RUN            AGE
sensor-delete-crash  10     fail at s5, 2m ago  1h
checkout-double-tax  6      pass (1.90s, 1d ago) 3d
```

## The IR

The recording is stored as JSON, not as generated Playwright code. It is meant to be read and hand-edited — if a selector is wrong, fix it in place.

```jsonc
{
  "version": 1,
  "name": "sensor-delete-crash",
  "createdAt": "2026-07-20T09:14:02.881Z",
  "baseUrl": "http://localhost:3000",
  "startPath": "/sensors",
  "viewport": { "width": 1440, "height": 900 },
  "storageStatePath": ".repros/sensor-delete-crash/state.json",

  "steps": [
    {
      "id": "s5",
      "action": "click",          // click dblclick fill press select goto scroll hover
      "value": null,              // payload for fill/press/select/goto/scroll
      "target": {
        // Tried in order at replay time. Highest-confidence first.
        "candidates": [
          "role=button[name=\"Delete Sensor 2\"]",
          "[data-testid=\"sensor-row-2\"] > button",
          "text=\"Delete\" >> nth=1"
        ],
        // Rule-based, from role + accessible name + nearest row/section label.
        // No LLM. Used in failure messages.
        "semantic": "Delete Sensor 2 button in the row containing \"Sensor 2\""
      },
      "waitAfter": {
        "network": [{ "urlPattern": "/api/sensors/*", "method": "DELETE" }],
        "domAppeared": ["[data-testid=\"confirm-toast\"]"],
        "domGone": ["[data-testid=\"sensor-row-2\"]"],
        "timeoutMs": 3000
      },
      "author": "human"           // "human" | "agent"
    }
  ],

  "assertion": {
    "mode": "expect-bug",
    "finalState": { "domAppeared": ["[data-testid=\"report-result\"]"] },
    "invariants": { "noConsoleErrors": true, "noFailedRequests": true },
    "observedAtRecord": { "consoleErrors": [], "failedRequests": [] }
  }
}
```

### Selector candidates

Generated in the page at capture time, while the element is still live, in this priority order:

1. `data-testid` / `data-test` / `data-cy`, or a stable `id`
2. ARIA role + accessible name — `role=button[name="Delete Sensor 2"]`
3. A CSS path built only from **stable** classes, anchored to the nearest test-id ancestor
4. A text anchor — `text="Delete"`

A class is treated as unstable, and skipped, if it looks build-generated: a CSS-in-JS prefix (`css-`, `sc-`, `emotion-`), a leading underscore, an embedded hex hash, three or more digits, or a mix of uppercase and digits (`Button_root__2Xy4z`).

Where a selector is ambiguous, `>> nth=N` is appended using the element's actual index at record time.

### Assertions and `observedAtRecord`

A repro captures the **bug**, and a bug is often *itself* a console error or a failed request. So invariants are derived from what the recording actually observed: if the recording threw a `TypeError`, `noConsoleErrors` is written as `false` and the error text is preserved under `observedAtRecord`.

Without this a repro of a crash would fail its own replay the moment you recorded it. The evidence is kept rather than discarded because the forthcoming `--expect-fixed` mode asserts exactly that it no longer occurs.

`noFailedRequests` is scoped to URL patterns seen at record time, so a third-party analytics beacon returning 404 can never fail your repro.

## How waits work

Replay never sleeps. Every wait is on a signal the recording actually observed, so a step completes the instant the app reacts. That is where the speed comes from — the 1.5s endpoint in the demo app costs 1.79s on replay, not a padded fixed delay.

**Recording.** After each action, Replay watches the environment until the next action and keeps:

- **Network** — requests that started within **500 ms** of the action *and* settled before the next one. URLs are normalized, with volatile path segments (numeric ids, UUIDs, long tokens) collapsed to `*`, so `/api/sensors/4` becomes `/api/sensors/*`. Query strings are dropped.
- **DOM** — elements that appeared or disappeared, via a `MutationObserver`, within **5 s**. Only elements with a high-priority selector are kept, and only ones that are actually rendered — an `<option>` inside a `<select>` has no layout box, so waiting for it to become visible would hang.
- Anything that appeared *and* vanished inside the same window is discarded as a flicker (spinners, transient re-renders).

If an action produced no observable reaction at all, `waitAfter` becomes `{ "timeoutMs": 2000, "networkIdle": true }`.

**The timeout is derived from what was measured**, not from a fixed default: three times the observed settle time, rounded to 500 ms, clamped to 3–15 s. A slow endpoint earns a generous ceiling; a fast one fails quickly instead of hanging.

**Replay.** For each step:

1. Try each selector candidate in order — **800 ms** for the first, **400 ms** for each fallback. All of them failing is a hard failure. Phase 0 does no healing; it reports the semantic description so you know what the step meant.
2. Perform the action.
3. Wait on every recorded signal **concurrently**, with `timeoutMs` as a single ceiling across all of them:
   - `network` — polls a buffer that has been recording since before the action, so a request that settles faster than we can attach a listener is not missed
   - `domAppeared` — element becomes visible
   - `domGone` — element becomes hidden *or* detached, covering both unmount and CSS-hide

Any signal that never arrives is named individually in the failure output.

## Programmatic API

The CLI is a thin wrapper over these — the same functions the forthcoming MCP server wraps.

```ts
import { record, run, list } from 'replay-repro';

await record({ name: 'my-bug', baseUrl: 'http://localhost:3000' });

const result = await run({ name: 'my-bug' });
if (!result.passed) {
  console.log(result.failure.semantic, result.failure.artifacts.screenshot);
}

for (const r of await list()) console.log(r.name, r.lastResult?.status);
```

`record()` also accepts a `drive(page)` callback that takes over the browser programmatically instead of waiting for a human. Capture is identical either way — that seam is how agent-authored repros will produce the same IR.

## Demo app

`examples/demo-app` is a small Vite + React app with a list with add/delete, a form with async submit, a route change, and one deliberately slow (1.5 s) endpoint.

```bash
npm --prefix examples/demo-app install
npm run demo      # http://localhost:5173
```

```bash
npm test          # unit + record/replay integration tests
npm run stress    # records once, replays 20x, reports p50/p95/slowest
```

The stress script fails on a single flake rather than on a success rate — a repro you cannot trust is worse than no repro.

## Scope

Phase 0 deliberately does **not** include: LLM calls of any kind, self-healing selectors, assertion generation, watch mode, API mocking (network is recorded as metadata; replay runs against your live dev server), or any cloud/account/telemetry.

Recording captures the **top frame only**; actions inside iframes are not recorded. Hover is in the IR vocabulary and is recorded when it is load-bearing — when hovering revealed the content you then acted on, as with a hover-to-open menu — but incidental mouse travel is not.

The accessible-name computation is a pragmatic subset of the accname spec (`aria-label` → `aria-labelledby` → associated `<label>` → `alt`/`title`/`placeholder` → text content for name-from-content roles), not the full algorithm. The candidate list degrades to a CSS path or text anchor when it falls short.
