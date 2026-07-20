import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { record, run } from '../src/api.js';
import { startDemoServer } from '../tests/helpers/demo-server.js';
import { demoBugFlow } from '../tests/helpers/flow.js';

/**
 * Records once, then replays N times against a freshly reset server.
 *
 * The point is not average speed but the tail: a repro a developer cannot
 * trust is worse than no repro, so this reports the slowest run and fails on
 * a single flake rather than on a success rate.
 */

const RUNS = Number(process.env.STRESS_RUNS ?? 20);
const BUDGET_MS = Number(process.env.STRESS_BUDGET_MS ?? 8_000);
const PORT = Number(process.env.STRESS_PORT ?? 5210);

const server = await startDemoServer(PORT);
const root = await mkdtemp(path.join(tmpdir(), 'replay-stress-'));

try {
  process.stdout.write('recording once… ');
  const { repro } = await record({
    name: 'stress',
    baseUrl: server.baseUrl,
    root,
    headless: true,
    drive: demoBugFlow,
  });
  console.log(`${repro.steps.length} steps\n`);

  const durations: number[] = [];
  let failures = 0;

  for (let i = 1; i <= RUNS; i++) {
    await server.reset();
    const result = await run({ name: 'stress', root });
    durations.push(result.durationMs);

    const overBudget = result.durationMs > BUDGET_MS;
    const mark = result.passed ? (overBudget ? '!' : '.') : 'F';
    process.stdout.write(mark);
    if (i % 20 === 0) process.stdout.write('\n');

    if (!result.passed) {
      failures++;
      console.log(
        `\n  run ${i} failed at ${result.failure?.stepId} — ${result.failure?.semantic}\n` +
          `  observed: ${result.failure?.observed}\n`,
      );
    }
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const slowest = sorted[sorted.length - 1] ?? 0;
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;

  console.log(`\n\n${RUNS} runs · ${failures} failed`);
  console.log(
    `  mean ${fmt(mean)}   p50 ${fmt(at(0.5))}   p95 ${fmt(at(0.95))}   slowest ${fmt(slowest)}`,
  );
  console.log(`  budget ${fmt(BUDGET_MS)} — ${slowest <= BUDGET_MS ? 'met by every run' : 'EXCEEDED'}`);

  if (failures > 0 || slowest > BUDGET_MS) process.exitCode = 1;
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}

function fmt(value: number): string {
  return `${(value / 1000).toFixed(2)}s`;
}
