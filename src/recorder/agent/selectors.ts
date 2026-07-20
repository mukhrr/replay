import type { CapturedTarget } from '../types.js';
import { accessibleName, getRole, ownText } from './roles.js';
import { clean, escAttr, escId, isStableClass, isStableToken, renderedText } from './text.js';

/**
 * Selector-candidate generation.
 *
 * Everything here runs while the element is still live and attached, which is
 * the only moment these can be computed reliably — and the only way `domGone`
 * can name a node that is already detached by the time we report it.
 */

/**
 * Attributes an app deliberately puts on an element to identify it. Ordered by
 * how conventional they are.
 *
 * `data-sentry-label` is here because real apps label elements for telemetry
 * far more consistently than they add test ids — Expensify labels nearly every
 * interactive element that way, and those labels are as stable as a test id.
 */
const TEST_ID_ATTRS = [
  'data-testid',
  'data-test',
  'data-test-id',
  'data-cy',
  'data-sentry-label',
  'data-testid-label',
];
const MAX_CANDIDATES = 5;
const MAX_CSS_PATH_DEPTH = 6;

export function testIdSelector(el: Element): string | null {
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `[${attr}="${escAttr(v)}"]`;
  }
  return null;
}

export function idSelector(el: Element): string | null {
  const id = el.getAttribute('id');
  return id && isStableToken(id) ? `#${escId(id)}` : null;
}

export function roleNameSelector(el: Element): string | null {
  const role = getRole(el);
  if (!role) return null;
  const name = accessibleName(el);
  if (!name) return null;
  return `role=${role}[name="${escAttr(name)}"]`;
}

/**
 * Selectors durable enough to wait on. `appeared` tolerates role+name because
 * waiting for *a* matching element is the right semantic; `gone` does not,
 * because a wait for count===0 would never settle while siblings remain.
 */
export function appearedSelector(el: Element): string | null {
  return testIdSelector(el) ?? idSelector(el) ?? roleNameSelector(el);
}

export function goneSelector(el: Element): string | null {
  return testIdSelector(el) ?? idSelector(el);
}

function allElements(): Element[] {
  return Array.from(document.querySelectorAll('*'));
}

/** Append `>> nth=N` only when the base selector is genuinely ambiguous. */
function withNth(base: string, el: Element, matches: Element[]): string {
  if (matches.length <= 1) return base;
  const idx = matches.indexOf(el);
  return idx < 0 ? base : `${base} >> nth=${idx}`;
}

export function buildCssPath(el: Element): string | null {
  const segs: string[] = [];
  let cur: Element | null = el;
  let depth = 0;

  while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < MAX_CSS_PATH_DEPTH) {
    const node: Element = cur;

    // Anchoring on a testid/id ancestor beats a long fragile tag chain.
    if (depth > 0) {
      const anchor = testIdSelector(node) ?? idSelector(node);
      if (anchor) {
        segs.unshift(anchor);
        break;
      }
    }

    let seg = node.tagName.toLowerCase();
    const classes = Array.from(node.classList).filter(isStableClass).slice(0, 2);
    if (classes.length) seg += `.${classes.map(escId).join('.')}`;

    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    segs.unshift(seg);

    const partial = segs.join(' > ');
    try {
      if (document.querySelectorAll(partial).length === 1) return partial;
    } catch {
      return null;
    }

    cur = parent;
    depth++;
  }

  if (!segs.length) return null;
  const sel = segs.join(' > ');
  try {
    return document.querySelectorAll(sel).length ? sel : null;
  } catch {
    return null;
  }
}

/**
 * Candidates in priority order:
 *   test id / stable id → name attribute → role + accessible name
 *   → stable CSS path → text anchor
 */
