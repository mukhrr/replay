import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readRepro, record, reproPaths, run } from '../src/api.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';
import { demoBugFlow } from './helpers/flow.js';

/**
 * The mitigations for single-shot repros — flows that mutate server state and
 * therefore cannot be replayed twice as recorded.
 *
 * These matter more than they look. If they silently do nothing, a developer
 * looping on `--expect-fixed` gets green from run 2 onward whether or not they
 * fixed anything, and never learns that the check stopped meaning something.
 */

let server: DemoServer;
let root: string;

beforeAll(async () => {
  server = await startDemoServer(5270);
  root = await mkdtemp(path.join(tmpdir(), 'replay-mitigation-'));
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await server.reset();
});

const recordFlow = (name: string) =>
  record({ name, baseUrl: server.baseUrl, root, headless: true, drive: demoBugFlow });

describe('--setup', () => {
  it('runs the command before the browser opens', async () => {
    await recordFlow('setup-ok');
    await server.reset();

    const marker = path.join(root, 'setup-ran.txt');
    const result = await run({
      name: 'setup-ok',
      root,
      setupCommand: `printf ran > ${JSON.stringify(marker)}`,
    });

    expect(existsSync(marker), 'setup command should have run').toBe(true);
    expect(await readFile(marker, 'utf8')).toBe('ran');
    expect(result.passed).toBe(true);
  });

  it('aborts the run when setup fails, rather than replaying against bad state', async () => {
    await recordFlow('setup-fail');
    // A reset that did not happen means the replay would run against whatever
    // the previous run left behind, and any verdict from that is meaningless.
    await expect(
      run({ name: 'setup-fail', root, setupCommand: 'exit 3' }),
    ).rejects.toThrow();
  });
});

describe('value placeholders', () => {
  it('expands a named placeholder consistently across value and wait', async () => {
    await recordFlow('placeholder');
    await server.reset();

    // Hand-edit the way a developer would to defeat a single-shot flow.
    const paths = reproPaths('placeholder', root);
    const repro = await readRepro('placeholder', root);
    const fill = repro.steps.find((s) => s.action === 'fill');
    expect(fill).toBeDefined();
    fill!.value = 'Boiler-{{random:sensor}}';

    // The next step's recorded wait embedded the OLD name, because the delete
    // button's accessible name is derived from it. A named placeholder has to
    // carry through to the wait, or making the input unique breaks the repro.
    const add = repro.steps[repro.steps.indexOf(fill!) + 1];
    add!.waitAfter.domAppeared = ['role=button[name="Delete Boiler-{{random:sensor}}"]'];
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'placeholder', root });
    expect(result.failure, JSON.stringify(result.failure)).toBeNull();

    // The server saw an expanded, unique name — not the literal placeholder.
    const sensors = (await (await fetch(`${server.baseUrl}/api/sensors`)).json()) as {
      name: string;
    }[];
    const created = sensors.map((s) => s.name);
    expect(created.some((n) => n.includes('{{'))).toBe(false);
    expect(created.some((n) => /^Boiler-\w+$/.test(n))).toBe(true);
  });
});

describe('single-shot warning', () => {
  it('fires when a fix passes but most steps behaved nothing like the recording', async () => {
    await recordFlow('single-shot');
    await server.reset();

    // Stand in for a second replay of a state-mutating flow: the steps still
    // walk, but almost nothing reacts the way it did when recorded.
    const paths = reproPaths('single-shot', root);
    const repro = await readRepro('single-shot', root);
    for (const step of repro.steps) {
      step.waitAfter = { domAppeared: ['[data-testid="never-appears"]'], timeoutMs: 250 };
    }
    // A stated criterion that IS met — so the run passes and the warning is the
    // only thing standing between the developer and a meaningless green.
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'single-shot', root, expectFixed: true });

    // It passes — that is the dangerous part, and exactly why the warning exists.
    expect(result.passed).toBe(true);
    const warning = result.notes.find((n) => n.startsWith('WARNING:'));
    expect(warning, 'a silent safety net is worse than none').toBeDefined();
    expect(warning).toMatch(/single-shot/);
    expect(warning).toMatch(/--setup|\{\{random\}\}/);
  });

  it('stays quiet on a healthy verification', async () => {
    await recordFlow('healthy');
    await server.reset();

    const paths = reproPaths('healthy', root);
    const repro = await readRepro('healthy', root);
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'healthy', root, expectFixed: true });

    expect(result.passed).toBe(true);
    // Crying wolf on a good run would train people to ignore it.
    expect(result.notes.filter((n) => n.startsWith('WARNING:'))).toEqual([]);
  });
});

