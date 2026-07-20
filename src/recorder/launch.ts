import { chromium, type BrowserContext, type Page } from 'playwright';
import { attachRecorder, pathOf, verifyInstrumentation, type StopReason } from './attach.js';
import type { RecordingTrace } from './types.js';

export interface LaunchRecordingOptions {
  baseUrl: string;
  startPath?: string;
  viewport?: { width: number; height: number };
  /** Seed cookies/localStorage from an existing Playwright storageState file. */
  storageStatePath?: string | null;
  /** Called once the browser is up and instrumented, so the CLI can print help. */
  onReady?: () => void;
  /** Recording is a human activity by default; only a driver makes it headless-able. */
  headless?: boolean;
  /**
   * Drive the session programmatically instead of waiting for a human. The
   * recording stops when this resolves.
   *
   * This is how Phase 1's `repro auto` will work: an LLM browser agent takes
   * the page and produces the exact same IR a human recording produces, because
   * capture happens below whoever is doing the driving. Phase 0 uses it for the
   * integration test.
   */
  drive?: (page: Page) => Promise<void>;
}

export interface RecordingResult {
  trace: RecordingTrace;
  /** Serialized storageState captured at the START of the recording. */
  storageState: string;
  stopReason: StopReason;
}

export const STOP_HOTKEY = 'Ctrl/Cmd + Shift + X';

export async function launchRecording(
  options: LaunchRecordingOptions,
): Promise<RecordingResult> {
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const startPath = options.startPath ?? '/';

  const browser = await chromium.launch({ headless: options.headless ?? false });
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      viewport,
      ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
    });

    const session = await attachRecorder(context, { baseUrl: options.baseUrl });
    const page = await context.newPage();

    const startUrl = new URL(startPath, options.baseUrl).toString();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await verifyInstrumentation(page);

    // Snapshot session state before the dev touches anything, so replay starts
    // from exactly the auth/session the recording started from.
    const storageState = JSON.stringify(await context.storageState());

    session.trace.startPath = pathOf(page.url(), options.baseUrl);
    session.trace.viewport = viewport;
    // The first navigation is the starting point, not a step.
    session.trace.navigations.length = 0;

    options.onReady?.();

    const onSigint = (): void => session.stop('signal');
    process.once('SIGINT', onSigint);

    let stopReason: StopReason;
    try {
      if (options.drive) {
        // A driven session ends when the driver is done — but an early browser
        // close or hotkey still wins, so takeover behaves the same either way.
        await Promise.race([
          options.drive(page).then(() => session.stop('programmatic')),
          session.stopped,
        ]);
      }
      stopReason = await session.stopped;
    } finally {
      process.off('SIGINT', onSigint);
    }

    // Give in-flight bindings and any trailing network a moment to land, so the
    // final step's reaction is not truncated by the shutdown itself.
    await new Promise((r) => setTimeout(r, 300));
    session.detach();

    return { trace: session.trace, storageState, stopReason };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
