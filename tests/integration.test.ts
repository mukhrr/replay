import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { list, readRepro, record, reproPaths, run } from '../src/api.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';
import { DEMO_FLOW_MIN_STEPS, demoBugFlow } from './helpers/flow.js';

const REPLAY_BUDGET_MS = 8_000;

let server: DemoServer;
let root: string;

beforeAll(async () => {
  server = await startDemoServer(5199);
  root = await mkdtemp(path.join(tmpdir(), 'replay-it-'));
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await server.reset();
});

async function recordDemoFlow(name: string) {
  return record({
    name,
    baseUrl: server.baseUrl,
    root,
    headless: true,
    drive: demoBugFlow,
  });
}

describe('record → run round trip', () => {
  it('compiles a driven session into a replayable IR', async () => {
    const { repro, irPath } = await recordDemoFlow('demo-flow');

    expect(repro.steps.length).toBeGreaterThanOrEqual(DEMO_FLOW_MIN_STEPS);
    expect(repro.baseUrl).toBe(server.baseUrl);
    expect(irPath).toBe(reproPaths('demo-flow', root).ir);

    // Every step must be actionable at replay time.
    for (const step of repro.steps) {
      expect(step.waitAfter.timeoutMs).toBeGreaterThan(0);
      expect(step.author).toBe('human');
      if (step.action !== 'goto' && step.action !== 'press' && step.action !== 'scroll') {
        expect(step.target?.candidates.length).toBeGreaterThan(0);
        expect(step.target?.semantic).toBeTruthy();
      }
    }

    // The delete button carries no test id, so it must have resolved through
    // the accessible-name path — that candidate tier is load-bearing.
    const deleteStep = repro.steps.find((s) => s.target?.semantic.includes('Delete Sensor 2'));
    expect(deleteStep, 'expected a step targeting the un-testid-ed delete button').toBeDefined();
    expect(deleteStep?.target?.candidates.some((c) => c.startsWith('role='))).toBe(true);

    // The DELETE round trip, the row vanishing and the toast arriving are the
    // reaction. Losing any of these silently degrades every wait to a timeout,
    // so they are asserted explicitly.
    expect(deleteStep?.waitAfter.network?.some((n) => n.method === 'DELETE')).toBe(true);
    expect(deleteStep?.waitAfter.domGone).toContain('[data-testid="sensor-row-2"]');
    expect(deleteStep?.waitAfter.domAppeared).toContain('[data-testid="confirm-toast"]');

    // Non-rendered nodes make unwaitable signals: an <option> has no layout box,
    // so a replay waiting for it to become visible would hang until timeout.
    const allAppeared = repro.steps.flatMap((s) => s.waitAfter.domAppeared ?? []);
    expect(allAppeared.some((s) => s.startsWith('role=option'))).toBe(false);

    // The recorded end state is what `repro run` asserts, so it must be real.
    expect(repro.assertion.finalState.domAppeared).toContain('[data-testid="report-result"]');

    // A fresh recording of a working app has nothing to switch off.
    expect(repro.assertion.mode).toBe('expect-bug');
    expect(repro.assertion.invariants.noConsoleErrors).toBe(true);
    expect(repro.assertion.invariants.noFailedRequests).toBe(true);
    expect(repro.assertion.observedAtRecord).toBeDefined();
  });

  it('replays the recording and passes inside the time budget', async () => {
    await recordDemoFlow('demo-replay');
    await server.reset();

    const result = await run({ name: 'demo-replay', root });

    expect(result.failure).toBeNull();
    expect(result.passed).toBe(true);
    expect(result.timings.length).toBeGreaterThanOrEqual(DEMO_FLOW_MIN_STEPS);
    expect(result.durationMs).toBeLessThan(REPLAY_BUDGET_MS);
  });

  it('waits on the slow endpoint rather than sleeping through it', async () => {
    await recordDemoFlow('demo-slow');
    await server.reset();

    const result = await run({ name: 'demo-slow', root });
    const generate = result.timings.find((t) => t.semantic.includes('Generate report'));

    expect(generate).toBeDefined();
    // The endpoint sleeps 1.5s, so the wait cannot be shorter...
    expect(generate!.waitMs).toBeGreaterThan(1_400);
    // ...and must not overshoot it by much, which a fixed sleep would.
    expect(generate!.waitMs).toBeLessThan(2_600);
  });

  it('reports the failing step with its semantic description when the app changes', async () => {
    await recordDemoFlow('demo-broken');
    await server.reset();

    // Simulate the "fix" landing wrong: the delete button loses its label, so
    // every recorded candidate for that step goes stale.
    const paths = reproPaths('demo-broken', root);
    const repro = await readRepro('demo-broken', root);
    const target = repro.steps.find((s) => s.target?.semantic.includes('Delete Sensor 2'));
    expect(target).toBeDefined();
    target!.target!.candidates = ['[data-testid="does-not-exist"]'];
    await writeFile(paths.ir, JSON.stringify(repro, null, 2));

    const result = await run({ name: 'demo-broken', root });

    expect(result.passed).toBe(false);
    expect(result.failure?.stepId).toBe(target!.id);
    expect(result.failure?.semantic).toContain('Delete Sensor 2');
    expect(result.failure?.observed).toContain('does-not-exist');

    // Artifacts must be enough to diagnose without re-running.
    const artifacts = result.failure?.artifacts;
    expect(artifacts?.screenshot).toBeTruthy();
    const summary = JSON.parse(await readFile(artifacts!.summary, 'utf8'));
    expect(summary.semantic).toContain('Delete Sensor 2');
  });

  it('surfaces a hand-corrupted IR as a schema error, not a crash', async () => {
    await recordDemoFlow('demo-corrupt');
    const paths = reproPaths('demo-corrupt', root);

    const broken = JSON.parse(await readFile(paths.ir, 'utf8'));
    broken.steps[0].action = 'teleport';
    delete broken.viewport;
    await writeFile(paths.ir, JSON.stringify(broken, null, 2));

    await expect(run({ name: 'demo-corrupt', root })).rejects.toThrow(/Invalid repro IR/);
    await expect(run({ name: 'demo-corrupt', root })).rejects.toThrow(/steps\.0\.action/);
  });

  it('lists repros with their last result', async () => {
    await recordDemoFlow('demo-listed');
    await server.reset();
    await run({ name: 'demo-listed', root });

    const entries = await list(root);
    const listed = entries.find((e) => e.name === 'demo-listed');

    expect(listed?.lastResult?.status).toBe('pass');
    expect(listed?.steps).toBeGreaterThanOrEqual(DEMO_FLOW_MIN_STEPS);
    expect(listed?.error).toBeNull();
  });
});