describe('refusing to certify a fix it could not check', () => {
  it('fails --expect-fixed when the repro records no way to tell fixed from broken', async () => {
    // The v3 regression: step wait failures are downgraded to notes under this
    // polarity (correct — a fix changes behaviour), and the only remaining gate
    // read observedAtRecord, which the noise filter had correctly emptied. So a
    // DOM-only bug — missing element, wrong number, broken layout — reported
    // FIXED while the page was visibly still broken.
    await recordFlow('no-criterion');
    await server.reset();

    const paths = reproPaths('no-criterion', root);
    const repro = await readRepro('no-criterion', root);
    repro.assertion.observedAtRecord = { consoleErrors: [], ambientConsoleErrors: [], failedRequests: [] };
    delete repro.assertion.expectedWhenFixed;
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'no-criterion', root, expectFixed: true });

    expect(result.passed, 'must refuse rather than report a meaningless green').toBe(false);
    expect(result.failure?.semantic).toBe('fix criterion');
    expect(result.failure?.observed).toMatch(/expectedWhenFixed/);
  });

  it('passes when the stated fix criterion is met', async () => {
    await recordFlow('criterion-met');
    await server.reset();

    const paths = reproPaths('criterion-met', root);
    const repro = await readRepro('criterion-met', root);
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'criterion-met', root, expectFixed: true });
    expect(result.passed).toBe(true);
  });

  it('fails when the stated fix criterion is not met', async () => {
    await recordFlow('criterion-unmet');
    await server.reset();

    const paths = reproPaths('criterion-unmet', root);
    const repro = await readRepro('criterion-unmet', root);
    repro.assertion.expectedWhenFixed = { domAppeared: ['text=Total spend'] };
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'criterion-unmet', root, expectFixed: true });

    expect(result.passed).toBe(false);
    expect(result.failure?.semantic).toBe('fix criterion');
    expect(result.failure?.observed).toContain('Total spend');
  });
});

describe('aborted requests', () => {
  it('are not treated as server failures', async () => {
    // A same-host telemetry beacon cancelled on navigation failed every replay.
    // Host rules cannot catch it: it is served from the app's own API origin.
    const { checkInvariants } = await import('../src/replayer/invariants.js');
    const repro = await readRepro('healthy', root).catch(async () => {
      await recordFlow('aborted-probe');
      return readRepro('aborted-probe', root);
    });

    const violations = checkInvariants(
      repro,
      [
        {
          kind: 'network',
          method: 'POST',
          url: `${server.baseUrl}/api/fl?tracking=1`,
          startedAt: 0,
          settledAt: 1,
          status: null,
          failed: true,
        },
      ],
      [],
      server.baseUrl,
    );
    expect(violations).toEqual([]);
  });
});

describe('pdu_html round: verdicts', () => {
  it('lets an explicit criterion override noisy console recurrence', async () => {
    // An app that always logs a failed i18n fetch made hasBugSignature() true
    // forever, so --expect-fixed could never pass and the documented escape
    // hatch was dead code.
    await recordFlow('criterion-wins');
    await server.reset();

    const paths = reproPaths('criterion-wins', root);
    const repro = await readRepro('criterion-wins', root);
    repro.assertion.observedAtRecord = {
      consoleErrors: ['Cannot download en.json file. Use fallback file.'],
      ambientConsoleErrors: [],
      failedRequests: [],
    };
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'criterion-wins', root, expectFixed: true });
    expect(result.passed, 'the stated criterion must decide').toBe(true);
  });

  it('calls an undriveable app an infrastructure failure, not a verdict', async () => {
    // Reporting "NOT FIXED" when the harness could not drive the app sends
    // people chasing a bug they already fixed.
    await recordFlow('infra');
    await server.reset();

    const paths = reproPaths('infra', root);
    const repro = await readRepro('infra', root);
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    repro.steps[1]!.target!.candidates = ['[data-testid="never-exists"]'];
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'infra', root, expectFixed: true });

    expect(result.passed).toBe(false);
    expect(result.failure?.kind).toBe('infrastructure');
  });

  it('scales recorded waits for a slower machine', async () => {
    await recordFlow('scaled');
    await server.reset();

    const paths = reproPaths('scaled', root);
    const repro = await readRepro('scaled', root);
    // Far too tight to ever pass unscaled.
    for (const step of repro.steps) step.waitAfter.timeoutMs = 1;
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const tight = await run({ name: 'scaled', root });
    expect(tight.passed).toBe(false);

    await server.reset();
    const scaled = await run({ name: 'scaled', root, timeoutScale: 15_000 });
    expect(scaled.passed, 'timeoutScale must widen recorded waits').toBe(true);
  });
});

