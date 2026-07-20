import type { AgentConfig } from './config.js';
import type { RevealTracker } from './reveal-tracker.js';
import { isTransientIndicator } from '../../noise.js';
import { accessibleName, getRole } from './roles.js';
import { appearedSelector, goneSelector } from './selectors.js';
import type { Transport } from './transport.js';
import { isVisible } from './visibility.js';

/**
 * Summarizes DOM mutations into the appeared/gone selectors that become a
 * step's `waitAfter`. This is what lets replay wait on a real signal instead of
 * a guessed sleep.
 */

/** Descendants worth checking inside an added subtree. */
const INTERESTING = '[data-testid], [data-test], [data-test-id], [data-cy], [id], [role], button, a[href]';

const OBSERVED_ATTRS = ['class', 'style', 'hidden', 'aria-hidden'];

/**
 * Longest an appearance waits for confirmation before being recorded.
 *
 * On a busy React app most DOM churn after an action is unrelated to it —
 * portals, context menus, tooltips and virtualised rows mount and unmount
 * constantly. Recording all of it produces waits the app will never satisfy,
 * and the replay then fails on a perfectly healthy build.
 *
 * The confirmation also flushes early, the moment the next action is captured,
 * because that is exactly when replay stops waiting and moves on. Confirming on
 * a fixed timer alone would discard real signals in a fast or agent-driven
 * flow, where the next action lands well inside this window.
 *
 * `gone` needs no such check: a removed node stays removed.
 */
const APPEAR_CONFIRM_MS = 600;

export interface DomReactionContext {
  config: AgentConfig;
  transport: Transport;
  reveals: RevealTracker;
}

export interface DomReactionHandle {
  /** Confirm and emit any pending appearances now. */
  flushAppearances(): void;
}

/** Playwright selector -> something document.querySelector can evaluate. */
function toCssSelector(selector: string): string {
  if (selector.startsWith('role=') || selector.startsWith('text=')) {
    throw new Error('not a CSS selector');
  }
  return selector;
}

function harvest(
  nodes: NodeList,
  into: Set<string>,
  pick: (el: Element) => string | null,
  revealed: Element[],
  max: number,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node || node.nodeType !== 1) continue;
    const el = node as Element;
    revealed.push(el);

    const own = pick(el);
    if (own && into.size < max) into.add(own);

    const descendants = el.querySelectorAll(INTERESTING);
    for (let j = 0; j < descendants.length && into.size < max; j++) {
      const d = descendants[j];
      if (!d) continue;
      const sel = pick(d);
      if (sel) into.add(sel);
    }
  }
}

export function observeDomReactions(ctx: DomReactionContext): DomReactionHandle {
  const { config, transport, reveals } = ctx;
  const visibility = new WeakMap<Element, boolean>();

  /** Appearances awaiting confirmation, keyed by their original timestamp. */
  let pending: { selectors: string[]; at: number; timer: ReturnType<typeof setTimeout> }[] = [];

  const stillVisible = (sel: string): boolean => {
    try {
      const el = document.querySelector(toCssSelector(sel));
      return el ? isVisible(el) : false;
    } catch {
      // role=/text= selectors are not queryable here. Keep them: they came from
      // a high-priority path, and dropping one on a syntax technicality would
      // lose real signal.
      return true;
    }
  };

  const confirm = (entry: { selectors: string[]; at: number }): void => {
    const survived = entry.selectors.filter(stillVisible);
    // Carries the ORIGINAL timestamp so the compiler still attributes it to the
    // action that caused it, not to the confirmation delay.
    if (survived.length) {
      transport.emit({ kind: 'dom', appeared: survived, gone: [], t: entry.at });
    }
  };

  const flushAppearances = (): void => {
    const due = pending;
    pending = [];
    for (const entry of due) {
      clearTimeout(entry.timer);
      confirm(entry);
    }
  };

  // Only rendered elements make usable appear-signals; see visibility.ts.
  // Loading indicators are excluded by what they are, not how long they last:
  // a spinner genuinely survives to the next action on a cold run, then never
  // renders at all once the data is cached — so a healthy replay would fail.
  const visibleAppearedSelector = (el: Element): string | null => {
    if (!isVisible(el)) return null;
    if (isTransientIndicator(getRole(el), accessibleName(el))) return null;
    return appearedSelector(el);
  };

  const start = (): void => {
    const observer = new MutationObserver((records) => {
      const appeared = new Set<string>();
      const gone = new Set<string>();
      const revealed: Element[] = [];

      for (const rec of records) {
        if (rec.type === 'childList') {
          harvest(rec.addedNodes, appeared, visibleAppearedSelector, revealed, config.maxSelectorsPerMutation);
          harvest(rec.removedNodes, gone, goneSelector, [], config.maxSelectorsPerMutation);
          continue;
        }

        // An attribute change can flip visibility without touching the tree —
        // the CSS-hidden toast case, which childList alone would miss.
        const el = rec.target as Element;
        const sel = appearedSelector(el);
        if (!sel) continue;
        const now = isVisible(el);
        const was = visibility.get(el);
        visibility.set(el, now);
        // First sighting only seeds the cache; it is not a transition.
        if (was === undefined || was === now) continue;
        if (now) {
          appeared.add(sel);
          revealed.push(el);
        } else {
          const g = goneSelector(el);
          if (g) gone.add(g);
        }
      }

      const at = Date.now();
      reveals.noteRevealed(revealed, at);

      // Emitted immediately — a removal is already final.
      if (gone.size) {
        transport.emit({ kind: 'dom', appeared: [], gone: Array.from(gone), t: at });
      }

      if (appeared.size) {
        const entry = {
          selectors: Array.from(appeared),
          at,
          timer: setTimeout(() => {
            pending = pending.filter((e) => e !== entry);
            confirm(entry);
          }, APPEAR_CONFIRM_MS),
        };
        pending.push(entry);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
  };

  // The init script can run before <html> exists.
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  return { flushAppearances };
}
