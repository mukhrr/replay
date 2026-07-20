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
    repro.assertion.observedAtRecord = { consoleErrors: [], failedRequests: [] };
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
