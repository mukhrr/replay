import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

type ContextStorageState = NonNullable<
  NonNullable<Parameters<Browser['newContext']>[0]>['storageState']
>;

/**
 * Opening a browser is shared by recording and replay, and both need the same
 * two ways of getting an authenticated session.
 *
 * Session seeding is the single thing that decides whether this tool works on a
 * real app, because every target worth verifying is behind a login:
 *
 * - `storageStatePath` — a portable JSON snapshot. Isolated and deterministic:
 *   every run starts from an identical session. Now includes IndexedDB, without
 *   which offline-first apps (Onyx, Dexie, Firebase Auth) cannot be seeded at
 *   all — their tokens never touch cookies or localStorage.
 *
 * - `profileDir` — a real Chromium profile directory. Everything persists:
 *   IndexedDB, service workers, caches. It also sidesteps non-idempotent signup,
 *   because you never sign up twice. The cost is isolation: state accumulates
 *   across runs, so the tenth replay does not start where the first one did.
 *
 * Prefer storageState for repeatable verification; reach for a profile when the
 * app's auth cannot be captured any other way, or to skip a slow cold boot.
 */
export interface OpenBrowserOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  storageStatePath?: string | null;
  /** Pre-rewritten session, used when a repro is retargeted to another origin. */
  storageState?: Record<string, unknown> | null;
  profileDir?: string | null;
  /**
   * Reuse an already-running browser instead of launching one.
   *
   * Every run otherwise pays a browser launch *and* a cold page load, because a
   * newly launched Chromium has an empty V8 code cache. Keeping the process
   * alive across runs leaves that cache warm, which on a large single-page app
   * is worth far more than the launch itself. Each run still gets its own
   * context, so isolation between replays is unchanged.
   */
  browser?: Browser | null;
}

export interface OpenedBrowser {
  context: BrowserContext;
  page: Page;
  /** True when running against a persistent profile. */
  persistent: boolean;
  close(): Promise<void>;
}

export async function openBrowser(options: OpenBrowserOptions): Promise<OpenedBrowser> {
  const { headless, viewport } = options;

  if (options.profileDir) {
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless,
      viewport,
    });
    // A persistent context always opens with one page; reuse it so we do not
    // leave a stray about:blank tab behind.
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      persistent: true,
      close: async () => {
        await context.close().catch(() => {});
      },
    };
  }

  const borrowed = Boolean(options.browser);
  const browser: Browser = options.browser ?? (await chromium.launch({ headless }));
  // Playwright accepts either a path or the state itself; a retargeted repro
  // supplies the latter because its origins were rewritten in memory.
  const storageState = options.storageState ?? options.storageStatePath ?? undefined;
  const context = await browser.newContext({
    viewport,
    ...(storageState ? { storageState: storageState as ContextStorageState } : {}),
  });
  const page = await context.newPage();
  return {
    context,
    page,
    persistent: false,
    close: async () => {
      await context.close().catch(() => {});
      // A borrowed browser belongs to the caller and outlives this run.
      if (!borrowed) await browser.close().catch(() => {});
    },
  };
}

/**
 * Keeps one browser per headless mode alive across runs.
 *
 * Owned by long-lived callers — the MCP server, a stress loop — and closed with
 * `dispose`. A one-shot CLI invocation has nothing to amortise and does not use
 * this.
 */
export class BrowserPool {
  private readonly browsers = new Map<boolean, Promise<Browser>>();

  async acquire(headless: boolean): Promise<Browser> {
    let existing = this.browsers.get(headless);
    if (existing) {
      const browser = await existing;
      if (browser.isConnected()) return browser;
      this.browsers.delete(headless);
      existing = undefined;
    }
    const launched = chromium.launch({ headless });
    this.browsers.set(headless, launched);
    return launched;
  }

  async dispose(): Promise<void> {
    const all = Array.from(this.browsers.values());
    this.browsers.clear();
    await Promise.all(all.map(async (p) => (await p).close().catch(() => {})));
  }
}

/**
 * Snapshot the session, including IndexedDB.
 *
 * Playwright omits IndexedDB by default, which silently produces a state file
 * that looks fine and restores nothing for any app keeping its auth there.
 */
export async function captureStorageState(context: BrowserContext): Promise<string> {
  return JSON.stringify(await context.storageState({ indexedDB: true }));
}