export function buildCandidates(el: Element): string[] {
  const out: string[] = [];
  const push = (s: string | null): void => {
    if (s && out.indexOf(s) === -1) out.push(s);
  };

  push(testIdSelector(el));
  push(idSelector(el));

  const nameAttr = el.getAttribute('name');
  if (nameAttr && isStableToken(nameAttr)) {
    push(`${el.tagName.toLowerCase()}[name="${escAttr(nameAttr)}"]`);
  }

  const roleName = roleNameSelector(el);
  if (roleName) {
    const role = getRole(el);
    const name = accessibleName(el);
    const matches = allElements().filter((c) => getRole(c) === role && accessibleName(c) === name);
    push(withNth(roleName, el, matches));
  }

  push(buildCssPath(el));
  push(labelledAncestorSelector(el));

  const text = ownText(el);
  if (text && isSmallestWithText(el, text)) {
    const matches = allElements().filter((c) => isSmallestWithText(c, text));
    push(withNth(`text="${escAttr(text)}"`, el, matches));
  }

  return out.slice(0, MAX_CANDIDATES);
}

/**
 * The nearest identifiable ancestor, offered as a late fallback.
 *
 * When a click lands on an inner node of a labelled control, the CSS path
 * descends from the label into style hashes and there is nothing else to fall
 * back to. The labelled ancestor is usually clickable and always more durable,
 * so it is worth having behind the more precise candidates.
 *
 * Only offered when the element has no identity of its own, and only for
 * ancestors close enough to be the same control.
 */
function labelledAncestorSelector(el: Element): string | null {
  if (testIdSelector(el) ?? idSelector(el)) return null;

  let cur = el.parentElement;
  for (let depth = 0; cur && depth < 3; depth++) {
    const anchor = testIdSelector(cur);
    if (anchor) {
      try {
        // Ambiguous ancestors are worse than no fallback at all.
        return document.querySelectorAll(anchor).length === 1 ? anchor : null;
      } catch {
        return null;
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Playwright's `text=` engine matches the *smallest* element containing the
 * text, so an ancestor whose only content is that text does not match.
 *
 * Counting ancestors here would shift every index: a lone `<ul><li><button>Go`
 * would record `text="Go" >> nth=2` when replay sees exactly one match, and the
 * selector would resolve to nothing.
 */
function isSmallestWithText(el: Element, text: string): boolean {
  if (ownText(el) !== text) return false;
  return !Array.from(el.children).some((child) => ownText(child) === text);
}

function contextLabel(el: Element): string {
  const row = el.closest('tr, [role="row"], li, [role="listitem"], [data-testid*="row"]');
  if (row && row !== el) {
    // Strip the element's own label so the context names its surroundings,
    // not the thing we already named: "the row containing Sensor 2", not
    // "the row containing Sensor 2 Delete".
    const own = renderedText(el, 60);
    const full = renderedText(row, 120);
    const t = clean(own ? full.split(own).join(' ') : full, 60);
    if (t) return ` in the row containing "${t}"`;
  }
  const section = el.closest('form, section, dialog, [role="dialog"], nav, main, aside');
  if (section && section !== el) {
    const label =
      section.getAttribute('aria-label') ||
      clean(section.querySelector('h1, h2, h3, h4, legend')?.textContent) ||
      '';
    if (label) return ` in the ${section.tagName.toLowerCase()} labelled "${clean(label, 40)}"`;
  }
  return '';
}

/**
 * Plain-language description of an element, from role + accessible name +
 * nearest row/section label. Rule-based, no LLM. Surfaces in failure messages
 * and is the re-grounding prompt for Phase 1 self-heal.
 */
export function semanticOf(el: Element): string {
  const role = getRole(el) || el.tagName.toLowerCase();
  const name = accessibleName(el) || ownText(el);
  const head = name ? `${name} ${role}` : role;
  return head + contextLabel(el);
}

/** Null when the element has no addressable selector at all. */
export function describe(el: Element): CapturedTarget | null {
  const candidates = buildCandidates(el);
  if (!candidates.length) return null;
  return { candidates, semantic: semanticOf(el) };
}
