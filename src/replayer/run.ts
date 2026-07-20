import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Repro, Step, Target } from '../ir/schema.js';
import { reproPaths, type ReproPaths } from '../ir/io.js';
import { collectReactions } from '../recorder/reaction.js';
import type { RawConsoleEvent, RawNetworkEvent } from '../recorder/types.js';
import { writeFailureArtifacts, type WrittenArtifacts } from './artifacts.js';
import { checkInvariants, type InvariantViolation } from './invariants.js';
import {
  DEFAULT_RESOLVE_TIMEOUTS,
  resolveTarget,
  TargetResolutionError,
  type ResolveTimeouts,
} from './resolve.js';
import { waitForReaction } from './waits.js';

export interface StepTiming {
  id: string;
  action: string;
  semantic: string;
  /** Time to resolve the target and perform the action. */
  actMs: number;
  /** Time spent waiting for the recorded reaction. */
  waitMs: number;
  totalMs: number;
  /** >0 means the preferred selector failed and a fallback was used. */
  candidateIndex: number;
}

export interface RunFailure {
  stepId: string;
  stepIndex: number;
  semantic: string;
  expected: string;
  observed: string;
  artifacts: WrittenArtifacts | null;
}

export interface RunResult {
  name: string;
  passed: boolean;
  durationMs: number;
  /** Total steps in the IR — `timings` only covers the ones that ran. */
  totalSteps: number;
  timings: StepTiming[];
  failure: RunFailure | null;
  invariantViolations: InvariantViolation[];
}

export interface RunOptions {
  headed?: boolean;
  baseUrl?: string;
  root?: string;
  resolveTimeouts?: ResolveTimeouts;
  /**
   * Called when every selector candidate for a step failed. Returning a
   * selector lets replay continue — the seam for Phase 1's LLM re-grounding.
   * Phase 0 never supplies one.
   */
  onStepFailure?: (target: Target, page: Page) => Promise<string | null>;
}

