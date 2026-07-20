import { describe, expect, it } from 'vitest';
import { compile, deriveAssertion } from '../src/compiler/compile.js';
import { matchesUrlPattern, normalizeUrlPattern } from '../src/compiler/normalize.js';
import { buildWaitAfter, DEFAULT_WAIT_RULES } from '../src/compiler/waits.js';
import { parseRepro } from '../src/ir/schema.js';
import type { RawActionEvent, RecordingTrace } from '../src/recorder/types.js';

const BASE = 'http://localhost:3000';

function action(over: Partial<RawActionEvent> & { t: number }): RawActionEvent {
  return {
    kind: 'action',
    action: 'click',
    value: null,
    target: { candidates: ['[data-testid="x"]'], semantic: 'x button' },
    author: 'human',
    ...over,
  };
}

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

describe('normalizeUrlPattern', () => {
  it('collapses volatile identifiers to a wildcard', () => {
    expect(normalizeUrlPattern(`${BASE}/api/sensors/4`, BASE)).toBe('/api/sensors/*');
    expect(
      normalizeUrlPattern(`${BASE}/api/u/3f8a1b2c-1111-2222-3333-444455556666/edit`, BASE),
    ).toBe('/api/u/*/edit');
    expect(normalizeUrlPattern(`${BASE}/api/sensors`, BASE)).toBe('/api/sensors');
  });

  it('drops the query string, which is mostly cache-busters', () => {
    expect(normalizeUrlPattern(`${BASE}/api/x?t=1699999`, BASE)).toBe('/api/x');
  });

  it('keeps the origin for third-party traffic so it stays distinguishable', () => {
    expect(normalizeUrlPattern('https://cdn.example.com/a.js', BASE)).toBe(
      'https://cdn.example.com/a.js',
    );
  });

  it('matches a live URL against a recorded pattern in both directions', () => {
    expect(matchesUrlPattern(`${BASE}/api/sensors/9`, '/api/sensors/*', BASE)).toBe(true);
    // A repro recorded against :3000 must still run against :5199.
    expect(matchesUrlPattern('http://localhost:5199/api/sensors/9', '/api/sensors/*', BASE)).toBe(
      false,
    );
    expect(matchesUrlPattern(`${BASE}/api/other`, '/api/sensors', BASE)).toBe(false);
  });
});

describe('buildWaitAfter', () => {
  const net = (over: Partial<Parameters<typeof buildWaitAfter>[0]['network'][number]>) => ({
    kind: 'network' as const,
    method: 'POST',
    url: `${BASE}/api/sensors`,
    startedAt: 1_000,
    settledAt: 1_200,
    status: 201,
    failed: false,
    ...over,
  });

  it('includes a request only when the action plausibly triggered it', () => {
    const wait = buildWaitAfter({
      actionAt: 1_000,
      windowEnd: 5_000,
      baseUrl: BASE,
      dom: [],
      network: [net({}), net({ startedAt: 4_000, settledAt: 4_100, url: `${BASE}/api/late` })],
    });
    expect(wait.network).toEqual([{ urlPattern: '/api/sensors', method: 'POST' }]);
  });

  it('ignores a request that never settled', () => {
    const wait = buildWaitAfter({
      actionAt: 1_000,
      windowEnd: 5_000,
      baseUrl: BASE,
      dom: [],
      network: [net({ settledAt: null })],
    });
    expect(wait.network).toBeUndefined();
    expect(wait.networkIdle).toBe(true);
  });

  it('falls back to network idle when nothing reacted', () => {
    const wait = buildWaitAfter({
      actionAt: 1_000,
      windowEnd: 2_000,
      baseUrl: BASE,
      dom: [],
      network: [],
    });
    expect(wait).toEqual({ timeoutMs: DEFAULT_WAIT_RULES.emptyTimeoutMs, networkIdle: true });
  });

  it('discards an element that appeared and vanished in the same window', () => {
    const wait = buildWaitAfter({
      actionAt: 1_000,
      windowEnd: 5_000,
      baseUrl: BASE,
      network: [],
      dom: [
        { kind: 'dom', t: 1_100, appeared: ['#spinner', '#result'], gone: [] },
        { kind: 'dom', t: 1_900, appeared: [], gone: ['#spinner'] },
      ],
    });
    // #spinner flickered; only #result is a dependable signal.
    expect(wait.domAppeared).toEqual(['#result']);
    expect(wait.domGone ?? []).not.toContain('#spinner');
  });

  it('scales the timeout to what was actually observed', () => {
    const fast = buildWaitAfter({
      actionAt: 1_000,
      windowEnd: 9_000,
      baseUrl: BASE,
      dom: [],
      network: [net({ settledAt: 1_050 })],
    });
    const slow = buildWaitAfter({
      actionAt: 1_000,
      windowEnd: 9_000,
      baseUrl: BASE,
      dom: [],
      network: [net({ settledAt: 2_500 })],
    });
    expect(fast.timeoutMs).toBe(DEFAULT_WAIT_RULES.minTimeoutMs);
    expect(slow.timeoutMs).toBeGreaterThan(fast.timeoutMs);
    expect(slow.timeoutMs).toBeLessThanOrEqual(DEFAULT_WAIT_RULES.maxTimeoutMs);
  });
});

