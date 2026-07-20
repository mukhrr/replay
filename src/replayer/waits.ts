import type { Page } from 'playwright';
import type { WaitAfter } from '../ir/schema.js';
import { matchesUrlPattern } from '../compiler/normalize.js';
import type { RawNetworkEvent } from '../recorder/types.js';

export interface WaitContext {
  page: Page;
  baseUrl: string;
  /** Live network buffer, shared with the runner. */
  network: RawNetworkEvent[];
  /** Everything from this timestamp on counts toward this step's signals. */
  since: number;
}

export interface WaitOutcome {
  ok: boolean;
  /** Human-readable descriptions of signals that never arrived. */
  unmet: string[];
  /** Signals that did arrive, for the success-path timing table. */
  met: string[];
  durationMs: number;
}

const NETWORK_POLL_MS = 25;

/**
 * Poll the network buffer instead of attaching a fresh `waitForResponse`.
 *
 * A request can settle before we get around to waiting on it — the classic
 * lost-wakeup race. Reading a buffer that was already recording covers the
 * window between the action firing and this wait starting.
 */
function waitForNetwork(
  ctx: WaitContext,
  method: string,
  urlPattern: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  const satisfied = (): boolean =>
    ctx.network.some(
      (n) =>
        n.settledAt !== null &&
        n.settledAt >= ctx.since &&
        n.method.toUpperCase() === method.toUpperCase() &&
        matchesUrlPattern(n.url, urlPattern, ctx.baseUrl),
    );

  return new Promise<void>((resolve, reject) => {
    if (satisfied()) return resolve();
    const timer = setInterval(() => {
      if (satisfied()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`no settled ${method} matching ${urlPattern}`));
      }
    }, NETWORK_POLL_MS);
  });
}

/**
 * Wait for every recorded signal at once, with the step's timeoutMs as a single
 * ceiling over all of them. Never a fixed sleep — replay proceeds the moment
 * the environment actually reacts, which is where the speed comes from.
 */
export async function waitForReaction(ctx: WaitContext, waitAfter: WaitAfter): Promise<WaitOutcome> {
  const started = Date.now();
  const timeout = waitAfter.timeoutMs;
  const jobs: { label: string; run: Promise<void> }[] = [];

  for (const n of waitAfter.network ?? []) {
    jobs.push({
      label: `network ${n.method} ${n.urlPattern}`,
      run: waitForNetwork(ctx, n.method, n.urlPattern, timeout),
    });
  }

  for (const selector of waitAfter.domAppeared ?? []) {
    jobs.push({
      label: `appeared ${selector}`,
      run: ctx.page
        .locator(selector)
        .first()
        .waitFor({ state: 'visible', timeout })
        .then(() => undefined),
    });
  }

  for (const selector of waitAfter.domGone ?? []) {
    jobs.push({
      label: `gone ${selector}`,
      // `hidden` covers both ways an element goes away — unmounted, or still
      // attached but no longer rendered. `detached` would hang forever on the
      // second case. `first()` keeps this out of strict mode and resolves
      // immediately when nothing matches, which is exactly "already gone".
      run: ctx.page
        .locator(selector)
        .first()
        .waitFor({ state: 'hidden', timeout })
        .then(() => undefined),
    });
  }

  if (waitAfter.networkIdle) {
    jobs.push({
      label: 'network idle',
      run: ctx.page.waitForLoadState('networkidle', { timeout }).then(() => undefined),
    });
  }

  if (!jobs.length) return { ok: true, unmet: [], met: [], durationMs: 0 };

  const results = await Promise.allSettled(jobs.map((j) => j.run));
  const unmet: string[] = [];
  const met: string[] = [];
  results.forEach((r, i) => {
    const label = jobs[i]?.label ?? 'signal';
    if (r.status === 'fulfilled') met.push(label);
    else unmet.push(label);
  });

  return { ok: unmet.length === 0, unmet, met, durationMs: Date.now() - started };
}
