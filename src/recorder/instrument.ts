import type { Action } from '../ir/schema.js';
import type { PageEvent, RawActionEvent } from './types.js';

export interface AgentConfig {
  emitBinding: string;
  stopBinding: string;
  scrollDebounceMs: number;
  scrollMinDeltaPx: number;
  /** Cap on selectors harvested from a single mutation record, to bound cost. */
  maxSelectorsPerMutation: number;
  /** A hover only becomes a step if it revealed content this recently. */
  hoverRevealWindowMs: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  emitBinding: '__replayEmit',
  stopBinding: '__replayStop',
  scrollDebounceMs: 150,
  scrollMinDeltaPx: 50,
  maxSelectorsPerMutation: 12,
  hoverRevealWindowMs: 400,
};

/**
 * Helpers that TS/JS transforms inject into compiled output. They live in
 * module scope, which does not exist in the page, so a serialized function
 * body that references one throws on its first line.
 *
 * esbuild's `keepNames` (on by default under tsx) rewrites every function
 * declaration to `__name(fn, "…")`. Shimming these makes injection independent
 * of whichever toolchain compiled us — tsc, esbuild, swc, dev or prod.
 */
const HELPER_SHIMS = `
var __name = function (fn) { return fn; };
var __publicField = function (obj, key, value) { obj[key] = value; return value; };
var __defProp = Object.defineProperty;
`;

/**
 * The exact source injected into the page: helper shims, then the agent applied
 * to its config, all wrapped as one expression so it is valid both as an
 * init-script body and as an `evaluate` argument.
 */
export function agentSource(config: AgentConfig): string {
  return `(function () {${HELPER_SHIMS}(${pageAgent.toString()})(${JSON.stringify(config)});})()`;
}

/** Set once the agent has installed every listener; see `verifyInstrumentation`. */
export const AGENT_READY_FLAG = '__replayAgentReady';

/**
 * Runs inside the page. Serialized with `Function.prototype.toString`, so the
 * body MUST be self-contained: it may not reference any module-scope *value*.
 * Type-only references are fine — they are erased at compile time.
 *
 * Only the top frame records. Selectors generated in a subframe would not
 * resolve against the main frame at replay time, and Phase 0 has no frame
 * addressing in the IR.
 */