describe('pdu_html v2: absence-bugs in expect-bug mode', () => {
  it('reports the bug gone when the fixed-state criterion is satisfied', async () => {
    // The recorded finalState says what VANISHED, never what wrongly failed to
    // appear, so it stays satisfied after a fix and plain `run` kept saying
    // "the recorded outcome still occurs". When the author has said what fixed
    // looks like, its inverse is the only question that discriminates.
    await recordFlow('absence');
    await server.reset();

    const paths = reproPaths('absence', root);
    const repro = await readRepro('absence', root);
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'absence', root });

    expect(result.passed, 'the criterion holds, so the bug is fixed').toBe(false);
    expect(result.failure?.semantic).toBe('bug no longer reproduces');
    expect(result.failure?.kind).toBe('assertion');
  });

  it('still confirms the bug when the criterion does not hold', async () => {
    await recordFlow('absence-present');
    await server.reset();

    const paths = reproPaths('absence-present', root);
    const repro = await readRepro('absence-present', root);
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="never-appears"]'] };
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'absence-present', root });
    expect(result.passed).toBe(true);
  });
});

describe('focus assertions (WCAG 2.4.3)', () => {
  /**
   * The classic focus-restoration bug: closing a dialog drops focus on
   * <body> instead of returning it to the control that opened it. No console
   * error, no failed request, no DOM difference at the end — invisible to
   * every other signal this tool records.
   */
  // A div modal that unmounts on close, which is what a component framework
  // actually does. <dialog> is no good as a fixture: the browser restores focus
  // for you, so the bug cannot be reproduced with it.
  const page = (restoresFocus: boolean) => `
    <button data-testid="opener">Open</button>
    <div data-testid="host"></div>
    <script>
      const opener = document.querySelector('[data-testid="opener"]');
      const host = document.querySelector('[data-testid="host"]');
      opener.onclick = () => {
        host.innerHTML = '<button data-testid="closer">Close</button>';
        const closer = host.firstChild;
        closer.focus();
        closer.onclick = () => {
          ${restoresFocus ? 'opener.focus(); host.innerHTML = "";' : 'host.innerHTML = "";'}
        };
      };
    </script>`;

  const record = async (html: string) => {
    const { chromium } = await import('playwright');
    const { agentSource } = await import('../src/recorder/instrument.js');
    const { DEFAULT_AGENT_CONFIG } = await import('../src/recorder/agent/config.js');
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      const focus: { selector?: string }[] = [];
      await ctx.exposeBinding(DEFAULT_AGENT_CONFIG.emitBinding, (_s, ev) => {
        if ((ev as { kind?: string }).kind === 'focus') focus.push(ev as { selector?: string });
      });
      const p = await ctx.newPage();
      await p.setContent(html);
      await p.evaluate(agentSource(DEFAULT_AGENT_CONFIG));
      await p.click('[data-testid="opener"]');
      await p.waitForTimeout(250);
      await p.click('[data-testid="closer"]');
      await p.waitForTimeout(350);
      return focus.map((f) => f.selector);
    } finally {
      await browser.close();
    }
  };

  it('records where focus came to rest, including when it is lost to body', async () => {
    const broken = await record(page(false));
    // Focus fell to the document — the bug, and now a recorded fact.
    expect(broken[broken.length - 1]).toBe('body');
  });

  it('records focus returning to the control that opened the dialog', async () => {
    const fixed = await record(page(true));
    expect(fixed[fixed.length - 1]).toBe('[data-testid="opener"]');
  });
});

describe('held-open session', () => {
  it('replays correctly more than once against the same page', async () => {
    const { openSession } = await import('../src/api.js');
    await recordFlow('warm');
    const session = await openSession({ name: 'warm', root });
    try {
      for (let i = 0; i < 3; i++) {
        await server.reset();
        const result = await run({ name: 'warm', root, session });
        expect(result.passed, `replay ${i + 1} of 3`).toBe(true);
      }
    } finally {
      await session.close();
    }
  });

  it('does not accumulate listeners across replays', async () => {
    // Reaction listeners are attached per run. A fresh context throws them away
    // with itself; a reused one would gather a set on every replay, so the same
    // console error would be counted three times over and could trip an
    // invariant that nothing actually violated.
    const { openSession } = await import('../src/api.js');
    await recordFlow('warm-listeners');
    const session = await openSession({ name: 'warm-listeners', root });
    try {
      const counts: number[] = [];
      for (let i = 0; i < 3; i++) {
        await server.reset();
        await run({ name: 'warm-listeners', root, session });
        counts.push(session.context.listenerCount('console'));
      }
      expect(new Set(counts).size, `listener counts drifted: ${counts.join(', ')}`).toBe(1);
    } finally {
      await session.close();
    }
  });
});