describe('compile', () => {
  it('drops the clicks the browser fires before a dblclick', () => {
    const repro = compile(
      trace({
        actions: [
          action({ t: 1_000 }),
          action({ t: 1_100 }),
          action({ t: 1_150, action: 'dblclick' }),
        ],
      }),
      { name: 'dbl', storageStatePath: null },
    );
    expect(repro.steps.map((s) => s.action)).toEqual(['dblclick']);
  });

  it('treats a navigation caused by a click as that click’s reaction', () => {
    const repro = compile(
      trace({
        actions: [action({ t: 1_000 })],
        navigations: [{ kind: 'navigation', url: `${BASE}/next`, t: 1_050 }],
      }),
      { name: 'nav', storageStatePath: null },
    );
    expect(repro.steps.map((s) => s.action)).toEqual(['click']);
  });

  it('records an unexplained navigation as its own goto step', () => {
    const repro = compile(
      trace({
        actions: [action({ t: 1_000 })],
        navigations: [{ kind: 'navigation', url: `${BASE}/typed`, t: 8_000 }],
      }),
      { name: 'nav2', storageStatePath: null },
    );
    expect(repro.steps.map((s) => s.action)).toEqual(['click', 'goto']);
  });

  it('collapses a run of scrolls to the final position', () => {
    const scroll = (t: number, y: number) =>
      action({ t, action: 'scroll', value: JSON.stringify({ x: 0, y }), target: null });
    const repro = compile(trace({ actions: [scroll(1_000, 100), scroll(1_200, 400)] }), {
      name: 'scroll',
      storageStatePath: null,
    });
    expect(repro.steps).toHaveLength(1);
    expect(repro.steps[0]?.value).toBe(JSON.stringify({ x: 0, y: 400 }));
  });

  it('produces IR that satisfies its own schema', () => {
    const repro = compile(trace({ actions: [action({ t: 1_000 })] }), {
      name: 'valid',
      storageStatePath: '.repros/valid/state.json',
    });
    expect(() => parseRepro(JSON.parse(JSON.stringify(repro)), 'valid.json')).not.toThrow();
  });
});

describe('deriveAssertion', () => {
  it('keeps invariants on when the recording was clean', () => {
    const assertion = deriveAssertion([], trace());
    expect(assertion.mode).toBe('expect-bug');
    expect(assertion.invariants).toEqual({ noConsoleErrors: true, noFailedRequests: true });
  });

  it('switches off an invariant the recording itself violated', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        console: [{ kind: 'console', text: 'TypeError: boom', t: 1_000 }],
        network: [
          {
            kind: 'network',
            method: 'DELETE',
            url: `${BASE}/api/sensors/4`,
            startedAt: 1_000,
            settledAt: 1_100,
            status: 500,
            failed: true,
          },
        ],
      }),
    );

    // Otherwise a repro of a crash would fail its own replay on day one.
    expect(assertion.invariants.noConsoleErrors).toBe(false);
    expect(assertion.invariants.noFailedRequests).toBe(false);

    // The evidence survives for --expect-fixed to assert against later.
    expect(assertion.observedAtRecord?.consoleErrors).toEqual(['TypeError: boom']);
    expect(assertion.observedAtRecord?.failedRequests).toEqual([
      { urlPattern: '/api/sensors/*', method: 'DELETE', status: 500 },
    ]);
  });

  it('does not let a third-party failure disable the invariant', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        network: [
          {
            kind: 'network',
            method: 'GET',
            url: 'https://analytics.example.com/beacon',
            startedAt: 1_000,
            settledAt: 1_100,
            status: 404,
            failed: true,
          },
        ],
      }),
    );
    expect(assertion.invariants.noFailedRequests).toBe(true);
    expect(assertion.observedAtRecord?.failedRequests).toEqual([]);
  });
});

describe('schema', () => {
  it('reports every problem in a corrupted IR at once', () => {
    expect(() => parseRepro({ version: 1, name: 'x' }, 'x.json')).toThrow(/Invalid repro IR/);
    try {
      parseRepro({ version: 1, name: 'x', steps: 'nope' }, 'x.json');
    } catch (err) {
      expect((err as Error).message).toContain('steps');
      expect((err as Error).message).toContain('baseUrl');
    }
  });

  it('defaults author to human so an agent-authored step is opt-in', () => {
    const repro = parseRepro(
      {
        version: 1,
        name: 'x',
        createdAt: new Date().toISOString(),
        baseUrl: BASE,
        viewport: { width: 800, height: 600 },
        steps: [{ id: 's1', action: 'click', waitAfter: { timeoutMs: 1_000 } }],
        assertion: { finalState: {}, invariants: {} },
      },
      'x.json',
    );
    expect(repro.steps[0]?.author).toBe('human');
    expect(repro.assertion.mode).toBe('expect-bug');
  });
});
