import { describe, expect, it } from 'vitest';
import { compile, deriveAssertion } from '../src/compiler/compile.js';
import { checkBugRecurred, checkInvariants } from '../src/replayer/invariants.js';
import { isStableClass, isStableToken } from '../src/recorder/agent/text.js';
import { isIncidentalRequest } from '../src/noise.js';
import {
  isSameApplication,
  retargetRepro,
  retargetStorageState,
} from '../src/replayer/retarget.js';
import { createExpander, hasPlaceholder } from '../src/replayer/values.js';
import type { Repro } from '../src/ir/schema.js';
import type { RawActionEvent, RecordingTrace } from '../src/recorder/types.js';
import { pathOf } from '../src/recorder/attach.js';

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
    documentLoads: [],
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
    const a = createExpander().expand('merchant:walmart-{{random}}');
    const b = createExpander().expand('merchant:walmart-{{random}}');
    expect(a).toMatch(/^merchant:walmart-\w+$/);
    expect(a).not.toBe(b);
  });

  it('resolves a NAMED placeholder identically across one run', () => {
    // A unique input changes the accessible names derived from it, so the
    // selectors and waits that embedded the old value have to move with it.
    const run1 = createExpander();
    const value = run1.expand('Boiler-{{random:sensor}}');
    const wait = run1.expand('role=button[name="Delete Boiler-{{random:sensor}}"]');
    expect(wait).toBe(`role=button[name="Delete ${value}"]`);

    // ...and differently on the next run, which is the entire point.
    expect(createExpander().expand('Boiler-{{random:sensor}}')).not.toBe(value);
  });

  it('keeps anonymous placeholders independent', () => {
    const e = createExpander();
    expect(e.expand('{{random}}')).not.toBe(e.expand('{{random}}'));
  });

  it('leaves an unknown placeholder visible instead of blanking the field', () => {
    // A typo should surface in the failure message, not silently submit "".
    expect(createExpander().expand('hello {{nope}}')).toBe('hello {{nope}}');
  });

  it('leaves ordinary values untouched', () => {
    const e = createExpander();
    expect(e.expand('Weekly rollup')).toBe('Weekly rollup');
    expect(e.expand(null)).toBeNull();
    expect(hasPlaceholder('Weekly rollup')).toBe(false);
    expect(hasPlaceholder('{{uuid}}')).toBe(true);
  });
});

describe('hash-routed apps', () => {
  const BASE_URL = 'http://localhost:3006';

  it('keeps the fragment, which is the whole route', () => {
    // Dropping it recorded "/app.html" for "/app.html#/sensors", so every
    // replay opened the default screen and failed on step one for a reason
    // unrelated to the bug.
    expect(pathOf(`${BASE_URL}/app.html#/sensors`, BASE_URL)).toBe('/app.html#/sensors');
    expect(pathOf(`${BASE_URL}/app.html#/sensors?tab=graph`, BASE_URL)).toBe(
      '/app.html#/sensors?tab=graph',
    );
  });

  it('leaves plain paths alone', () => {
    expect(pathOf(`${BASE_URL}/app.html`, BASE_URL)).toBe('/app.html');
    expect(pathOf(`${BASE_URL}/`, BASE_URL)).toBe('/');
  });
});

