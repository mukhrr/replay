import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Browser, Page } from 'playwright';
import { openBrowser } from '../browser.js';
import type { Repro, Step, Target } from '../ir/schema.js';
import { reproPaths, type ReproPaths } from '../ir/io.js';
import { collectReactions } from '../recorder/reaction.js';
import type { RawConsoleEvent, RawNetworkEvent } from '../recorder/types.js';
import { writeFailureArtifacts, type WrittenArtifacts } from './artifacts.js';
import {
  checkBugRecurred,
  checkInvariants,
  hasBugSignature,
  hasFixCriterion,
  type InvariantViolation,
} from './invariants.js';
import {
  DEFAULT_RESOLVE_TIMEOUTS,
  resolveTarget,
  TargetResolutionError,
  type ResolveTimeouts,
} from './resolve.js';
import { createExpander, type Expander } from './values.js';
import { waitForReaction } from './waits.js';

const execAsync = promisify(exec);

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
  /** Which polarity this run asserted. */
  expectFixed: boolean;
  /** Non-fatal observations, e.g. reactions that changed after a fix. */
  notes: string[];
  /** Path to the end-state screenshot, when one was requested. */
  finalScreenshot: string | null;
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
   * Capture the end state even when the run passes.
   *
   * The CLI leaves this off to stay fast. The MCP server turns it on: its whole
   * job is to hand the browser's visual state to a model, and "it passed" is a
   * far weaker signal to a reader than seeing the resulting page.
   */
  captureFinalScreenshot?: boolean;
  /**
   * Verification mode: pass when the flow still walks and the recorded bug
   * does NOT happen again.
   *
   * The default polarity asserts the opposite — that the bug still reproduces —
   * which is what you want to confirm a fresh repro is sound, but backwards
   * while you are fixing something. Under --expect-fixed a step's recorded
   * reaction becomes a note rather than a failure: after a real fix the app is
   * *supposed* to react differently.
   */
  expectFixed?: boolean;
  /**
   * Called when every selector candidate for a step failed. Returning a
   * selector lets replay continue — the seam for Phase 1's LLM re-grounding.
   * Phase 0 never supplies one.
   */
  onStepFailure?: (target: Target, page: Page) => Promise<string | null>;
  /** Replay against a persistent Chromium profile (e.g. to reuse a login). */
  profileDir?: string | null;
  /**
   * Reuse a running browser across runs. Saves the launch and, more usefully,
   * keeps V8's code cache warm so a large app boots far faster on replay two
   * onward. Each run still gets its own context.
   */
  browser?: Browser | null;
  /**
   * Shell command run before the browser opens, to reset state the flow mutates.
   *
   * Deliberately NOT a field in the IR: a repro file is something you download,
   * hand-edit and share, and one that can execute commands is a liability.
   */
  setupCommand?: string | null;
}

