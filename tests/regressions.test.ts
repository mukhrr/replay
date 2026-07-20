import { describe, expect, it } from 'vitest';
import { compile, deriveAssertion } from '../src/compiler/compile.js';
import { checkBugRecurred, checkInvariants } from '../src/replayer/invariants.js';
import { isStableClass, isStableToken } from '../src/recorder/agent/text.js';
import { isIncidentalRequest } from '../src/noise.js';
import { expandValue, hasPlaceholder } from '../src/replayer/values.js';
import type { Repro } from '../src/ir/schema.js';
import type { RawActionEvent, RecordingTrace } from '../src/recorder/types.js';

/**
 * Regressions found the first time this tool met a real codebase (Expensify).
 * Every one of these passed on the demo app and failed in production.
 */

const BASE = 'http://localhost:3000';

function trace(over: Partial<RecordingTrace> = {}): RecordingTrace {
  return {
    actions: [],
    dom: [],
    navigations: [],
    network: [],
    console: [],
    startedAt: 0,
    endedAt: 10_000,
    baseUrl: BASE,
    startPath: '/',
    viewport: { width: 1440, height: 900 },
    ...over,
  };
}

const action = (t: number): RawActionEvent => ({
  kind: 'action',
  action: 'click',
  value: null,
  target: { candidates: ['[data-testid="x"]'], semantic: 'x' },
  author: 'human',
  t,
});

describe('React Native Web atomic class hashes', () => {
  it('rejects them, so they never reach a CSS path', () => {
    // These change whenever styling changes. `r-1awozwy` previously passed as
    // stable because it has fewer than three digits.
    for (const c of ['r-1awozwy', 'r-1mdbw0j', 'r-13qz1uu', 'r-1e084wir']) {
      expect(isStableClass(c), `${c} must be rejected`).toBe(false);
    }
  });

  it('still keeps ordinary utility classes', () => {
    for (const c of ['sensor-row', 'btn-primary', 'col-2', 'mt-4', 'nav_link']) {
      expect(isStableClass(c), `${c} must be kept`).toBe(true);
    }
  });
});

describe('bug signature vs ambient console noise', () => {
  const ambient = [
    "Access to fetch at 'https://x/api/fl' has been blocked by CORS policy",
    'GET https://cdn.example.com/a.js net::ERR_NAME_NOT_RESOLVED',
    'Failed to load resource: the server responded with a status of 404',
    'Download the React DevTools for a better development experience',
  ];

  it('keeps environment noise out of the recorded bug signature', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(1_000)],
        console: ambient.map((text, i) => ({ kind: 'console' as const, text, t: 2_000 + i })),
      }),
    );
    // Otherwise --expect-fixed reports "bug still present" forever, and an
    // agent keeps editing code that was already correct.
    expect(assertion.observedAtRecord?.consoleErrors).toEqual([]);
    expect(assertion.invariants.noConsoleErrors).toBe(true);
  });

  it('ignores anything logged before the first action', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(5_000)],
        console: [{ kind: 'console', text: 'TypeError: boot noise', t: 1_000 }],
      }),
    );
    // Boot-time errors recur on every run regardless of the flow, so they are
    // useless as a signature for this particular bug.
    expect(assertion.observedAtRecord?.consoleErrors).toEqual([]);
  });

  it('still captures a real error caused by the flow', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(1_000)],
        console: [
          { kind: 'console', text: 'TypeError: cannot read id of undefined', t: 2_000 },
          { kind: 'console', text: ambient[0]!, t: 2_100 },
        ],
      }),
    );
    expect(assertion.observedAtRecord?.consoleErrors).toEqual([
      'TypeError: cannot read id of undefined',
    ]);
    expect(assertion.invariants.noConsoleErrors).toBe(false);
  });

  it('does not report a recurrence from ambient noise alone', () => {
    const repro = {
      assertion: {
        observedAtRecord: { consoleErrors: [], failedRequests: [] },
      },
      steps: [],
    } as unknown as Repro;

    const recurred = checkBugRecurred(
      repro,
      [],
      ambient.map((text, i) => ({ kind: 'console' as const, text, t: i })),
      BASE,
    );
    expect(recurred).toEqual([]);
  });
});