describe('pdu_html round: recorder', () => {
  it('never lets a resize-detector probe scroll become a step', async () => {
    // element-resize-detector scrolls an offscreen probe during layout. It was
    // recorded as author:"human" and ordered BEFORE the goto that creates the
    // page, so its selector could never resolve and step one always failed.
    const { chromium } = await import('playwright');
    const { agentSource } = await import('../src/recorder/instrument.js');
    const { DEFAULT_AGENT_CONFIG } = await import('../src/recorder/agent/config.js');

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const captured: { action?: string }[] = [];
      await context.exposeBinding(DEFAULT_AGENT_CONFIG.emitBinding, (_s, ev) => {
        captured.push(ev as { action?: string });
      });
      const page = await context.newPage();
      await page.setContent(`
        <div class="erd_scroll_detection_container" style="overflow:auto;height:40px">
          <div style="height:400px"></div>
        </div>
        <div id="real" style="overflow:auto;height:40px"><div style="height:400px"></div></div>
      `);
      await page.evaluate(agentSource(DEFAULT_AGENT_CONFIG));

      await page.evaluate(() => {
        document.querySelector('.erd_scroll_detection_container')!.scrollTop = 300;
        document.getElementById('real')!.scrollTop = 300;
      });
      await new Promise((r) => setTimeout(r, 500));

      const scrolls = captured.filter((e) => e.action === 'scroll');
      expect(scrolls.length, 'the probe scroll must not be recorded').toBe(1);
    } finally {
      await browser.close();
    }
  });

  it('records one click when a label forwards to its control', async () => {
    // Radix/MUI checkboxes dispatch twice for one physical click. Replaying
    // both toggles it back, silently running a different flow than recorded.
    const { chromium } = await import('playwright');
    const { agentSource } = await import('../src/recorder/instrument.js');
    const { DEFAULT_AGENT_CONFIG } = await import('../src/recorder/agent/config.js');

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const clicks: unknown[] = [];
      await context.exposeBinding(DEFAULT_AGENT_CONFIG.emitBinding, (_s, ev) => {
        if ((ev as { action?: string }).action === 'click') clicks.push(ev);
      });
      const page = await context.newPage();
      await page.setContent(
        '<label><button type="button" id="cb">x</button><span>Board Device</span></label>',
      );
      await page.evaluate(agentSource(DEFAULT_AGENT_CONFIG));

      await page.click('span');
      await new Promise((r) => setTimeout(r, 300));
      expect(clicks.length).toBe(1);
    } finally {
      await browser.close();
    }
  });
});