export function pageAgent(config: AgentConfig): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__replayAgentInstalled) return;
  if (window.top !== window) return;
  w.__replayAgentInstalled = true;

  // --- transport -----------------------------------------------------------
  // Exposed bindings may not be installed yet when the first events fire, so
  // queue until the binding shows up rather than dropping events on the floor.
  const pending: PageEvent[] = [];
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  function binding(name: string): ((arg: unknown) => unknown) | null {
    const fn = w[name];
    return typeof fn === 'function' ? (fn as (arg: unknown) => unknown) : null;
  }

  function drain(): void {
    const fn = binding(config.emitBinding);
    if (!fn) return;
    while (pending.length) {
      const ev = pending.shift();
      try {
        fn(ev);
      } catch {
        /* page torn down mid-emit */
      }
    }
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
  }

  function emit(ev: PageEvent): void {
    pending.push(ev);
    if (binding(config.emitBinding)) drain();
    else if (!drainTimer) drainTimer = setInterval(drain, 25);
  }

  // --- string helpers ------------------------------------------------------
  function clean(s: string | null | undefined, max = 80): string {
    if (!s) return '';
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function escAttr(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function escId(v: string): string {
    const css = w.CSS as { escape?: (s: string) => string } | undefined;
    return css && typeof css.escape === 'function' ? css.escape(v) : v.replace(/([^\w-])/g, '\\$1');
  }

  /**
   * Reject build-generated tokens. The goal is stability across rebuilds, so
   * anything carrying a content hash or a CSS-in-JS prefix is out.
   */
  function isStableToken(t: string): boolean {
    if (!t || t.length > 40) return false;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t)) return false;
    if (/^(css|sc|emotion|styled|jsx|glamor|makeStyles)-/i.test(t)) return false;
    if (/[0-9a-f]{6,}/i.test(t)) return false; // embedded hash
    if ((t.match(/\d/g) || []).length >= 3) return false; // numeric noise
    if (/[A-Z]/.test(t) && /\d/.test(t)) return false; // e.g. Button_root__2Xy4z
    return true;
  }

  function isStableClass(c: string): boolean {
    return isStableToken(c) && !/^_/.test(c);
  }

  // --- roles and names -----------------------------------------------------
  const TAG_ROLES: Record<string, string> = {
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    form: 'form',
    table: 'table',
    tr: 'row',
    td: 'cell',
    th: 'columnheader',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    dialog: 'dialog',
    option: 'option',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  };

  const INPUT_ROLES: Record<string, string> = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    email: 'textbox',
    tel: 'textbox',
    text: 'textbox',
    url: 'textbox',
  };

  function getRole(el: Element): string | null {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0] || null;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'img') return el.getAttribute('alt') === '' ? null : 'img';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return INPUT_ROLES[type] ?? null;
    }
    return TAG_ROLES[tag] ?? null;
  }

  function isEditable(el: Element | null): el is HTMLElement {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (tag !== 'input') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image'].includes(type);
  }

  /** Roles whose accessible name comes from their own text content. */
  const NAME_FROM_CONTENT = [
    'button',
    'link',
    'heading',
    'cell',
    'columnheader',
    'rowheader',
    'listitem',
    'option',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'switch',
    'checkbox',
    'radio',
  ];

  /**
   * A pragmatic subset of the accname algorithm — enough to make role+name
   * selectors useful, without shipping the full 600-line spec. Order follows
   * accname's precedence for the sources we do implement.
   */
  function accessibleName(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => !!n)
        .map((n) => clean(n.textContent));
      const joined = clean(parts.filter(Boolean).join(' '));
      if (joined) return joined;
    }

    const tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag)) {
      const id = el.getAttribute('id');
      if (id) {
        const forLabel = document.querySelector(`label[for="${escAttr(id)}"]`);
        if (forLabel) {
          const t = clean(forLabel.textContent);
          if (t) return t;
        }
      }
      const wrapping = el.closest('label');
      if (wrapping) {
        const t = clean(wrapping.textContent);
        if (t) return t;
      }
    }

    for (const attr of ['alt', 'title', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v && v.trim()) return clean(v);
    }

    const role = getRole(el);
    if (role && NAME_FROM_CONTENT.includes(role)) {
      const t = clean(el.textContent);
      if (t) return t;
    }
    return '';
  }

  /** Text of the element itself, used for the `text=` candidate. */
  function ownText(el: Element): string {
    return clean(el.textContent, 60);
  }

  // --- selector candidates -------------------------------------------------
  const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy'];

  function testIdSelector(el: Element): string | null {
    for (const attr of TEST_ID_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) return `[${attr}="${escAttr(v)}"]`;
    }
    return null;
  }

  function idSelector(el: Element): string | null {
    const id = el.getAttribute('id');
    return id && isStableToken(id) ? `#${escId(id)}` : null;
  }

  function roleNameSelector(el: Element): string | null {
    const role = getRole(el);
    if (!role) return null;
    const name = accessibleName(el);
    if (!name) return null;
    return `role=${role}[name="${escAttr(name)}"]`;
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

  function buildCssPath(el: Element): string | null {
    const segs: string[] = [];
    let cur: Element | null = el;
    let depth = 0;

    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 6) {
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
        const sameTag = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName,
        );
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

  function buildCandidates(el: Element): string[] {
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

    const text = ownText(el);
    if (text) {
      const matches = allElements().filter((c) => ownText(c) === text);
      push(withNth(`text="${escAttr(text)}"`, el, matches));
    }

    return out.slice(0, 5);
  }

  /**
   * Text as rendered. `textContent` concatenates across element boundaries —
   * a row reads "Sensor 2Delete" — whereas `innerText` respects layout and
   * separates them.
   */
  function renderedText(el: Element, max = 80): string {
    const inner = (el as HTMLElement).innerText;
    return clean(typeof inner === 'string' ? inner : el.textContent, max);
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

  function semanticOf(el: Element): string {
    const role = getRole(el) || el.tagName.toLowerCase();
    const name = accessibleName(el) || ownText(el);
    const head = name ? `${name} ${role}` : role;
    return head + contextLabel(el);
  }

  function describe(el: Element): { candidates: string[]; semantic: string } | null {
    const candidates = buildCandidates(el);
    if (!candidates.length) return null;
    return { candidates, semantic: semanticOf(el) };
  }

  // --- visibility and DOM reaction ----------------------------------------
  function isVisible(el: Element): boolean {
    if (!el.isConnected) return false;
    const he = el as HTMLElement;
    if (he.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const rect = he.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const cs = window.getComputedStyle(he);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  /**
   * Selectors durable enough to wait on. `appeared` tolerates role+name because
   * waiting for *a* matching element is the right semantic; `gone` does not,
   * because a wait for count===0 would never settle while siblings remain.
   */
  function appearedSelector(el: Element): string | null {
    return testIdSelector(el) ?? idSelector(el) ?? roleNameSelector(el);
  }

  function goneSelector(el: Element): string | null {
    return testIdSelector(el) ?? idSelector(el);
  }

  const visibility = new WeakMap<Element, boolean>();
  let lastReveal: { el: Element; nodes: Element[]; t: number } | null = null;
  let lastHovered: Element | null = null;
  let lastActionAt = 0;

  /**
   * DOM landing right after an action is that action's consequence, not a
   * hover's. Without this, clicking "Add" and then clicking inside the new row
   * would invent a bogus hover step on the Add button.
   */
  const REVEAL_ACTION_COOLDOWN_MS = 600;

  function harvest(
    nodes: NodeList,
    into: Set<string>,
    pick: (el: Element) => string | null,
    revealed: Element[],
  ): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || node.nodeType !== 1) continue;
      const el = node as Element;
      revealed.push(el);

      const own = pick(el);
      if (own && into.size < config.maxSelectorsPerMutation) into.add(own);

      const descendants = el.querySelectorAll(
        '[data-testid], [data-test], [data-test-id], [data-cy], [id], [role], button, a[href]',
      );
      for (let j = 0; j < descendants.length && into.size < config.maxSelectorsPerMutation; j++) {
        const d = descendants[j];
        if (!d) continue;
        const sel = pick(d);
        if (sel) into.add(sel);
      }
    }
  }

  function startObserver(): void {
    const observer = new MutationObserver((records) => {
      const appeared = new Set<string>();
      const gone = new Set<string>();
      const revealed: Element[] = [];

      // Only elements that are actually rendered make usable appear-signals.
      // An <option> inside a <select> has no layout box, so a replay waiting
      // for it to become visible would hang until the step timed out.
      const visibleAppearedSelector = (el: Element): string | null =>
        isVisible(el) ? appearedSelector(el) : null;

      for (const rec of records) {
        if (rec.type === 'childList') {
          harvest(rec.addedNodes, appeared, visibleAppearedSelector, revealed);
          harvest(rec.removedNodes, gone, goneSelector, []);
        } else if (rec.type === 'attributes') {
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
      }

      const now = Date.now();
      if (revealed.length && lastHovered && now - lastActionAt > REVEAL_ACTION_COOLDOWN_MS) {
        lastReveal = { el: lastHovered, nodes: revealed, t: now };
      }

      if (appeared.size || gone.size) {
        emit({
          kind: 'dom',
          appeared: Array.from(appeared),
          gone: Array.from(gone),
          t: Date.now(),
        });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }

  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  // --- action capture ------------------------------------------------------
  function emitAction(action: Action, el: Element | null, value: string | null): void {
    const target = el ? describe(el) : null;
    if (el && !target) return; // nothing addressable — a step we could never replay
    lastActionAt = Date.now();
    const ev: RawActionEvent = {
      kind: 'action',
      action,
      value,
      target,
      t: lastActionAt,
      author: 'human',
    };
    emit(ev);
  }

  /**
   * A hover only earns a step when it revealed the content we are now acting on
   * — the hover-to-open menu case, where replay would otherwise click a hidden
   * element. Incidental mouse travel is dropped.
   */
  function flushRevealingHover(actionTarget: Element | null): void {
    const reveal = lastReveal;
    lastReveal = null;
    if (!reveal || !actionTarget) return;
    if (Date.now() - reveal.t > config.hoverRevealWindowMs) return;
    if (!reveal.el.isConnected) return;
    // Load-bearing means: the thing we are about to act on lives inside what
    // the hover revealed.
    if (!reveal.nodes.some((n) => n === actionTarget || n.contains(actionTarget))) return;
    emitAction('hover', reveal.el, null);
  }

  function targetOf(e: Event): Element | null {
    const t = e.target;
    return t && (t as Node).nodeType === 1 ? (t as Element) : null;
  }

  // fill: committed on change/blur, never per keystroke
  const focusValue = new WeakMap<Element, string>();
  const committed = new WeakMap<Element, string>();

  function valueOf(el: Element): string {
    if ((el as HTMLElement).isContentEditable) return clean((el as HTMLElement).innerText, 500);
    return (el as HTMLInputElement).value ?? '';
  }

  function commitFill(el: Element): void {
    if (!isEditable(el)) return;
    const value = valueOf(el);
    if (committed.get(el) === value) return;
    if (focusValue.get(el) === value && committed.get(el) === undefined) return;
    committed.set(el, value);
    flushRevealingHover(el);
    emitAction('fill', el, value);
  }

  /**
   * Commit an edit that is still sitting in the focused field before recording
   * whatever the user just did instead.
   *
   * `change`/`blur` are the commit triggers, but they are not guaranteed to
   * fire *before* the next action: programmatic drivers frequently move on
   * without blurring, which would emit the fill after the action it preceded
   * and put the IR out of order. This only fixes ordering — it never commits a
   * value that change/blur would not have committed anyway.
   */
  function flushPendingFill(): void {
    const active = document.activeElement;
    if (active && isEditable(active)) commitFill(active);
  }

  document.addEventListener(
    'focusin',
    (e) => {
      const el = targetOf(e);
      if (el && isEditable(el)) focusValue.set(el, valueOf(el));
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      const el = targetOf(e);
      if (!el) return;
      flushPendingFill();
      flushRevealingHover(el);
      emitAction('click', el, null);
    },
    true,
  );

  document.addEventListener(
    'dblclick',
    (e) => {
      const el = targetOf(e);
      if (!el) return;
      flushPendingFill();
      emitAction('dblclick', el, null);
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = targetOf(e);
      if (!el) return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        const opt = sel.selectedOptions[0];
        flushPendingFill();
        flushRevealingHover(el);
        emitAction('select', el, opt ? opt.value || clean(opt.textContent) : sel.value);
        return;
      }
      // Checkbox/radio state changes are already represented by their click.
      if (isEditable(el)) commitFill(el);
    },
    true,
  );

  document.addEventListener(
    'blur',
    (e) => {
      const el = targetOf(e);
      if (el && isEditable(el)) commitFill(el);
    },
    true,
  );

  document.addEventListener(
    'mouseover',
    (e) => {
      const el = targetOf(e);
      if (el) lastHovered = el;
    },
    true,
  );

  const MEANINGFUL_KEYS = [
    'Enter',
    'Escape',
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Backspace',
    'Delete',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    ' ',
  ];

  function playwrightKey(e: KeyboardEvent): string {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.metaKey) mods.push('Meta');
    if (e.shiftKey && e.key.length > 1) mods.push('Shift');
    const key = e.key === ' ' ? 'Space' : e.key;
    return [...mods, key].join('+');
  }

  document.addEventListener(
    'keydown',
    (e) => {
      // Recording hotkey: swallowed entirely so it never lands in the IR.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        e.stopPropagation();
        const stop = binding(config.stopBinding);
        if (stop) stop({ reason: 'hotkey' });
        return;
      }

      const el = targetOf(e);
      if (isEditable(el)) {
        // Inside a field only Enter and Escape carry meaning (submit / dismiss).
        // Typing itself is captured as a single `fill` on commit.
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        commitFill(el);
      } else if (!MEANINGFUL_KEYS.includes(e.key) && !(e.ctrlKey || e.metaKey || e.altKey)) {
        return;
      } else {
        flushPendingFill();
      }
      emitAction('press', el, playwrightKey(e));
    },
    true,
  );

  // scroll: debounced, and only when the position actually moved
  const scrollState = new WeakMap<object, { x: number; y: number }>();
  const scrollTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

  document.addEventListener(
    'scroll',
    (e) => {
      const raw = e.target;
      const isDocument = !raw || raw === document || raw === document.documentElement || raw === document.body;
      const key: object = isDocument ? document : (raw as object);
      const el = isDocument ? null : (raw as Element);
      const x = el ? el.scrollLeft : window.scrollX;
      const y = el ? el.scrollTop : window.scrollY;

      const existing = scrollTimers.get(key);
      if (existing) clearTimeout(existing);
      scrollTimers.set(
        key,
        setTimeout(() => {
          const last = scrollState.get(key) ?? { x: 0, y: 0 };
          if (
            Math.abs(x - last.x) < config.scrollMinDeltaPx &&
            Math.abs(y - last.y) < config.scrollMinDeltaPx
          ) {
            return;
          }
          scrollState.set(key, { x, y });
          emitAction('scroll', el, JSON.stringify({ x, y }));
        }, config.scrollDebounceMs),
      );
    },
    true,
  );

  // Last line on purpose: reaching it proves every listener above installed.
  // A recording that silently captures nothing is the worst failure this tool
  // could have, so the caller asserts on this flag.
  w.__replayAgentReady = true;
}