export async function runRepro(repro: Repro, options: RunOptions = {}): Promise<RunResult> {
  const root = options.root ?? process.cwd();
  const baseUrl = options.baseUrl ?? repro.baseUrl;
  const paths = reproPaths(repro.name, root);
  const expectFixed = options.expectFixed ?? false;
  // One expander per run: a named placeholder resolves identically across every
  // step, selector and wait here, and differently on the next run.
  const expand = createExpander();
  const notes: string[] = [];
  const startedAt = Date.now();

  if (options.setupCommand) {
    await execAsync(options.setupCommand);
  }

  const opened = await openBrowser({
    headless: !options.headed,
    viewport: repro.viewport,
    storageStatePath: options.profileDir ? null : storageStatePath(repro, root),
    profileDir: options.profileDir ?? null,
    // A persistent profile owns its own process, so it cannot share one.
    browser: options.profileDir ? null : (options.browser ?? null),
  });

  try {
    const { context, page } = opened;
    const reactions = collectReactions(context);

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
        candidateIndex = await performStep(page, step, baseUrl, options, expand);
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
            expectFixed,
            notes,
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
        {
          ...step.waitAfter,
          // A value made unique with {{random:name}} changes the accessible
          // names derived from it, so the waits must expand the same way.
          domAppeared: expand.expandAll(step.waitAfter.domAppeared),
          domGone: expand.expandAll(step.waitAfter.domGone),
        },
      );

      if (!outcome.ok && expectFixed) {
        // The reaction changed. That is the expected consequence of a fix, not
        // a failure — but it is worth telling the reader about.
        notes.push(
          `${step.id} (${semantic}): recorded reaction no longer occurs — ${outcome.unmet.join('; ')}`,
        );
      } else if (!outcome.ok) {
        return await fail(
          {
            paths,
            page,
            repro,
            reactions,
            timings,
            startedAt,
            since: stepStart,
            expectFixed,
            notes,
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

    // The final-state assertion. Auto-derived from the last step, but the whole
    // point of a readable IR is that a human or an agent can widen it by hand —
    // so it has to actually be evaluated. It previously was not: the fields were
    // written by the compiler, validated by the schema, documented as the
    // assertion seam, and silently ignored. A hand-edited assertion returned
    // green without ever being checked, which is worse than not having it.
    const finalOutcome = await waitForFinalState(
      { page, baseUrl, network: reactions.network, since: stepStart },
      repro,
      expectFixed,
      expand,
    );
    if (finalOutcome && !finalOutcome.ok) {
      const last = repro.steps[repro.steps.length - 1];
      return await fail(
        { paths, page, repro, reactions, timings, startedAt, since: stepStart, expectFixed, notes },
        {
          stepId: last?.id ?? 'assertion',
          stepIndex: repro.steps.length - 1,
          semantic: 'final state assertion',
          expected: describeFinalState(repro),
          observed: `these never arrived within ${FINAL_STATE_TIMEOUT_MS}ms:\n      ${finalOutcome.unmet.join('\n      ')}`,
        },
      );
    }

    const finalScreenshot = options.captureFinalScreenshot
      ? await captureEndState(page, paths)
      : null;

    if (expectFixed) {
      // Refuse to certify a fix we had no way to check.
      //
      // Under this polarity a changed step reaction is downgraded to a note —
      // correctly, since a fix is supposed to change behaviour. But that left
      // nothing able to fail for a bug with no console error and no failed
      // request: a missing element, a wrong number, a broken layout all
      // reported FIXED while the page was visibly still broken. Reporting
      // success after checking nothing is the worst thing this tool can do,
      // so it now says so instead.
      if (!hasFixCriterion(repro) && !hasBugSignature(repro)) {
        const last = repro.steps[repro.steps.length - 1];
        return await fail(
          { paths, page, repro, reactions, timings, startedAt, since: stepStart, expectFixed, notes },
          {
            stepId: last?.id ?? 'assertion',
            stepIndex: repro.steps.length - 1,
            semantic: 'fix criterion',
            expected: 'something that distinguishes fixed from broken',
            observed:
              'This repro records no console error and no failed request, so there is nothing ' +
              '--expect-fixed can check. It would pass whether or not you fixed anything.\n' +
              '      Add what must be TRUE once fixed, e.g.:\n' +
              '        "assertion": { "expectedWhenFixed": { "domAppeared": ["text=Total spend"] } }\n' +
              '      Use `repro run` (without --expect-fixed) to confirm the bug still reproduces.',
          },
        );
      }

      if (hasFixCriterion(repro)) {
        const expected = repro.assertion.expectedWhenFixed!;
        const outcome = await waitForReaction(
          { page, baseUrl, network: reactions.network, since: stepStart },
          {
            ...(expected.domAppeared?.length
              ? { domAppeared: expand.expandAll(expected.domAppeared) }
              : {}),
            ...(expected.domGone?.length ? { domGone: expand.expandAll(expected.domGone) } : {}),
            timeoutMs: FINAL_STATE_TIMEOUT_MS,
          },
        );
        if (!outcome.ok) {
          const last = repro.steps[repro.steps.length - 1];
          return await fail(
            { paths, page, repro, reactions, timings, startedAt, since: stepStart, expectFixed, notes },
            {
              stepId: last?.id ?? 'assertion',
              stepIndex: repro.steps.length - 1,
              semantic: 'fix criterion',
              expected: describeState(expected),
              observed: `still not satisfied after ${FINAL_STATE_TIMEOUT_MS}ms:\n      ${outcome.unmet.join('\n      ')}`,
            },
          );
        }
      }
    }

    const recurred = expectFixed
      ? checkBugRecurred(repro, reactions.network, reactions.console, baseUrl)
      : [];
    if (recurred.length) {
      const last = repro.steps[repro.steps.length - 1];
      return await fail(
        { paths, page, repro, reactions, timings, startedAt, since: stepStart, expectFixed, notes },
        {
          stepId: last?.id ?? 'assertion',
          stepIndex: repro.steps.length - 1,
          semantic: 'bug recurrence check',
          expected: 'the recorded bug not to happen again',
          observed: recurred.join('\n      '),
        },
      );
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
          expectFixed,
          notes,
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

    const lastStepDiverged =
      notes.length > 0 && notes.some((n) => n.startsWith(`${repro.steps[repro.steps.length - 1]?.id} `));
    if (
      expectFixed &&
      repro.steps.length >= 3 &&
      // A single-shot repro diverges in exactly one step — the last one, which
      // carries the assertion. Requiring most steps to diverge missed it every
      // time, which is the only case that mattered.
      (lastStepDiverged || notes.length >= Math.ceil(repro.steps.length / 2))
    ) {
      // Most of the flow behaved nothing like the recording. That is what a
      // single-shot repro looks like on its second run — the state it depended
      // on already exists, so the bug cannot recur and the pass means nothing.
      notes.push(
        `WARNING: ${notes.length} of ${repro.steps.length} steps did not reproduce their recorded reaction. ` +
          `This repro may be single-shot: if the flow mutates server state, replays after the first ` +
          `cannot exercise the same path and will pass regardless of any fix. ` +
          `Use --setup to reset state, or make inputs unique with {{random}}.`,
      );
    }

    return {
      name: repro.name,
      passed: true,
      durationMs: Date.now() - startedAt,
      totalSteps: repro.steps.length,
      expectFixed,
      notes,
      finalScreenshot,
      timings,
      failure: null,
      invariantViolations: [],
    };
  } finally {
    await opened.close();
  }
}

function storageStatePath(repro: Repro, root: string): string | null {
  if (!repro.storageStatePath) return null;
  const abs = path.resolve(root, repro.storageStatePath);
  // A deleted state file should degrade to a clean session, not crash the run.
  return existsSync(abs) ? abs : null;
}

interface FailContext {
  paths: ReproPaths;
  page: Page;
  repro: Repro;
  reactions: { network: RawNetworkEvent[]; console: RawConsoleEvent[] };
  timings: StepTiming[];
  startedAt: number;
  since: number;
  expectFixed: boolean;
  notes: string[];
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
    expectFixed: ctx.expectFixed,
    notes: ctx.notes,
    finalScreenshot: artifacts.screenshot,
    timings: ctx.timings,
    failure: { ...failure, artifacts },
    invariantViolations: violations,
  };
}

/** Ceiling for the final-state assertion, independent of any step's budget. */
const FINAL_STATE_TIMEOUT_MS = 5_000;

/**
 * Evaluate `assertion.finalState` after the last step.
 *
 * Skipped entirely under --expect-fixed: the recorded final state describes the
 * BUG, and demanding it after a fix would fail every correct build.
 */
async function waitForFinalState(
  ctx: Parameters<typeof waitForReaction>[0],
  repro: Repro,
  expectFixed: boolean,
  expand: Expander,
): Promise<{ ok: boolean; unmet: string[] } | null> {
  if (expectFixed) return null;
  const domAppeared = expand.expandAll(repro.assertion.finalState.domAppeared);
  const domGone = expand.expandAll(repro.assertion.finalState.domGone);
  if (!domAppeared?.length && !domGone?.length) return null;

  const outcome = await waitForReaction(ctx, {
    ...(domAppeared?.length ? { domAppeared } : {}),
    ...(domGone?.length ? { domGone } : {}),
    timeoutMs: FINAL_STATE_TIMEOUT_MS,
  });
  return { ok: outcome.ok, unmet: outcome.unmet };
}

function describeFinalState(repro: Repro): string {
  return describeState(repro.assertion.finalState);
}

function describeState(state: { domAppeared?: string[]; domGone?: string[] }): string {
  return [
    ...(state.domAppeared ?? []).map((s) => `${s} to be present`),
    ...(state.domGone ?? []).map((s) => `${s} to be gone`),
  ].join(', ');
}

/** End-of-run screenshot for a passing run; failures capture their own. */
async function captureEndState(page: Page, paths: ReproPaths): Promise<string | null> {
  const file = path.join(paths.artifactsDir, 'final.png');
  try {
    await mkdir(paths.artifactsDir, { recursive: true });
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
    return file;
  } catch {
    return null;
  }
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
  expand: Expander,
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

  const target = {
    ...step.target,
    candidates: expand.expandAll(step.target.candidates) ?? step.target.candidates,
  };
  const resolved = await resolveTarget(page, target, timeouts, options.onStepFailure);
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
      await locator.fill(expand.expand(step.value) ?? '');
      break;
    case 'select':
      await locator.selectOption(expand.expand(step.value) ?? '');
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
    return new URL(`${u.pathname}${u.search}${u.hash}`, baseUrl).toString();
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
