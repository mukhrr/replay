import { matchesUrlPattern } from '../compiler/normalize.js';
import { isAmbientConsoleError, isIncidentalRequest } from '../noise.js';
import type { NetworkWait, Repro } from '../ir/schema.js';
import type { RawConsoleEvent, RawNetworkEvent } from '../recorder/types.js';

/**
 * Every endpoint the recording actually exercised. Failed-request checking is
 * scoped to these: a third-party analytics beacon 404-ing is noise, and letting
 * it fail a repro would make the tool untrustworthy within a day.
 */
export function recordedPatterns(repro: Repro): NetworkWait[] {
  const all: NetworkWait[] = [];
  for (const step of repro.steps) all.push(...(step.waitAfter.network ?? []));
  all.push(...(repro.assertion.finalState.network ?? []));
  for (const f of repro.assertion.observedAtRecord?.failedRequests ?? []) {
    all.push({ urlPattern: f.urlPattern, method: f.method });
  }
  const seen = new Set<string>();
  return all.filter((n) => {
    const key = `${n.method} ${n.urlPattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface InvariantViolation {
  invariant: 'noConsoleErrors' | 'noFailedRequests';
  detail: string;
}

/**
 * Did the specific bug this repro captured happen again?
 *
 * Deliberately narrow: it looks for the exact evidence recorded at authoring
 * time, not for "any console error". An app that always logs a benign warning
 * would otherwise never pass --expect-fixed, and a tool that cries wolf gets
 * turned off.
 */
/** Does this repro record anything that could tell us the bug came back? */
export function hasBugSignature(repro: Repro): boolean {
  const observed = repro.assertion.observedAtRecord;
  return Boolean(observed && (observed.consoleErrors.length || observed.failedRequests.length));
}

/** Has the author stated what must be true once it is fixed? */
export function hasFixCriterion(repro: Repro): boolean {
  const expected = repro.assertion.expectedWhenFixed;
  return Boolean(expected && (expected.domAppeared?.length || expected.domGone?.length));
}

export function checkBugRecurred(
  repro: Repro,
  network: RawNetworkEvent[],
  consoleErrors: RawConsoleEvent[],
  baseUrl: string,
): string[] {
  const observed = repro.assertion.observedAtRecord;
  if (!observed) return [];
  const recurred: string[] = [];

  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const live = consoleErrors
    .filter((c) => !isAmbientConsoleError(c.text))
    .map((c) => normalize(c.text));
  for (const recorded of observed.consoleErrors) {
    // Compare on a prefix: stack frames and ids drift between runs, the
    // message that identifies the bug does not.
    const needle = normalize(recorded).slice(0, 80);
    if (needle && live.some((l) => l.includes(needle))) {
      recurred.push(`console error recurred: ${recorded}`);
    }
  }

  for (const recorded of observed.failedRequests) {
    const again = network.some(
      (n) =>
        n.failed &&
        n.method.toUpperCase() === recorded.method.toUpperCase() &&
        matchesUrlPattern(n.url, recorded.urlPattern, baseUrl),
    );
    if (again) {
      recurred.push(
        `request failed again: ${recorded.method} ${recorded.urlPattern} -> ${recorded.status ?? 'aborted'}`,
      );
    }
  }

  return recurred;
}

export function checkInvariants(
  repro: Repro,
  network: RawNetworkEvent[],
  consoleErrors: RawConsoleEvent[],
  baseUrl: string,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (repro.assertion.invariants.noConsoleErrors) {
    // Same filter the compiler used. Without it the invariant is inferred from
    // filtered output but enforced against raw output, so ambient CORS and
    // connection errors fail every replay of a perfectly healthy app.
    for (const err of consoleErrors) {
      if (isAmbientConsoleError(err.text)) continue;
      violations.push({ invariant: 'noConsoleErrors', detail: err.text });
    }
  }

  if (repro.assertion.invariants.noFailedRequests) {
    const patterns = recordedPatterns(repro);
    for (const n of network) {
      // An aborted request is a cancellation — a navigation, an unmount, a
      // user moving on — not a server failure. Counting it made a same-host
      // telemetry beacon fail every replay, and host rules cannot catch that
      // because it is served from the app's own API origin.
      if (!n.failed || n.status === null || n.status < 400) continue;
      if (isIncidentalRequest(n.url)) continue;
      const inScope = patterns.some(
        (p) =>
          p.method.toUpperCase() === n.method.toUpperCase() &&
          matchesUrlPattern(n.url, p.urlPattern, baseUrl),
      );
      if (!inScope) continue;
      violations.push({
        invariant: 'noFailedRequests',
        detail: `${n.method} ${n.url} -> ${n.status ?? 'aborted'}`,
      });
    }
  }

  return violations;
}
