import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { list, readRepro, reproPaths, run } from '../api.js';
import { BrowserPool } from '../browser.js';
import { VERSION } from '../version.js';
import type { RunResult } from '../replayer/run.js';

/**
 * Replay as an MCP server: a deterministic eye that a coding agent looks
 * through.
 *
 * Nothing here calls a model. The agent already has one — this exists to hand
 * it what the browser actually did, in one call, in a form it can read *and
 * see*. That is the whole difference from driving a browser through an agent
 * step by step: re-verifying a fix costs one round trip instead of one per
 * action, every time.
 */

/** Screenshots are returned inline, so the model sees the page rather than a path. */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

async function imageContent(file: string | null): Promise<Content[]> {
  if (!file) return [];
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
      return [
        {
          type: 'text',
          text: `Screenshot too large to inline (${Math.round(bytes.byteLength / 1024)} kB): ${file}`,
        },
      ];
    }
    return [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }];
  } catch {
    return [];
  }
}

async function tail(file: string | null, lines: number): Promise<string> {
  if (!file) return '';
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

/** The one-screen summary an agent reads before deciding what to do next. */
function summarize(result: RunResult, expectFixed: boolean): string {
  const mode = expectFixed ? 'expect-fixed' : 'expect-bug';
  const head = result.passed
    ? `PASS (${mode}) — ${result.name}, ${result.timings.length}/${result.totalSteps} steps in ${(result.durationMs / 1000).toFixed(2)}s`
    : `FAIL (${mode}) — ${result.name} after ${(result.durationMs / 1000).toFixed(2)}s`;

  if (result.passed) {
    return expectFixed
      ? `${head}\nThe flow completed and the recorded bug did not occur. The fix holds.`
      : `${head}\nThe recorded outcome still occurs, so the repro itself is sound.`;
  }

  const f = result.failure;
  if (!f) return head;
  if (f.kind === 'infrastructure') {
    return [
      `COULD NOT VERIFY — ${result.name}`,
      '',
      'The replay could not drive the app, so this says nothing about whether the bug is fixed.',
      `Failing step: ${f.stepId} (step ${f.stepIndex + 1} of ${result.totalSteps})`,
      `What it does:  ${f.semantic}`,
      `Observed:      ${f.observed}`,
    ].join('\n');
  }
  return [
    head,
    ``,
    `Failing step: ${f.stepId} (step ${f.stepIndex + 1} of ${result.totalSteps})`,
    `What it does:  ${f.semantic}`,
    `Expected:      ${f.expected}`,
    `Observed:      ${f.observed}`,
  ].join('\n');
}

export interface ReplayServer {
  server: McpServer;
  /** Closes the browsers held open across calls. */
  dispose(): Promise<void>;
}

export function createServer(root = process.cwd()): McpServer {
  return createReplayServer(root).server;
}

export function createReplayServer(root = process.cwd()): ReplayServer {
  const server = new McpServer({ name: 'replay', version: VERSION });

  /**
   * One browser, held open for the life of the server.
   *
   * A CLI invocation is one-shot and has nothing to amortise, but this process
   * is long-lived: without a pool every verification launched a fresh Chromium
   * with an empty V8 code cache, so a large app paid its full cold boot on
   * every single call. Each run still gets its own context, so replays stay
   * isolated from one another.
   */
  const pool = new BrowserPool();

  server.registerTool(
    'repro_run',
    {
      title: 'Run a bug repro',
      description:
        'Replay a recorded bug reproduction against the running dev server and report what happened. ' +
        'Deterministic and fast (a 10-step flow takes about 3 seconds) — call it after every code change to verify a fix. ' +
        'Returns the pass/fail verdict, the failing step with a plain-language description of what it does, the console tail, ' +
        'the network activity, and a screenshot of the resulting page. ' +
        'Use expect_fixed=true while fixing a bug: it passes when the flow completes and the bug no longer occurs.',
      inputSchema: {
        name: z.string().describe('Name of the repro, as shown by repro_list.'),
        expect_fixed: z
          .boolean()
          .optional()
          .describe(
            'True while verifying a fix: pass when the bug does NOT occur. False (default) asserts the bug still reproduces.',
          ),
        base_url: z.string().optional().describe('Override where to navigate, nothing else.'),
        env_url: z
          .string()
          .optional()
          .describe(
            "Replay against another deployment of the same app: moves goto steps, the app's own network patterns and the captured session onto this origin. Use this to verify a fix locally on a repro recorded against staging or production.",
          ),
        headed: z
          .boolean()
          .optional()
          .describe(
            'Run in a visible browser. Required by apps that refuse headless sessions — without it those replays fail for reasons unrelated to the bug.',
          ),
        profile_dir: z
          .string()
          .optional()
          .describe('Persistent Chromium profile directory, to reuse a login.'),
        setup_command: z
          .string()
          .optional()
          .describe('Shell command run before replay, to reset state the flow mutates.'),
        timeout_scale: z
          .number()
          .optional()
          .describe('Multiply every recorded wait. Raise it when replaying somewhere slower than the machine that recorded.'),
      },
    },
    async ({ name, expect_fixed = false, base_url, env_url, headed, profile_dir, setup_command, timeout_scale }) => {
      const result = await run({
        name,
        root,
        expectFixed: expect_fixed,
        captureFinalScreenshot: true,
        // A persistent profile owns its own process and cannot share the pool.
        ...(profile_dir ? {} : { browser: await pool.acquire(!headed) }),
        ...(headed ? { headed: true } : {}),
        ...(profile_dir ? { profileDir: profile_dir } : {}),
        ...(setup_command ? { setupCommand: setup_command } : {}),
        ...(timeout_scale ? { timeoutScale: timeout_scale } : {}),
        ...(base_url ? { baseUrl: base_url } : {}),
        ...(env_url ? { envUrl: env_url } : {}),
      });

      const artifacts = result.failure?.artifacts ?? null;
      const consoleTail = await tail(artifacts?.consoleLog ?? null, 50);
      const networkLog = await tail(artifacts?.networkLog ?? null, 40);

      const content: Content[] = [{ type: 'text', text: summarize(result, expect_fixed) }];
      // Notes carry the "this may be single-shot" warning, which is the only
      // signal that a green verdict might mean nothing.
      for (const note of result.notes) content.push({ type: 'text', text: note });
      if (consoleTail) content.push({ type: 'text', text: `Console errors:\n${consoleTail}` });
      if (networkLog) content.push({ type: 'text', text: `Network since last step:\n${networkLog}` });
      content.push(...(await imageContent(result.finalScreenshot)));

      return {
        content,
        isError: !result.passed,
        structuredContent: {
          name: result.name,
          passed: result.passed,
          durationMs: result.durationMs,
          totalSteps: result.totalSteps,
          stepsRun: result.timings.length,
          failure: result.failure
            ? {
                stepId: result.failure.stepId,
                stepIndex: result.failure.stepIndex,
                semantic: result.failure.semantic,
                expected: result.failure.expected,
                observed: result.failure.observed,
              }
            : null,
          failureKind: result.failure?.kind ?? null,
          invariantViolations: result.invariantViolations,
          baseUrl: result.baseUrl,
          screenshot: result.finalScreenshot,
        },
      };
    },
  );

  server.registerTool(
    'repro_list',
    {
      title: 'List bug repros',
      description:
        'List the recorded bug reproductions available in this project, with step count, age, and how each one last did.',
      inputSchema: {},
    },
    async () => {
      const repros = await list(root);
      if (!repros.length) {
        return {
          content: [
            {
              type: 'text',
              text: 'No repros recorded. A developer creates one with: repro record <name> --url <dev server>',
            },
          ],
          structuredContent: { repros: [] },
        };
      }

      const lines = repros.map((r) => {
        const last = r.lastResult
          ? `${r.lastResult.status}${r.lastResult.failedStepId ? ` at ${r.lastResult.failedStepId}` : ''}`
          : 'never run';
        return `${r.name} — ${r.steps ?? '?'} steps, last run: ${last}${r.error ? ` (INVALID: ${r.error})` : ''}`;
      });

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { repros },
      };
    },
  );

  server.registerTool(
    'repro_artifacts',
    {
      title: 'Inspect a repro',
      description:
        'Read the steps of a repro and the artifacts from its last failure: the failing step, its description, ' +
        'the console tail, the network log, and the screenshot. Use this to understand a bug without re-running it.',
      inputSchema: {
        name: z.string().describe('Name of the repro.'),
      },
    },
    async ({ name }) => {
      const repro = await readRepro(name, root);
      const paths = reproPaths(name, root);
      const artifactsDir = paths.artifactsDir;

      const steps = repro.steps
        .map((s) => `  ${s.id}  ${s.action.padEnd(8)} ${s.target?.semantic ?? s.value ?? ''}`)
        .join('\n');

      const summaryFile = path.join(artifactsDir, 'failure.json');
      let failure: unknown = null;
      try {
        failure = JSON.parse(await readFile(summaryFile, 'utf8'));
      } catch {
        /* no recorded failure */
      }

      const content: Content[] = [
        {
          type: 'text',
          text: [
            `Repro: ${repro.name}`,
            `Base URL: ${repro.baseUrl}${repro.startPath}`,
            `Assertion mode: ${repro.assertion.mode}`,
            ``,
            `Steps:`,
            steps,
          ].join('\n'),
        },
      ];

      const observed = repro.assertion.observedAtRecord;
      if (observed?.consoleErrors.length || observed?.failedRequests.length) {
        content.push({
          type: 'text',
          text: [
            'The bug, as observed when this repro was recorded:',
            ...observed.consoleErrors.map((e) => `  console: ${e}`),
            ...observed.failedRequests.map(
              (r) => `  network: ${r.method} ${r.urlPattern} -> ${r.status ?? 'aborted'}`,
            ),
          ].join('\n'),
        });
      }

      if (failure) {
        content.push({ type: 'text', text: `Last failure:\n${JSON.stringify(failure, null, 2)}` });
        const consoleTail = await tail(path.join(artifactsDir, 'console.log'), 50);
        if (consoleTail) content.push({ type: 'text', text: `Console:\n${consoleTail}` });
        content.push(...(await imageContent(path.join(artifactsDir, 'screenshot.png'))));
      }

      return {
        content,
        structuredContent: { repro, failure, artifactsDir },
      };
    },
  );

  return { server, dispose: () => pool.dispose() };
}
