import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { openBrowser } from './browser.js';
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
  /** Seed cookies/localStorage/IndexedDB from an existing Playwright state file. */
  storageStatePath?: string | null;
  /** Use a persistent Chromium profile instead of a fresh context. */
  profileDir?: string | null;
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
 * The driver failed part-way, but the steps captured before it did were written
 * to disk anyway. Carries the path so the caller can inspect or resume.
 */
export class PartialRecordingError extends Error {
  constructor(
    override readonly cause: Error,
    readonly irPath: string,
    readonly repro: Repro,
  ) {
    super(
      `Recording stopped early after ${repro.steps.length} step(s): ${cause.message}\n` +
        `The partial repro was still written to ${irPath}`,
    );
    this.name = 'PartialRecordingError';
  }
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

  const { trace, storageState, stopReason, driveError } = await launchRecording({
    baseUrl: options.baseUrl,
    startPath: options.startPath,
    viewport: options.viewport,
    storageStatePath: options.storageStatePath ?? null,
    profileDir: options.profileDir ?? null,
    onReady: options.onReady,
    headless: options.headless,
    drive: options.drive,
  });

  await writeFileAtomic(paths.storageState, storageState);

  const repro = compile(trace, {
    name: options.name,
    storageStatePath: path.relative(root, paths.storageState),
  });

  // Written before any error is raised: a driver that failed on step 12 still
  // captured eleven real steps, and throwing them away wastes the whole run.
  await writeRepro(repro, paths);

  if (driveError) throw new PartialRecordingError(driveError, paths.ir, repro);
  return { repro, irPath: paths.ir, stopReason };
}

export interface RunReproOptions extends RunOptions {
  name: string;
}

export interface WarmSession {
  context: import('playwright').BrowserContext;
  page: import('playwright').Page;
  close(): Promise<void>;
}

/**
 * A browser held open across replays.
 *
 * A fresh context boots the app from a cold cache every time, which on a heavy
 * single-page app costs several times the replay itself. Holding one open keeps
 * the HTTP and V8 caches warm — measured at 81% off page load even on a trivial
 * app, and the gap widens with the size of the bundle.
 *
 * It trades isolation for speed, so it belongs in a fix-verify loop a person is
 * watching, not in a verification that has to stand on its own.
 */
export async function openSession(options: {
  name: string;
  root?: string;
  headed?: boolean;
}): Promise<WarmSession> {
  const root = options.root ?? process.cwd();
  const repro = await readRepro(options.name, root);
  const paths = reproPaths(options.name, root);
  const opened = await openBrowser({
    headless: !options.headed,
    viewport: repro.viewport,
    storageStatePath: existsSync(paths.storageState) ? paths.storageState : null,
  });
  return { context: opened.context, page: opened.page, close: opened.close };
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

export { assertRepro, fixRepro, type AssertOptions, type FixOptions } from './ir/edit.js';
export { createReplayServer, createServer } from './mcp/server.js';
export { BrowserPool } from './browser.js';
export { STOP_HOTKEY };
export { deleteRepro, readRepro, reproPaths } from './ir/io.js';
export { compile } from './compiler/compile.js';
export * from './ir/schema.js';
export type { RunResult, StepTiming, RunFailure } from './replayer/run.js';
export type { ReproSummary } from './ir/io.js';