describe('pdu_html v2: one gesture, one click', () => {
  const withAgent = async (html: string, drive: (p: import('playwright').Page) => Promise<void>) => {
    const { chromium } = await import('playwright');
    const { agentSource } = await import('../src/recorder/instrument.js');
    const { DEFAULT_AGENT_CONFIG } = await import('../src/recorder/agent/config.js');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const clicks: unknown[] = [];
      await context.exposeBinding(DEFAULT_AGENT_CONFIG.emitBinding, (_s, ev) => {
        if ((ev as { action?: string }).action === 'click') clicks.push(ev);
      });
      const page = await context.newPage();
      await page.setContent(html);
      await page.evaluate(agentSource(DEFAULT_AGENT_CONFIG));
      await drive(page);
      await new Promise((r) => setTimeout(r, 250));
      return clicks;
    } finally {
      await browser.close();
    }
  };

  const RADIX = `
    <button id="trigger"><span id="inner">Group by</span></button>
    <script>
      const t = document.getElementById('trigger');
      let f = false;
      t.addEventListener('pointerdown', () => {
        if (f) return; f = true;
        t.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
        f = false;
      });
    </script>`;

  it('records exactly one click when a menu primitive re-dispatches its own', async () => {
    const clicks = await withAgent(RADIX, (p) => p.click('#trigger'));
    expect(clicks).toHaveLength(1);
  });

  it('records exactly one click when a label forwards to its control', async () => {
    const clicks = await withAgent(
      '<label><button id="cb">c</button><span id="t">Board Device</span></label>',
      (p) => p.click('#t'),
    );
    expect(clicks).toHaveLength(1);
  });

  it('still records two genuine clicks on the same button', async () => {
    // The earlier attempt at echo suppression ate the second "Add" click.
    const clicks = await withAgent('<button id="add">Add</button>', async (p) => {
      await p.click('#add');
      await p.waitForTimeout(150);
      await p.click('#add');
    });
    expect(clicks).toHaveLength(2);
  });

  it('never lets suppression leave a gesture with no step at all', async () => {
    // If the first copy is dropped for having no usable selector, the second
    // must still record. Zero is worse than a duplicate: nothing in the
    // artifact shows the gesture happened, and replay fails somewhere later.
    const clicks = await withAgent(
      `<div id="host"></div>
       <script>
         // A shadow-hosted node the outer document cannot address, forwarding
         // to a plain button.
         const host = document.getElementById('host');
         const root = host.attachShadow({ mode: 'open' });
         root.innerHTML = '<span id="ghost">x</span>';
         const real = document.createElement('button');
         real.id = 'real'; real.textContent = 'Real';
         document.body.appendChild(real);
         root.getElementById('ghost').addEventListener('click', () => real.click());
       </script>`,
      (p) => p.click('#host'),
    );
    expect(clicks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('pdu_html v2: flaky boot noise', () => {
  it('classifies boot noise the same way however early the recording starts', () => {
    // The reported nondeterminism: identical errors landed in opposite buckets
    // depending on whether the driver clicked before or after they fired. One
    // ordering treated the app's own chatter as the bug's signature.
    const noise = 'Cannot download en.json file. Use fallback file.';
    const early = deriveAssertion(
      [],
      trace({
        actions: [action(1_000)],
        console: [{ kind: 'console', text: noise, t: 9_000 }],
      }),
    );
    const late = deriveAssertion(
      [],
      trace({
        actions: [action(9_000)],
        console: [{ kind: 'console', text: noise, t: 1_000 }],
      }),
    );
    for (const a of [early, late]) {
      expect(a.observedAtRecord?.ambientConsoleErrors).toEqual([noise]);
      expect(a.observedAtRecord?.consoleErrors).toEqual([]);
    }
  });

  it('still credits an error that lands in an action’s wake', () => {
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(1_000)],
        console: [{ kind: 'console', text: 'TypeError: boom', t: 1_400 }],
      }),
    );
    expect(assertion.observedAtRecord?.consoleErrors).toEqual(['TypeError: boom']);
    expect(assertion.observedAtRecord?.ambientConsoleErrors).toEqual([]);
  });

  it('treats an error that also fires unprompted as noise', () => {
    const flaky = 'Cannot download en.json file.';
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(5_000)],
        console: [
          { kind: 'console', text: flaky, t: 1_000 },
          { kind: 'console', text: flaky, t: 5_200 },
        ],
      }),
    );
    expect(assertion.observedAtRecord?.consoleErrors).toEqual([]);
  });

  it('does not infer a strict invariant from one lucky recording', () => {
    // The app logs "Cannot download en.json" on SOME loads. A recording that
    // happened to miss it inferred noConsoleErrors: true, and the next replay
    // hit the error and hard-failed. Same app, same flow, opposite verdict
    // depending on recording luck.
    const assertion = deriveAssertion(
      [],
      trace({
        actions: [action(5_000)],
        console: [{ kind: 'console', text: 'Cannot download en.json file.', t: 1_000 }],
      }),
    );
    expect(assertion.invariants.noConsoleErrors).toBe(false);
    expect(assertion.observedAtRecord?.ambientConsoleErrors).toEqual([
      'Cannot download en.json file.',
    ]);
  });

  it('subtracts the app’s own boot noise at replay time', () => {
    const assertion = deriveAssertion([], trace({ actions: [action(1_000)] }));
    assertion.invariants.noConsoleErrors = true;
    assertion.observedAtRecord!.ambientConsoleErrors = ['Cannot download en.json file.'];
    const repro = { assertion, steps: [] } as unknown as Repro;

    const violations = checkInvariants(
      repro,
      [],
      [{ kind: 'console', text: 'Cannot download en.json file. Use fallback file.', t: 1 }],
      BASE,
    );
    expect(violations).toEqual([]);
  });

  it('stays silent about a genuinely quiet app', () => {
    const assertion = deriveAssertion([], trace({ actions: [action(1_000)] }));
    expect(assertion.invariants.noConsoleErrors).toBe(true);
    expect(assertion.observedAtRecord?.ambientConsoleErrors).toEqual([]);
  });
});

