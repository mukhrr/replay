import type { Repro } from '../ir/schema.js';

/**
 * Point a repro recorded against one deployment at another.
 *
 * This is the promise the tool is named for: record where the bug lives —
 * staging, production — and replay where the fix lives, on localhost. Doing it
 * by hand meant rewriting every `goto` value, every absolute network pattern,
 * and the `origin` key of the storage-state file, which is a lot of JSON
 * surgery for what is conceptually one substitution.
 *
 * Three things carry an origin and all three must move together:
 *
 *   - `goto` step values           — already rebased at replay time
 *   - absolute network patterns    — `https://staging.example.com/api/*` can
 *                                    never match a same-origin dev proxy
 *   - storage state                — cookies and localStorage are origin-keyed,
 *                                    so a session restored under the old origin
 *                                    is a session the new one cannot see
 */

/**
 * Is this origin part of the same application?
 *
 * An app and its API usually sit on sibling hosts (`app.example.com` and
 * `api.example.com`), and both must move. A CDN or an analytics endpoint must
 * not: rewriting those would point third-party traffic at your dev server.
 *
 * Registrable domain is approximated by the last two labels. That is wrong for
 * multi-part suffixes like `co.uk`, where it will treat two unrelated sites as
 * siblings — the cost is an over-eager rewrite of a pattern, not a broken run.
 */
export function isSameApplication(origin: string, appOrigin: string): boolean {
  try {
    const a = new URL(origin);
    const b = new URL(appOrigin);
    if (a.hostname === b.hostname) return true;
    // Any localhost port is the same local app.
    const local = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '::1';
    if (local(a.hostname) && local(b.hostname)) return true;
    const registrable = (h: string) => h.split('.').slice(-2).join('.');
    return registrable(a.hostname) === registrable(b.hostname);
  } catch {
    return false;
  }
}

/**
 * Rewrite absolute network patterns belonging to the app so they match at the
 * target.
 *
 * They become path-only, which `matchesUrlPattern` compares against any
 * same-origin request. That covers the usual local setup, where the API is
 * proxied onto the app's own origin. A target that keeps the API on a separate
 * host is not handled — say so rather than pretend.
 */
function retargetPattern(pattern: string, appOrigin: string): string {
  if (!pattern.startsWith('http')) return pattern;
  try {
    const u = new URL(pattern);
    if (!isSameApplication(u.origin, appOrigin)) return pattern;
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return pattern;
  }
}

/** A copy of the repro with every app-owned origin removed from its patterns. */
export function retargetRepro(repro: Repro, envUrl: string): Repro {
  const appOrigin = repro.baseUrl;
  const next: Repro = JSON.parse(JSON.stringify(repro));

  for (const step of next.steps) {
    if (step.waitAfter.network) {
      for (const n of step.waitAfter.network) {
        n.urlPattern = retargetPattern(n.urlPattern, appOrigin);
      }
    }
  }
  for (const n of next.assertion.finalState.network ?? []) {
    n.urlPattern = retargetPattern(n.urlPattern, appOrigin);
  }
  for (const f of next.assertion.observedAtRecord?.failedRequests ?? []) {
    f.urlPattern = retargetPattern(f.urlPattern, appOrigin);
  }

  next.baseUrl = envUrl;
  return next;
}

interface StorageStateCookie {
  domain: string;
  [key: string]: unknown;
}

interface StorageStateOrigin {
  origin: string;
  [key: string]: unknown;
}

export interface StorageState {
  cookies?: StorageStateCookie[];
  origins?: StorageStateOrigin[];
}

/**
 * Move a captured session onto the target origin.
 *
 * Cookies and localStorage are keyed by origin, so a state file restored as-is
 * authenticates the environment it was recorded against and leaves the target
 * signed out — which looks like a bug in the app rather than in the setup.
 */
export function retargetStorageState(state: StorageState, from: string, to: string): StorageState {
  let target: URL;
  try {
    target = new URL(to);
  } catch {
    return state;
  }

  const cookies = (state.cookies ?? []).map((c) => {
    if (!isSameApplication(`https://${c.domain.replace(/^\./, '')}`, from)) return c;
    return { ...c, domain: target.hostname };
  });

  const origins = (state.origins ?? []).map((o) => {
    if (!isSameApplication(o.origin, from)) return o;
    return { ...o, origin: target.origin };
  });

  return { ...state, cookies, origins };
}