describe('noise filtering is symmetric', () => {
  // The regression: the compiler filtered ambient errors, saw an empty list,
  // and inferred "this app is clean" -> strictest invariants. The replayer then
  // checked RAW output, so the very errors that were correctly ignored while
  // recording failed every single replay. Fixing one side alone was worse than
  // filtering neither.
  it('does not fail a replay on the noise the compiler ignored', () => {
    const noisy = [
      "Access to fetch at 'https://x/api/fl' has been blocked by CORS policy",
      'GET https://api/x net::ERR_CONNECTION_REFUSED',
    ];

    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(1_000)],
        console: noisy.map((text, i) => ({ kind: 'console' as const, text, t: 2_000 + i })),
      }),
    );
    // Compiler sees nothing real, so it enables the strict invariant...
    expect(assertion.invariants.noConsoleErrors).toBe(true);

    // ...and the replayer must agree about what "nothing real" means.
    const repro = { assertion, steps: [] } as unknown as Repro;
    const violations = checkInvariants(
      repro,
      [],
      noisy.map((text, i) => ({ kind: 'console' as const, text, t: i })),
      BASE,
    );
    expect(violations).toEqual([]);
  });

  it('still fails on a real application error', () => {
    const assertion = deriveAssertion([], trace({ actions: [action(1_000)] }));
    const repro = { assertion, steps: [] } as unknown as Repro;
    const violations = checkInvariants(
      repro,
      [],
      [{ kind: 'console', text: 'TypeError: cannot read id of undefined', t: 1 }],
      BASE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.invariant).toBe('noConsoleErrors');
  });
});

describe('requests that must never become waits', () => {
  it('rejects content-hashed bundles, media and telemetry', () => {
    // A hashed chunk breaks on the next deploy AND on the next replay, because
    // the browser has it cached and never re-requests it.
    for (const url of [
      'http://localhost:3000/1661-6f603f9c5d59a3fb.bundle.js',
      'http://localhost:3000/favicon.png',
      'http://localhost:3000/static/main.css',
      'https://o1.ingest.sentry.io/api/123/envelope/',
      'https://www.google-analytics.com/collect',
    ]) {
      expect(isIncidentalRequest(url), url).toBe(true);
    }
  });

  it('keeps real API traffic', () => {
    for (const url of [
      'http://localhost:3000/api/sensors',
      'http://localhost:3000/api/Search_Save',
      'https://api.example.com/v2/reports',
    ]) {
      expect(isIncidentalRequest(url), url).toBe(false);
    }
  });
});

describe('per-session generated ids', () => {
  it('rejects a11y announcer ids that regenerate every load', () => {
    for (const t of ['zb5bjyh-aria', 'zb5bjyh-diff', 'ycwv2wx-aria']) {
      expect(isStableToken(t), t).toBe(false);
    }
  });

  it('keeps ids a human wrote', () => {
    for (const t of ['sensor-name', 'report-title', 'sidebar', 'button2', 'nav_link']) {
      expect(isStableToken(t), t).toBe(true);
    }
  });
});

describe('re-render churn', () => {
  it('drops a selector that goes on one step and returns on the next', () => {
    // A component re-mounting is not a state change. Replay sees the element
    // present throughout and can satisfy neither half of the pair.
    const repro = compile(
      trace({
        actions: [action(1_000), action(2_000)],
        dom: [
          { kind: 'dom', t: 1_100, appeared: [], gone: ['[data-testid="sidebar"]'] },
          { kind: 'dom', t: 2_100, appeared: ['[data-testid="sidebar"]'], gone: [] },
        ],
      }),
      { name: 'churn', storageStatePath: null },
    );

    expect(repro.steps[0]?.waitAfter.domGone ?? []).not.toContain('[data-testid="sidebar"]');
    expect(repro.steps[1]?.waitAfter.domAppeared ?? []).not.toContain('[data-testid="sidebar"]');
  });
});

describe('single-shot repros', () => {
  // A flow that mutates server state cannot be replayed twice as recorded: the
  // second run finds the work already done, so the bug cannot recur and
  // --expect-fixed returns green regardless of any fix. Unique inputs make each
  // replay create fresh state.
  it('expands placeholders to a different value every run', () => {
    const a = expandValue('merchant:walmart-{{random}}');
    const b = expandValue('merchant:walmart-{{random}}');
    expect(a).toMatch(/^merchant:walmart-\w+$/);
    expect(a).not.toBe(b);
  });

  it('leaves an unknown placeholder visible instead of blanking the field', () => {
    // A typo should surface in the failure message, not silently submit "".
    expect(expandValue('hello {{nope}}')).toBe('hello {{nope}}');
  });

  it('leaves ordinary values untouched', () => {
    expect(expandValue('Weekly rollup')).toBe('Weekly rollup');
    expect(expandValue(null)).toBeNull();
    expect(hasPlaceholder('Weekly rollup')).toBe(false);
    expect(hasPlaceholder('{{uuid}}')).toBe(true);
  });
});