describe('pdu_html v3: click retargeted by a portal', () => {
  it('records the control the user aimed at, not the document root', async () => {
    // Radix opens on pointerdown and portals content over the cursor, so
    // pointerup lands elsewhere and the browser dispatches the click on the
    // common ancestor — <body>, or <html> when the portal is a sibling. <html>
    // has no selector at all, so the gesture disappeared from the recording.
    const { chromium } = await import('playwright');
    const { agentSource } = await import('../src/recorder/instrument.js');
    const { DEFAULT_AGENT_CONFIG } = await import('../src/recorder/agent/config.js');

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const clicks: { target?: { candidates: string[] } }[] = [];
      await context.exposeBinding(DEFAULT_AGENT_CONFIG.emitBinding, (_s, ev) => {
        if ((ev as { action?: string }).action === 'click') {
          clicks.push(ev as { target?: { candidates: string[] } });
        }
      });
      const page = await context.newPage();
      await page.setContent(`
        <button id="trigger" style="position:absolute;top:20px;left:20px">
          <span id="inner">Group by</span>
        </button>
        <script>
          document.getElementById('trigger').addEventListener('pointerdown', () => {
            const o = document.createElement('div');
            o.style.cssText = 'position:fixed;inset:0;z-index:9999';
            document.body.appendChild(o);
          });
        </script>`);
      await page.evaluate(agentSource(DEFAULT_AGENT_CONFIG));

      await page.click('#inner');
      await new Promise((r) => setTimeout(r, 300));

      expect(clicks, 'the gesture must not vanish').toHaveLength(1);
      // Not "body" — the element the user actually pressed.
      expect(clicks[0]?.target?.candidates[0]).toBe('#inner');
    } finally {
      await browser.close();
    }
  });
});

describe('--env retargeting', () => {
  const STAGING = 'https://staging.new.example.com';
  const LOCAL = 'https://dev.new.example.com:8082';

  const base = (): Repro =>
    ({
      version: 1,
      name: 'r',
      createdAt: new Date(0).toISOString(),
      baseUrl: STAGING,
      startPath: '/home',
      viewport: { width: 800, height: 600 },
      storageStatePath: null,
      steps: [
        {
          id: 's1',
          action: 'click',
          value: null,
          target: { candidates: ['#x'], semantic: 'x' },
          author: 'human',
          waitAfter: {
            timeoutMs: 3000,
            network: [
              // The app's API on a sibling host, and a genuine third party.
              { urlPattern: 'https://staging.example.com/api/Save', method: 'POST' },
              { urlPattern: 'https://cdn.other.com/track', method: 'GET' },
              { urlPattern: '/api/Local', method: 'GET' },
            ],
          },
        },
      ],
      assertion: {
        mode: 'expect-bug',
        finalState: {},
        invariants: { noConsoleErrors: false, noFailedRequests: false },
      },
    }) as unknown as Repro;

  it('strips the origin from the app’s own patterns so they match at the target', () => {
    // An absolute staging pattern can never match a same-origin dev proxy, so
    // every network wait recorded against staging failed locally.
    const out = retargetRepro(base(), LOCAL);
    const patterns = out.steps[0]!.waitAfter.network!.map((n) => n.urlPattern);
    expect(patterns).toContain('/api/Save');
    expect(patterns).toContain('/api/Local');
  });

  it('leaves third-party origins alone', () => {
    // Rewriting these would point someone else's traffic at your dev server.
    const out = retargetRepro(base(), LOCAL);
    expect(out.steps[0]!.waitAfter.network!.map((n) => n.urlPattern)).toContain(
      'https://cdn.other.com/track',
    );
  });

  it('moves the session onto the target origin', () => {
    // Cookies and localStorage are origin-keyed: restored unchanged, they
    // authenticate the environment that was recorded and leave the target
    // signed out, which reads as a bug in the app rather than the setup.
    const moved = retargetStorageState(
      {
        cookies: [
          { name: 'session', value: 'a', domain: '.example.com' },
          { name: 'ads', value: 'b', domain: '.other.com' },
        ],
        origins: [
          { origin: STAGING, localStorage: [{ name: 'k', value: 'v' }] },
          { origin: 'https://cdn.other.com', localStorage: [] },
        ],
      },
      STAGING,
      LOCAL,
    );

    expect(moved.cookies!.find((c) => c.name === 'session')!.domain).toBe('dev.new.example.com');
    expect(moved.cookies!.find((c) => c.name === 'ads')!.domain).toBe('.other.com');
    expect(moved.origins!.map((o) => o.origin)).toEqual([LOCAL, 'https://cdn.other.com']);
  });

  it('treats sibling hosts as the same app and unrelated ones as third party', () => {
    expect(isSameApplication('https://staging.example.com', STAGING)).toBe(true);
    expect(isSameApplication('https://cdn.other.com', STAGING)).toBe(false);
    expect(isSameApplication('http://localhost:3000', 'http://localhost:8080')).toBe(true);
  });
});
