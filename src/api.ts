import path from 'node:path';
import type { Page } from 'playwright';
import { compile } from './compiler/compile.js';
import {
  listRepros,
  readRepro,
  reproPaths,
  writeFileAtomic,
  writeLastResult,
  writeRepro,
  type ReproSummary,
} from './ir/io.js';
import { launchRecording, STOP_HOTKEY } from './recorder/launch.js';
import { runRepro, type RunOptions, type RunResult } from './replayer/run.js';
import type { Repro } from './ir/schema.js';

export interface RecordOptions {
  name: string;
  baseUrl: string;
  startPath?: string;
  viewport?: { width: number; height: number };
  root?: string;
  /** Seed cookies/localStorage from an existing Playwright storageState file. */
  storageStatePath?: string | null;
  onReady?: () => void;
  headless?: boolean;
  /**
   * Drive the browser programmatically instead of waiting for a human. The
   * capture pipeline is identical either way — the seam Phase 1's `repro auto`
   * hands to an LLM browser agent.
   */
  drive?: (page: Page) => Promise<void>;
}

export interface RecordResult {
  repro: Repro;
  irPath: string;
  stopReason: string;
}

/**
 * Drive a real browser, capture the flow, compile it to IR on disk.
 *
 * This — not the CLI — is the product's entry point. `repro record` is a thin
 * wrapper, and the Phase 1 MCP server will wrap this same function so an agent
 * verifies a fix in one call with no per-step round trips.
 */
export async function record(options: RecordOptions): Promise<RecordResult> {
  const root = options.root ?? process.cwd();
  const paths = reproPaths(options.name, root);

  const { trace, storageState, stopReason } = await launchRecording({
    baseUrl: options.baseUrl,
    startPath: options.startPath,
    viewport: options.viewport,
    storageStatePath: options.storageStatePath ?? null,
    onReady: options.onReady,
    headless: options.headless,
    drive: options.drive,
  });

  await writeFileAtomic(paths.storageState, storageState);

  const repro = compile(trace, {
    name: options.name,
    storageStatePath: path.relative(root, paths.storageState),
  });

  await writeRepro(repro, paths);
  return { repro, irPath: paths.ir, stopReason };
}

export interface RunReproOptions extends RunOptions {
  name: string;
}

/** Replay a recorded repro. Reads and validates the IR, then drives the browser. */
export async function run(options: RunReproOptions): Promise<RunResult> {
  const root = options.root ?? process.cwd();
  const repro = await readRepro(options.name, root);
  const result = await runRepro(repro, options);

  await writeLastResult(reproPaths(options.name, root), {
    status: result.passed ? 'pass' : 'fail',
    at: new Date().toISOString(),
    durationMs: result.durationMs,
    ...(result.failure ? { failedStepId: result.failure.stepId } : {}),
  });

  return result;
}

/** Every repro in `.repros/`, newest first. Never throws on a corrupt IR. */
export async function list(root = process.cwd()): Promise<ReproSummary[]> {
  return listRepros(root);
}

export { createServer } from './mcp/server.js';
export { STOP_HOTKEY };
export { deleteRepro, readRepro, reproPaths } from './ir/io.js';
export { compile } from './compiler/compile.js';
export * from './ir/schema.js';
export type { RunResult, StepTiming, RunFailure } from './replayer/run.js';
export type { ReproSummary } from './ir/io.js';
