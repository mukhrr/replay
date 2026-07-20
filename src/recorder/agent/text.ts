/** String and token helpers shared across the in-page agent. */

/** Collapse whitespace, trim, and cap length with an ellipsis. */
export function clean(s: string | null | undefined, max = 80): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Escape a value for use inside a double-quoted selector attribute. */
export function escAttr(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape an identifier for use in a CSS selector. */
export function escId(v: string): string {
  return typeof window.CSS?.escape === 'function'
    ? window.CSS.escape(v)
    : v.replace(/([^\w-])/g, '\\$1');
}

/**
 * Reject build-generated tokens. The goal is stability across rebuilds, so
 * anything carrying a content hash or a CSS-in-JS prefix is out.
 */
export function isStableToken(t: string): boolean {
  if (!t || t.length > 40) return false;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t)) return false;
  if (/^(css|sc|emotion|styled|jsx|glamor|makeStyles)-/i.test(t)) return false;
  if (/[0-9a-f]{6,}/i.test(t)) return false; // embedded hash
  if ((t.match(/\d/g) || []).length >= 3) return false; // numeric noise
  if (/[A-Z]/.test(t) && /\d/.test(t)) return false; // e.g. Button_root__2Xy4z
  // Atomic-CSS hashes: a 1-2 char namespace then an opaque blob. React Native
  // Web emits these (r-1awozwy, r-1mdbw0j) and they change whenever styling
  // does, so a CSS path built from them breaks on the next restyle.
  if (/^[a-z]{1,2}-[a-z0-9]{5,}$/i.test(t) && /\d/.test(t)) return false;
  // Per-session ids from a11y announcers and portal libraries (#zb5bjyh-aria).
  // They are regenerated on every page load, so they can never match on a
  // later run — a wait on one is guaranteed to time out.
  if (t.split(/[-_]/).some(looksGenerated)) return false;
  return true;
}

/**
 * A token that reads like a nanoid rather than a word: long enough to be
 * opaque, carries a digit, and is starved of vowels. `zb5bjyh` qualifies;
 * `button2` and `sidebar` do not.
 */
function looksGenerated(segment: string): boolean {
  if (segment.length < 6) return false;
  if (!/^[a-z0-9]+$/i.test(segment)) return false;
  if (!/\d/.test(segment)) return false;
  const vowels = (segment.match(/[aeiou]/gi) || []).length;
  return vowels <= 1;
}

export function isStableClass(c: string): boolean {
  return isStableToken(c) && !/^_/.test(c);
}

/**
 * Text as rendered. `textContent` concatenates across element boundaries —
 * a row reads "Sensor 2Delete" — whereas `innerText` respects layout and
 * separates them.
 */
export function renderedText(el: Element, max = 80): string {
  const inner = (el as HTMLElement).innerText;
  return clean(typeof inner === 'string' ? inner : el.textContent, max);
}
