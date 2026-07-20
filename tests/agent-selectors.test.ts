import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isStableClass, isStableToken } from '../src/recorder/agent/text.js';
import { bundleForPage } from './helpers/bundle.js';

/**
 * Selector generation and accessible-name computation are the load-bearing
 * parts of the IR: everything downstream inherits their mistakes. They run in
 * the page, so they are exercised here against a real DOM in a real browser
 * rather than a simulated one.
 */

interface AgentApi {
  buildCandidates(el: Element): string[];
  semanticOf(el: Element): string;
  appearedSelector(el: Element): string | null;
  goneSelector(el: Element): string | null;
  accessibleName(el: Element): string;
  getRole(el: Element): string | null;
}

declare global {
  interface Window {
    __agent: AgentApi;
  }
}

let browser: Browser;
let page: Page;
let bundle: string;

beforeAll(async () => {
  bundle = await bundleForPage(`
    import { buildCandidates, semanticOf, appearedSelector, goneSelector } from './selectors.js';
    import { accessibleName, getRole } from './roles.js';
    (window as any).__agent = { buildCandidates, semanticOf, appearedSelector, goneSelector, accessibleName, getRole };
  `);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

/** setContent replaces the document, so the bundle is re-injected each time. */
async function load(html: string): Promise<void> {
  await page.setContent(html);
  await page.evaluate(bundle);
}

afterAll(async () => {
  await browser?.close();
});

/** Load fixture HTML, then query the agent about one element in it. */
async function ask<K extends keyof AgentApi>(
  html: string,
  selector: string,
  method: K,
): Promise<ReturnType<AgentApi[K]>> {
  await load(html);
  return page.evaluate(
    ([sel, fn]) => {
      const el = document.querySelector(sel as string);
      if (!el) throw new Error(`fixture has no ${sel}`);
      const api = window.__agent as unknown as Record<string, (e: Element) => unknown>;
      return api[fn as string]!(el);
    },
    [selector, method] as const,
  ) as Promise<ReturnType<AgentApi[K]>>;
}

describe('token stability', () => {
  it('rejects build-generated class names', () => {
    for (const generated of [
      'css-1x2y3z',
      'sc-bdVaJa',
      'emotion-9f8a7b',
      '_button_1a2b3',
      'Button_root__2Xy4z',
      'a1b2c3d4e5f6',
    ]) {
      expect(isStableClass(generated), `${generated} should be rejected`).toBe(false);
    }
  });

  it('keeps hand-written class names', () => {
    for (const authored of ['sidebar', 'sensor-row', 'btn-primary', 'toast', 'nav_link']) {
      expect(isStableClass(authored), `${authored} should be kept`).toBe(true);
    }
  });

  it('rejects anything a CSS selector could not carry', () => {
    expect(isStableToken('w-1/2')).toBe(false);
    expect(isStableToken('9lives')).toBe(false);
    expect(isStableToken('')).toBe(false);
  });
});

describe('candidate generation', () => {
  it('prefers a test id above everything else', async () => {
    const candidates = await ask(
      '<button data-testid="save" id="save-btn" aria-label="Save">Save</button>',
      'button',
      'buildCandidates',
    );
    expect(candidates[0]).toBe('[data-testid="save"]');
    // The weaker options survive as fallbacks rather than being discarded.
    expect(candidates).toContain('#save-btn');
    expect(candidates.some((c) => c.startsWith('role=button'))).toBe(true);
  });

  it('falls back to role + accessible name when there is no test id', async () => {
    const candidates = await ask(
      '<div><button aria-label="Delete Sensor 4">Delete</button></div>',
      'button',
      'buildCandidates',
    );
    expect(candidates[0]).toBe('role=button[name="Delete Sensor 4"]');
  });

  it('disambiguates identical elements by index', async () => {
    const html = `
      <ul>
        <li><button>Delete</button></li>
        <li><button>Delete</button></li>
        <li><button>Delete</button></li>
      </ul>`;
    await load(html);
    const candidates = await page.evaluate(() =>
      window.__agent.buildCandidates(document.querySelectorAll('button')[2]!),
    );
    // Third of three identical buttons — without nth, replay would hit the first.
    expect(candidates.some((c) => c.includes('>> nth=2'))).toBe(true);
  });

  it('omits nth when the selector is already unique', async () => {
    const candidates = await ask(
      '<ul><li><button>Only one</button></li></ul>',
      'button',
      'buildCandidates',
    );
    expect(candidates.every((c) => !c.includes('>> nth='))).toBe(true);
  });

  it('keeps generated class names out of the CSS path', async () => {
    // A second span is required: the path stops as soon as it is unique, and
    // a bare tag is always unique in a one-element document.
    const candidates = await ask(
      `<main>
         <p><span>other</span></p>
         <div class="css-1x2y3z sensor-row"><span>hi</span></div>
       </main>`,
      '.sensor-row span',
      'buildCandidates',
    );
    const cssPath = candidates.find((c) => c.includes('span'));
    expect(cssPath).toBe('div.sensor-row > span');
  });

  it('offers a labelled ancestor when the click lands on an inner node', async () => {
    // Real report: `[data-sentry-label="Search-FilterSaveButton"] > div.r-dnmrzs > div`
    // was the ONLY fallback, and r-dnmrzs is a style hash. The labelled
    // ancestor alone is clickable and survives a restyle.
    const candidates = await ask(
      `<div data-sentry-label="Search-FilterSaveButton">
         <div class="r-dnmrzs"><div>Save</div></div>
       </div>`,
      '[data-sentry-label] div div',
      'buildCandidates',
    );
    expect(candidates).toContain('[data-sentry-label="Search-FilterSaveButton"]');
    expect(candidates.every((c) => !c.includes('r-dnmrzs'))).toBe(true);
  });

  it('treats data-sentry-label as a top-tier identifier', async () => {
    // Real apps label for telemetry far more consistently than they add test ids.
    const candidates = await ask(
      '<button data-sentry-label="SignIn-Continue">Continue</button>',
      'button',
      'buildCandidates',
    );
    expect(candidates[0]).toBe('[data-sentry-label="SignIn-Continue"]');
  });

  it('anchors a CSS path on the nearest test id ancestor', async () => {
    // Two structurally identical rows, so the path stays ambiguous until it
    // reaches something addressable.
    const candidates = await ask(
      `<div data-testid="row-7"><div class="cell"><em>x</em></div></div>
       <div data-testid="row-8"><div class="cell"><em>y</em></div></div>`,
      '[data-testid="row-7"] em',
      'buildCandidates',
    );
    expect(candidates).toContain('[data-testid="row-7"] > div.cell > em');
  });
});

describe('accessible name', () => {
  it('reads aria-label first', async () => {
    expect(await ask('<button aria-label="Close">×</button>', 'button', 'accessibleName')).toBe(
      'Close',
    );
  });

  it('reads a label associated by for', async () => {
    expect(
      await ask(
        '<label for="email">Email address</label><input id="email">',
        'input',
        'accessibleName',
      ),
    ).toBe('Email address');
  });

  it('reads a wrapping label', async () => {
    expect(
      await ask('<label>Full name <input type="text"></label>', 'input', 'accessibleName'),
    ).toBe('Full name');
  });

  it('falls back to placeholder', async () => {
    expect(await ask('<input placeholder="Search…">', 'input', 'accessibleName')).toBe('Search…');
  });

  it('uses text content only for name-from-content roles', async () => {
    expect(await ask('<button>Save changes</button>', 'button', 'accessibleName')).toBe(
      'Save changes',
    );
    // A div is not name-from-content; its text is not its accessible name.
    expect(await ask('<div>Just some prose</div>', 'div', 'accessibleName')).toBe('');
  });
});

describe('semantic description', () => {
  it('names the element and its row, without repeating itself', async () => {
    const semantic = await ask(
      '<ul><li><span>Sensor 2</span><button aria-label="Delete Sensor 2">Delete</button></li></ul>',
      'button',
      'semanticOf',
    );
    expect(semantic).toBe('Delete Sensor 2 button in the row containing "Sensor 2"');
  });

  it('falls back to a labelled section when there is no row', async () => {
    const semantic = await ask(
      '<section><h2>Reports</h2><button>Generate</button></section>',
      'button',
      'semanticOf',
    );
    expect(semantic).toBe('Generate button in the section labelled "Reports"');
  });
});

describe('wait-signal selectors', () => {
  it('accepts role+name for appeared but not for gone', async () => {
    const html = '<div role="status" aria-label="Saved">Saved</div>';
    // Waiting for *a* matching element to appear is right...
    expect(await ask(html, 'div', 'appearedSelector')).toBe('role=status[name="Saved"]');
    // ...but waiting for count===0 would never settle while siblings remain.
    expect(await ask(html, 'div', 'goneSelector')).toBeNull();
  });

  it('uses a test id for both', async () => {
    const html = '<div data-testid="toast">Saved</div>';
    expect(await ask(html, 'div', 'appearedSelector')).toBe('[data-testid="toast"]');
    expect(await ask(html, 'div', 'goneSelector')).toBe('[data-testid="toast"]');
  });
});