export async function runRepro(repro: Repro, options: RunOptions = {}): Promise<RunResult> {
  const root = options.root ?? process.cwd();
  const baseUrl = options.baseUrl ?? repro.baseUrl;
  const paths = reproPaths(repro.name, root);
  const startedAt = Date.now();

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: !options.headed });
    context = await browser.newContext({
      viewport: repro.viewport,
      ...storageStateOption(repro, root),
    });

    const reactions = collectReactions(context);
    const page = await context.newPage();

    await page.goto(new URL(repro.startPath, baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
    });

    const timings: StepTiming[] = [];
    let stepStart = Date.now();

    for (let i = 0; i < repro.steps.length; i++) {
      const step = repro.steps[i];
      if (!step) continue;

      const previousStepStart = stepStart;
      stepStart = Date.now();
      const semantic = step.target?.semantic ?? describeTargetless(step);

      let candidateIndex = -1;
      try {
        candidateIndex = await performStep(page, step, baseUrl, options);
      } catch (err) {
        return await fail(
          {
            paths,
            page,
            repro,
            reactions,
            timings,
            startedAt,
            since: previousStepStart,
          },
          {
            stepId: step.id,
            stepIndex: i,
            semantic,
            expected: expectationOf(step),
            observed:
              err instanceof TargetResolutionError
                ? `no candidate selector matched. Tried:\n${err.attempts
                    .map((a) => `      ${a.selector}  (${a.error})`)
                    .join('\n')}`
                : (err as Error).message,
          },
        );
      }

      const actMs = Date.now() - stepStart;
      const outcome = await waitForReaction(
        { page, baseUrl, network: reactions.network, since: stepStart },
        step.waitAfter,
      );

      if (!outcome.ok) {
        return await fail(
          {
            paths,
            page,
            repro,
            reactions,
            timings,
            startedAt,
            since: stepStart,
          },
          {
            stepId: step.id,
            stepIndex: i,
            semantic,
            expected: expectationOf(step),
            observed: `the action ran, but these recorded signals never arrived within ${step.waitAfter.timeoutMs}ms:\n${outcome.unmet
              .map((u) => `      ${u}`)
              .join('\n')}`,
          },
        );
      }

      timings.push({
        id: step.id,
        action: step.action,
        semantic,
        actMs,
        waitMs: outcome.durationMs,
        totalMs: Date.now() - stepStart,
        candidateIndex,
      });
    }

    const violations = checkInvariants(repro, reactions.network, reactions.console, baseUrl);
    if (violations.length) {
      const last = repro.steps[repro.steps.length - 1];
      return await fail(
        {
          paths,
          page,
          repro,
          reactions,
          timings,
          startedAt,
          since: stepStart,
        },
        {
          stepId: last?.id ?? 'assertion',
          stepIndex: repro.steps.length - 1,
          semantic: 'final assertion',
          expected: violations
            .map((v) => `${v.invariant} to hold`)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(', '),
          observed: violations.map((v) => `${v.invariant}: ${v.detail}`).join('\n      '),
        },
        violations,
      );
    }

    return {
      name: repro.name,
      passed: true,
      durationMs: Date.now() - startedAt,
      totalSteps: repro.steps.length,
      timings,
      failure: null,
      invariantViolations: [],
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function storageStateOption(repro: Repro, root: string): { storageState?: string } {
  if (!repro.storageStatePath) return {};
  const abs = path.resolve(root, repro.storageStatePath);
  // A deleted state file should degrade to a clean session, not crash the run.
  return existsSync(abs) ? { storageState: abs } : {};
}

interface FailContext {
  paths: ReproPaths;
  page: Page;
  repro: Repro;
  reactions: { network: RawNetworkEvent[]; console: RawConsoleEvent[] };
  timings: StepTiming[];
  startedAt: number;
  since: number;
}

async function fail(
  ctx: FailContext,
  failure: Omit<RunFailure, 'artifacts'>,
  violations: InvariantViolation[] = [],
): Promise<RunResult> {
  const artifacts = await writeFailureArtifacts(ctx.page, ctx.paths, {
    ...failure,
    networkSince: ctx.reactions.network.filter((n) => n.startedAt >= ctx.since),
    consoleErrors: ctx.reactions.console,
  });

  return {
    name: ctx.repro.name,
    passed: false,
    durationMs: Date.now() - ctx.startedAt,
    totalSteps: ctx.repro.steps.length,
    timings: ctx.timings,
    failure: { ...failure, artifacts },
    invariantViolations: violations,
  };
}

function describeTargetless(step: Step): string {
  if (step.action === 'goto') return `navigate to ${step.value ?? '(unknown)'}`;
  if (step.action === 'scroll') return `scroll the page to ${step.value ?? '(unknown)'}`;
  if (step.action === 'press') return `press ${step.value ?? '(unknown)'}`;
  return step.action;
}

function expectationOf(step: Step): string {
  const parts: string[] = [];
  for (const n of step.waitAfter.network ?? []) parts.push(`${n.method} ${n.urlPattern} to settle`);
  for (const s of step.waitAfter.domAppeared ?? []) parts.push(`${s} to appear`);
  for (const s of step.waitAfter.domGone ?? []) parts.push(`${s} to disappear`);
  if (step.waitAfter.networkIdle) parts.push('the network to go idle');
  return parts.length ? parts.join(', ') : 'the step to complete';
}

/** Performs one step; returns which candidate selector worked (-1 when targetless). */
async function performStep(
  page: Page,
  step: Step,
  baseUrl: string,
  options: RunOptions,
): Promise<number> {
  const timeouts = options.resolveTimeouts ?? DEFAULT_RESOLVE_TIMEOUTS;

  if (step.action === 'goto') {
    await page.goto(rebase(step.value, baseUrl), { waitUntil: 'domcontentloaded' });
    return -1;
  }

  if (step.action === 'scroll' && !step.target) {
    const { x, y } = parsePosition(step.value);
    await page.evaluate(([px, py]) => window.scrollTo(px as number, py as number), [x, y]);
    return -1;
  }

  if (step.action === 'press' && !step.target) {
    await page.keyboard.press(step.value ?? 'Enter');
    return -1;
  }

  if (!step.target) throw new Error(`Step ${step.id} (${step.action}) has no target to act on.`);

  const resolved = await resolveTarget(page, step.target, timeouts, options.onStepFailure);
  const { locator } = resolved;

  switch (step.action) {
    case 'click':
      await locator.click();
      break;
    case 'dblclick':
      await locator.dblclick();
      break;
    case 'hover':
      await locator.hover();
      break;
    case 'fill':
      await locator.fill(step.value ?? '');
      break;
    case 'select':
      await locator.selectOption(step.value ?? '');
      break;
    case 'press':
      await locator.press(step.value ?? 'Enter');
      break;
    case 'scroll': {
      const { x, y } = parsePosition(step.value);
      await locator.evaluate((el, [px, py]) => {
        el.scrollLeft = px as number;
        el.scrollTop = py as number;
      }, [x, y]);
      break;
    }
    default:
      throw new Error(`Unsupported action "${step.action}" in step ${step.id}.`);
  }

  return resolved.candidateIndex;
}

/** Re-point a recorded absolute URL at the base URL replay is actually using. */
function rebase(recorded: string | null, baseUrl: string): string {
  if (!recorded) return baseUrl;
  try {
    const u = new URL(recorded);
    return new URL(`${u.pathname}${u.search}`, baseUrl).toString();
  } catch {
    return new URL(recorded, baseUrl).toString();
  }
}

function parsePosition(value: string | null): { x: number; y: number } {
  try {
    const parsed = JSON.parse(value ?? '{}') as { x?: number; y?: number };
    return { x: parsed.x ?? 0, y: parsed.y ?? 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}
