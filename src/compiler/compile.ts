import {
  IR_VERSION,
  type Assertion,
  type FinalState,
  type Repro,
  type Step,
} from '../ir/schema.js';
import type { RawActionEvent, RecordingTrace } from '../recorder/types.js';
import { isAmbientConsoleError, isIncidentalRequest } from '../noise.js';
import { isSameOrigin, normalizeUrlPattern } from './normalize.js';
import { buildWaitAfter, DEFAULT_WAIT_RULES, type WaitRules } from './waits.js';

export interface CompileOptions {
  name: string;
  storageStatePath: string | null;
  createdAt?: string;
  waitRules?: WaitRules;
}

/** A click and a dblclick on the same element this close together are one gesture. */
const DBLCLICK_MERGE_MS = 600;
/** A navigation this soon after an action is that action's consequence, not a step. */
const NAV_ATTRIBUTION_MS = 1_000;

type Pending = RawActionEvent & { syntheticUrl?: string };

/**
 * Drop the two clicks that the browser necessarily fires before a dblclick.
 * Replaying click-click-dblclick would triple-fire the handler.
 */
function mergeDoubleClicks(actions: RawActionEvent[]): RawActionEvent[] {
  const out: RawActionEvent[] = [];
  for (const action of actions) {
    if (action.action === 'dblclick') {
      const key = action.target?.candidates[0];
      while (out.length) {
        const prev = out[out.length - 1];
        if (!prev) break;
        const sameTarget = prev.target?.candidates[0] === key;
        if (prev.action === 'click' && sameTarget && action.t - prev.t <= DBLCLICK_MERGE_MS) {
          out.pop();
          continue;
        }
        break;
      }
    }
    out.push(action);
  }
  return out;
}

/**
 * Navigations become steps only when nothing the user did explains them —
 * a typed URL or a back button. A navigation caused by clicking a link is the
 * click's reaction, and replaying both would double-navigate.
 */
function interleaveNavigations(actions: RawActionEvent[], trace: RecordingTrace): Pending[] {
  const merged: Pending[] = actions.map((a) => ({ ...a }));

  for (const nav of trace.navigations) {
    const caused = actions.some((a) => nav.t - a.t >= 0 && nav.t - a.t <= NAV_ATTRIBUTION_MS);
    if (caused) continue;
    merged.push({
      kind: 'action',
      action: 'goto',
      value: nav.url,
      target: null,
      t: nav.t,
      author: 'human',
      syntheticUrl: nav.url,
    });
  }

  return merged.sort((a, b) => a.t - b.t);
}

/** Collapse runs of scrolls on the same target down to the final position. */
function collapseScrolls(actions: Pending[]): Pending[] {
  const out: Pending[] = [];
  for (const action of actions) {
    const prev = out[out.length - 1];
    if (
      prev &&
      action.action === 'scroll' &&
      prev.action === 'scroll' &&
      prev.target?.candidates[0] === action.target?.candidates[0]
    ) {
      out[out.length - 1] = action;
      continue;
    }
    out.push(action);
  }
  return out;
}

export function compile(trace: RecordingTrace, options: CompileOptions): Repro {
  const rules = options.waitRules ?? DEFAULT_WAIT_RULES;
  const merged = collapseScrolls(interleaveNavigations(mergeDoubleClicks(trace.actions), trace));
  const traceEnd = trace.endedAt || Date.now();

  const steps: Step[] = merged.map((action, index) => {
    const next = merged[index + 1];
    const windowEnd = next ? next.t : traceEnd;

    const step: Step = {
      id: `s${index + 1}`,
      action: action.action,
      value: action.value,
      waitAfter: buildWaitAfter(
        {
          actionAt: action.t,
          windowEnd,
          network: trace.network,
          dom: trace.dom,
          baseUrl: trace.baseUrl,
        },
        rules,
      ),
      author: action.author,
    };

    if (action.target) {
      step.target = { candidates: action.target.candidates, semantic: action.target.semantic };
    }
    return step;
  });

  dropRerenderChurn(steps);

  return {
    version: IR_VERSION,
    name: options.name,
    createdAt: options.createdAt ?? new Date().toISOString(),
    baseUrl: trace.baseUrl,
    startPath: trace.startPath,
    viewport: trace.viewport,
    storageStatePath: options.storageStatePath,
    steps,
    assertion: deriveAssertion(steps, trace),
  };
}

