import type { BrowserContext, Frame, Page } from 'playwright';
import {
  AGENT_READY_FLAG,
  agentSource,
  DEFAULT_AGENT_CONFIG,
  type AgentConfig,
} from './instrument.js';
import { collectReactions, type ReactionCollector } from './reaction.js';
import type {
  PageEvent,
  RawActionEvent,
  RawDomEvent,
  RawNavigationEvent,
  RecordingTrace,
} from './types.js';

export type StopReason = 'hotkey' | 'browser-closed' | 'signal' | 'programmatic';

export interface AttachOptions {
  baseUrl: string;
  agentConfig?: Partial<AgentConfig>;
}

export interface RecordingSession {
  /** Filled in live as events arrive; safe to read after `stopped` resolves. */
  trace: RecordingTrace;
  stopped: Promise<StopReason>;
  stop(reason: StopReason): void;
  detach(): void;
}

/**
 * Attaches the capture pipeline to a context this function did NOT create.
 *
 * Keeping attach separate from launch is what makes Phase 1's hybrid takeover
 * possible: an agent-driven session can be instrumented mid-flight, and human
 * actions land in the same trace as agent actions.
 */
export async function attachRecorder(
  context: BrowserContext,
  options: AttachOptions,
): Promise<RecordingSession> {
  const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, ...options.agentConfig };

  const actions: RawActionEvent[] = [];
  const dom: RawDomEvent[] = [];
  const navigations: RawNavigationEvent[] = [];
  const reactions: ReactionCollector = collectReactions(context);

  const trace: RecordingTrace = {
    actions,
    dom,
    navigations,
    network: reactions.network,
    console: reactions.console,
    startedAt: Date.now(),
    endedAt: 0,
    baseUrl: options.baseUrl,
    startPath: '/',
    viewport: { width: 1440, height: 900 },
  };

  let resolveStopped: (reason: StopReason) => void = () => {};
  let settled = false;
  let detached = false;
  const stopped = new Promise<StopReason>((resolve) => {
    resolveStopped = resolve;
  });

  const stop = (reason: StopReason): void => {
    if (settled) return;
    settled = true;
    resolveStopped(reason);
  };

  // Guarded on `detached`, not `stop`: the caller deliberately leaves a grace
  // period after stopping so the final action's reaction is not truncated.
  await context.exposeBinding(config.emitBinding, (_source, raw: unknown) => {
    if (detached) return;
    const ev = raw as PageEvent;
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'action') actions.push(ev);
    else if (ev.kind === 'dom') dom.push(ev);
  });

  await context.exposeBinding(config.stopBinding, () => {
    stop('hotkey');
  });

  const script = agentSource(config);
  await context.addInitScript({ content: script });

  const watchPage = (page: Page): void => {
    page.on('framenavigated', (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      navigations.push({ kind: 'navigation', url: frame.url(), t: Date.now() });
    });
  };

  context.on('page', watchPage);
  context.on('close', () => stop('browser-closed'));

  // Pages that already exist never ran the init script, so inject directly.
  for (const page of context.pages()) {
    watchPage(page);
    try {
      await page.evaluate(script);
    } catch {
      // about:blank and cross-origin pages can refuse evaluation; the init
      // script will cover them on their next navigation.
    }
  }

  const first = context.pages()[0];
  if (first) {
    const size = first.viewportSize();
    if (size) trace.viewport = size;
    try {
      trace.startPath = pathOf(first.url(), options.baseUrl);
    } catch {
      /* about:blank before the first navigation */
    }
  }

  return {
    trace,
    stopped,
    stop,
    detach() {
      if (detached) return;
      detached = true;
      trace.endedAt = Date.now();
      reactions.detach();
      context.off('page', watchPage);
    },
  };
}

/**
 * Assert the page agent actually installed.
 *
 * The failure this guards against is silent and total: if the injected source
 * throws on its first line — a build helper leaking into the serialized body is
 * the classic cause — every listener is missing and the recording completes
 * happily with zero steps. Better to refuse to record than to hand someone an
 * empty repro they will trust.
 */
export async function verifyInstrumentation(page: Page): Promise<void> {
  const ready = await page.evaluate(
    (flag) => Boolean((window as unknown as Record<string, unknown>)[flag]),
    AGENT_READY_FLAG,
  );
  if (ready) return;
  throw new Error(
    'Recorder instrumentation failed to install in the page. No actions would be captured.\n' +
      'This usually means the injected agent threw — check the browser console for the first error.',
  );
}

/** Path + query relative to baseUrl, defaulting to "/" for anything unparseable. */
export function pathOf(url: string, baseUrl: string): string {
  try {
    const u = new URL(url);
    const base = new URL(baseUrl);
    if (u.origin !== base.origin) return url;
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return '/';
  }
}
