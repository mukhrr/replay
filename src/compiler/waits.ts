import type { NetworkWait, WaitAfter } from '../ir/schema.js';
import type { RawDomEvent, RawNetworkEvent } from '../recorder/types.js';
import { isIncidentalRequest } from '../noise.js';
import { normalizeUrlPattern } from './normalize.js';

export interface WaitRules {
  /** A request counts as triggered by the action only if it started this soon after it. */
  triggerWindowMs: number;
  /** How long after an action DOM changes are still considered its reaction. */
  domWindowMs: number;
  /** Applied when the action produced no observable reaction at all. */
  emptyTimeoutMs: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  /** Multiple of the observed settle time used as the replay ceiling. */
  timeoutSlack: number;
  maxSelectors: number;
}

export const DEFAULT_WAIT_RULES: WaitRules = {
  triggerWindowMs: 500,
  domWindowMs: 5_000,
  emptyTimeoutMs: 2_000,
  minTimeoutMs: 3_000,
  maxTimeoutMs: 15_000,
  timeoutSlack: 3,
  maxSelectors: 5,
};

export interface ReactionWindow {
  actionAt: number;
  windowEnd: number;
  network: RawNetworkEvent[];
  dom: RawDomEvent[];
  baseUrl: string;
}

function uniq(values: string[], max: number): string[] {
  return Array.from(new Set(values)).slice(0, max);
}

/**
 * Turn one action's observed reaction into the wait the replayer will perform.
 *
 * The whole point is that replay waits on *signals*, never on sleeps: if the
 * recording saw a DELETE settle and a row vanish, replay waits for exactly
 * that, and proceeds the instant it happens.
 */
export function buildWaitAfter(
  window: ReactionWindow,
  rules: WaitRules = DEFAULT_WAIT_RULES,
): WaitAfter {
  const { actionAt, windowEnd, baseUrl } = window;

  const triggered = window.network.filter(
    (n) =>
      !isIncidentalRequest(n.url) &&
      n.startedAt >= actionAt &&
      n.startedAt <= actionAt + rules.triggerWindowMs &&
      n.settledAt !== null &&
      n.settledAt <= windowEnd,
  );

  const seen = new Set<string>();
  const network: NetworkWait[] = [];
  for (const n of triggered) {
    const urlPattern = normalizeUrlPattern(n.url, baseUrl);
    const key = `${n.method} ${urlPattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    network.push({ urlPattern, method: n.method });
  }

  const domEnd = Math.min(windowEnd, actionAt + rules.domWindowMs);
  const domEvents = window.dom.filter((d) => d.t >= actionAt && d.t <= domEnd);

  const appearedAll = domEvents.flatMap((d) => d.appeared);
  const goneAll = domEvents.flatMap((d) => d.gone);

  // An element that appeared and vanished inside one window is a flicker
  // (spinner, transient re-render) and is not a reliable signal either way.
  const flicker = new Set(appearedAll.filter((s) => goneAll.includes(s)));
  const domAppeared = uniq(
    appearedAll.filter((s) => !flicker.has(s)),
    rules.maxSelectors,
  );
  const domGone = uniq(
    goneAll.filter((s) => !flicker.has(s)),
    rules.maxSelectors,
  );

  const hasSignal = network.length > 0 || domAppeared.length > 0 || domGone.length > 0;
  if (!hasSignal) {
    return { timeoutMs: rules.emptyTimeoutMs, networkIdle: true };
  }

  // Budget from what actually happened: a 1.5s endpoint earns a generous
  // ceiling, an instant one fails fast instead of hanging on a fixed default.
  const settleTimes = [
    ...triggered.map((n) => (n.settledAt ?? actionAt) - actionAt),
    ...domEvents.map((d) => d.t - actionAt),
  ];
  const observed = settleTimes.length ? Math.max(...settleTimes) : 0;
  const timeoutMs = Math.min(
    rules.maxTimeoutMs,
    Math.max(rules.minTimeoutMs, Math.ceil((observed * rules.timeoutSlack) / 500) * 500),
  );

  const wait: WaitAfter = { timeoutMs };
  if (network.length) wait.network = network;
  if (domAppeared.length) wait.domAppeared = domAppeared;
  if (domGone.length) wait.domGone = domGone;
  return wait;
}