/**
 * Console errors plausibly caused by the recorded flow.
 *
 * Two filters. Ambient patterns are dropped outright. Anything logged before
 * the first user action is dropped too: it happened during boot, so it happens
 * on every run regardless of what the flow does, which makes it useless as a
 * signature for this particular bug.
 */
function bugSignatureErrors(trace: RecordingTrace): string[] {
  const firstAction = trace.actions[0]?.t ?? trace.startedAt;
  return trace.console
    .filter((c) => c.t >= firstAction)
    .map((c) => c.text)
    .filter((text) => !isAmbientConsoleError(text));
}

/**
 * A selector that vanishes on one step and returns on the next is a component
 * re-mounting, not a state change. Replay sees the element present throughout
 * and can satisfy neither half, so both are dropped.
 */
function dropRerenderChurn(steps: Step[]): void {
  for (let i = 0; i < steps.length - 1; i++) {
    const a = steps[i];
    const b = steps[i + 1];
    if (!a || !b) continue;
    const gone = new Set(a.waitAfter.domGone ?? []);
    const churned = (b.waitAfter.domAppeared ?? []).filter((s) => gone.has(s));
    if (!churned.length) continue;
    a.waitAfter.domGone = (a.waitAfter.domGone ?? []).filter((s) => !churned.includes(s));
    b.waitAfter.domAppeared = (b.waitAfter.domAppeared ?? []).filter((s) => !churned.includes(s));
    if (!a.waitAfter.domGone.length) delete a.waitAfter.domGone;
    if (!b.waitAfter.domAppeared.length) delete b.waitAfter.domAppeared;
  }
}

/**
 * Phase 0's assertion is whatever the recording ended in. Because a repro
 * captures the BUG, an invariant that the recording itself violated is not a
 * usable check — it would make a fresh repro fail its own replay. Those get
 * switched off here, and the violation is preserved under `observedAtRecord`
 * so `--expect-fixed` can later assert the bug is gone.
 */
export function deriveAssertion(steps: Step[], trace: RecordingTrace): Assertion {
  const last = steps[steps.length - 1];

  const finalState: FinalState = {};
  if (last) {
    if (last.waitAfter.domAppeared?.length) finalState.domAppeared = last.waitAfter.domAppeared;
    if (last.waitAfter.domGone?.length) finalState.domGone = last.waitAfter.domGone;
    if (last.waitAfter.network?.length) finalState.network = last.waitAfter.network;
  }

  const consoleErrors = Array.from(new Set(bugSignatureErrors(trace)));

  // Third-party failures are not this app's bug and must not disable the check.
  const failedRequests = trace.network
    .filter((n) => n.failed && isSameOrigin(n.url, trace.baseUrl) && !isIncidentalRequest(n.url))
    .map((n) => ({
      urlPattern: normalizeUrlPattern(n.url, trace.baseUrl),
      method: n.method,
      status: n.status,
    }));

  const dedupedFailures = Array.from(
    new Map(failedRequests.map((f) => [`${f.method} ${f.urlPattern} ${f.status}`, f])).values(),
  );

  return {
    mode: 'expect-bug',
    finalState,
    invariants: {
      noConsoleErrors: consoleErrors.length === 0,
      noFailedRequests: dedupedFailures.length === 0,
    },
    observedAtRecord: {
      consoleErrors,
      failedRequests: dedupedFailures,
    },
  };
}
