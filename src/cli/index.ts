#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import {
  assertRepro,
  deleteRepro,
  fixRepro,
  list,
  PartialRecordingError,
  readRepro,
  record,
  reproPaths,
  run,
  STOP_HOTKEY,
} from '../api.js';
import { writeRepro } from '../ir/io.js';
import { IRValidationError, type Repro } from '../ir/schema.js';
import type { RunResult } from '../replayer/run.js';
import { age, bold, cyan, dim, green, ms, red, table, truncate, yellow } from './format.js';
import { VERSION } from '../version.js';

const program = new Command();

program
  .name('repro')
  .description('Record a bug once, verify the fix in seconds.')
  // Read from the manifest so a build can never misreport which one it is.
  .version(VERSION);

program
  .command('record')
  .argument('<name>', 'name for this repro')
  .requiredOption('-u, --url <baseUrl>', 'base URL of your dev server, e.g. http://localhost:3000')
  .option('-p, --path <startPath>', 'path to start recording at', '/')
  .option('--viewport <WxH>', 'browser viewport', '1440x900')
  .option('--storage-state <file>', 'seed cookies/localStorage/IndexedDB from a Playwright state file')
  .option('--profile <dir>', 'record against a persistent Chromium profile (reuses a login)')
  .description('launch an instrumented browser and record a bug reproduction')
  .action(async (name: string, opts) => {
    const viewport = parseViewport(opts.viewport);

    const { repro, irPath, stopReason } = await record({
      name,
      baseUrl: opts.url,
      startPath: opts.path,
      viewport,
      storageStatePath: opts.storageState ?? null,
      profileDir: opts.profile ?? null,
      onReady: () => {
        console.log(`${green('●')} ${bold('Recording')} ${cyan(name)} on ${opts.url}${opts.path}`);
        console.log(dim(`  Reproduce the bug, then press ${STOP_HOTKEY} — or just close the browser.`));
        console.log('');
      },
    });

    if (!repro.steps.length) {
      console.log(yellow('No actions captured — nothing was written.'));
      console.log(dim('  If you did interact, check that the app loaded before you started.'));
      process.exitCode = 1;
      return;
    }

    console.log(
      `${green('✓')} Captured ${bold(String(repro.steps.length))} steps ${dim(`(stopped: ${stopReason})`)}`,
    );
    console.log(`  ${dim('→')} ${path.relative(process.cwd(), irPath)}`);

    const { invariants, observedAtRecord } = repro.assertion;
    if (!invariants.noConsoleErrors || !invariants.noFailedRequests) {
      console.log('');
      console.log(yellow('  The bug was observed while recording:'));
      for (const e of observedAtRecord?.consoleErrors ?? []) {
        console.log(dim(`    console  ${truncate(e, 100)}`));
      }
      for (const f of observedAtRecord?.failedRequests ?? []) {
        console.log(dim(`    network  ${f.method} ${f.urlPattern} -> ${f.status ?? 'aborted'}`));
      }
      console.log(
        dim('    Those invariants are off so the repro passes its own replay; the evidence is'),
      );
      console.log(dim('    kept under assertion.observedAtRecord.'));
    }
  });

program
  .command('run')
  .argument('<name>', 'name of the repro to replay')
  .option('--headed', 'watch the replay in a visible browser', false)
  .option('--expect-fixed', 'pass when the bug no longer happens — use while fixing', false)
  .option('-u, --url <baseUrl>', 'override where to navigate, nothing else')
  .option(
    '--env <url>',
    'replay against another deployment: moves goto steps, the app\'s network patterns and the captured session onto this origin',
  )
  .option('--profile <dir>', 'replay against a persistent Chromium profile (reuses a login)')
  .option('--setup <command>', 'shell command to reset state before replaying')
  .option('--timeout-scale <n>', 'multiply every recorded wait; raise on slow machines', '1')
  .option(
    '--resolve-timeout <ms>',
    'budget for the first selector candidate; raise it for slow-booting SPAs',
    '800',
  )
  .description('replay a repro at machine speed and assert the recorded outcome')
  .action(async (name: string, opts) => {
    const first = Number(opts.resolveTimeout);
    if (!Number.isFinite(first) || first <= 0) {
      throw new Error(`Invalid --resolve-timeout "${opts.resolveTimeout}". Expected milliseconds.`);
    }
    const result = await run({
      name,
      headed: opts.headed,
      baseUrl: opts.url,
      envUrl: opts.env ?? null,
      expectFixed: opts.expectFixed,
      profileDir: opts.profile ?? null,
      setupCommand: opts.setup ?? null,
      timeoutScale: Number(opts.timeoutScale) || 1,
      // Fallbacks stay cheap probes: half the primary budget.
      resolveTimeouts: { first, subsequent: Math.max(200, Math.round(first / 2)) },
    });
    // Stated before the verdict: a run against the wrong origin looks exactly
    // like a run against the right one until you know which it was.
    const via = opts.env ? '  (retargeted with --env)' : opts.url ? '  (overridden by -u)' : '';
    console.log(dim(`  against ${result.baseUrl}${via}`));
    console.log('');
    result.passed ? reportPass(result) : reportFail(result);
    process.exitCode = result.passed ? 0 : 1;
  });

program
  .command('list')
  .description('list recorded repros with their last result and age')
  .action(async () => {
    const repros = await list();
    if (!repros.length) {
      console.log(dim('No repros yet. Record one with:  repro record <name> --url http://localhost:3000'));
      return;
    }

    const rows: string[][] = [
      [bold('NAME'), bold('STEPS'), bold('LAST RUN'), bold('AGE')],
      ...repros.map((r) => {
        if (r.error) return [cyan(r.name), dim('—'), red('invalid IR'), age(r.createdAt)];
        const last = r.lastResult;
        const status = !last
          ? dim('never run')
          : last.status === 'pass'
            ? green(`pass ${dim(`(${ms(last.durationMs)}, ${age(last.at)} ago)`)}`)
            : red(`fail ${dim(`at ${last.failedStepId ?? '?'}, ${age(last.at)} ago`)}`);
        return [cyan(r.name), String(r.steps ?? '—'), status, age(r.createdAt)];
      }),
    ];
    console.log(table(rows));
  });

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

program
  .command('rm')
  .alias('delete')
  .argument('<names...>', 'repros to delete')
  .description('delete a repro once its bug is fixed — they are meant to be disposable')
  .action(async (names: string[]) => {
    for (const name of names) {
      const existed = await deleteRepro(name);
      console.log(
        existed
          ? `  ${green('✓')} deleted ${cyan(name)} ${dim('(IR, session and artifacts)')}`
          : `  ${yellow('!')} no repro named ${cyan(name)}`,
      );
    }
  });

program
  .command('fix')
  .argument('<name>', 'name of the repro to repair')
  .description('repair a recorded repro without hand-editing its JSON')
  .option('--scale-timeouts <n>', 'multiply every recorded timeout')
  .option('--min-timeout <ms>', 'raise any timeout below this floor')
  .option('--relax-network', 'drop network waits, keeping DOM signals', false)
  .option('--relax-invariants', 'turn off noConsoleErrors and noFailedRequests', false)
  .option('--drop-wait <selector>', 'remove a selector from every wait', collect)
  .option('--drop-step <id>', 'remove a step', collect)
  .option('--add-candidate <stepId=selector>', 'add a selector candidate to a step', collect)
  .option('--renumber', 'renumber step ids to match position', false)
  .action(async (name: string, opts) => {
    const repro = await readRepro(name);
    const { repro: fixed, changes } = fixRepro(repro, {
      scaleTimeouts: opts.scaleTimeouts ? Number(opts.scaleTimeouts) : undefined,
      minTimeout: opts.minTimeout ? Number(opts.minTimeout) : undefined,
      relaxNetwork: opts.relaxNetwork,
      relaxInvariants: opts.relaxInvariants,
      dropWaits: opts.dropWait,
      dropSteps: opts.dropStep,
      addCandidates: opts.addCandidate,
      renumber: opts.renumber,
    });
    await applyEdit(name, fixed, changes);
  });

program
  .command('assert')
  .argument('<name>', 'name of the repro')
  .description('state what must be true, without hand-editing its JSON')
  .option('--appeared <selector>', 'require this to be present at the end', collect)
  .option('--gone <selector>', 'require this to be absent at the end', collect)
  .option('--focused <selector>', 'require focus to be on this element')
  .option('--fixed', 'write into expectedWhenFixed instead of finalState', false)
  .option('--clear', 'empty the assertion first', false)
  .action(async (name: string, opts) => {
    const repro = await readRepro(name);
    const { repro: next, changes } = assertRepro(repro, {
      appeared: opts.appeared,
      gone: opts.gone,
      focused: opts.focused,
      whenFixed: opts.fixed,
      clear: opts.clear,
    });
    await applyEdit(name, next, changes);
  });

async function applyEdit(name: string, repro: Repro, changes: string[]): Promise<void> {
  if (!changes.length) {
    console.log(yellow('Nothing to change.'));
    return;
  }
  await writeRepro(repro, reproPaths(name));
  for (const change of changes) console.log(`  ${green('✓')} ${change}`);
  console.log(dim(`  → ${path.relative(process.cwd(), reproPaths(name).ir)}`));
}

function reportPass(result: RunResult): void {
  const rows: string[][] = [
    [bold('STEP'), bold('ACTION'), bold('ACT'), bold('WAIT'), bold('TOTAL'), bold('WHAT')],
    ...result.timings.map((t) => [
      t.id,
      t.action,
      ms(t.actMs),
      ms(t.waitMs),
      ms(t.totalMs),
      t.candidateIndex > 0
        ? `${truncate(t.semantic, 52)} ${yellow(`(fallback selector #${t.candidateIndex})`)}`
        : dim(truncate(t.semantic, 52)),
    ]),
  ];
  console.log(table(rows));
  for (const note of result.notes) console.log(dim(`  note  ${note}`));
  console.log('');
  // The question is about the bug, so the answer should be too. Reading
  // "FAIL" as good news is a workflow people route around by keeping two
  // near-identical repros.
  const verdict = result.expectFixed
    ? `${green('✓ BUG FIXED')} ${dim('— the flow completed and the bug did not happen')}`
    : `${green('✓ BUG REPRODUCED')} ${dim('— this repro is sound')}`;
  console.log(
    `${verdict}  ${bold(result.name)} ${dim(`(${result.timings.length} steps in ${ms(result.durationMs)})`)}`,
  );
  if (result.expectFixed) {
    // The repro has done its job. Left behind, it rots against a moving app and
    // becomes a test nobody meant to write.
    console.log(dim(`  This repro is finished — delete it with:  repro rm ${result.name}`));
  }
}

function reportFail(result: RunResult): void {
  const f = result.failure;
  // An infrastructure failure says nothing about the bug. Reporting it as
  // "NOT FIXED" sends people chasing a bug they have already fixed.
  const infra = f?.kind === 'infrastructure';
  const label = infra
    ? '✗ COULD NOT VERIFY'
    : result.expectFixed
      ? '✗ BUG STILL PRESENT'
      : '✗ BUG DID NOT REPRODUCE';
  console.log(`${red(label)}  ${bold(result.name)} ${dim(`after ${ms(result.durationMs)}`)}`);
  if (!f) return;
  if (infra) {
    console.log(dim('  The replay could not drive the app, so this is not a verdict on the bug.'));
    console.log(dim('  Fix the step below, or raise --resolve-timeout / --timeout-scale.'));
  }

  console.log('');
  console.log(
    `  ${bold('Step')}      ${f.stepId} ${dim(`(step ${f.stepIndex + 1} of ${result.totalSteps})`)}`,
  );
  console.log(`  ${bold('Target')}    ${f.semantic}`);
  console.log(`  ${bold('Expected')}  ${f.expected}`);
  console.log(`  ${bold('Observed')}  ${f.observed}`);

  if (f.artifacts) {
    console.log('');
    console.log(`  ${bold('Artifacts')} ${dim(path.relative(process.cwd(), f.artifacts.dir))}`);
    for (const [label, file] of [
      ['screenshot', f.artifacts.screenshot],
      ['console', f.artifacts.consoleLog],
      ['network', f.artifacts.networkLog],
    ] as const) {
      if (file) console.log(dim(`    ${label.padEnd(11)}${path.relative(process.cwd(), file)}`));
    }
  }
}

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid --viewport "${value}". Expected WxH, e.g. 1440x900.`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof PartialRecordingError) {
      // The steps captured before the failure are on disk and worth having.
      console.error(`${yellow('!')} ${err.message}`);
      console.error(dim(`  Inspect it, trim the last step, and re-run — or re-record.`));
      process.exitCode = 1;
      return;
    }
    if (err instanceof IRValidationError) {
      // Schema errors are the user's to fix by hand — show every issue at once.
      console.error(red('✗ Invalid repro file'));
      console.error(err.message);
    } else {
      console.error(`${red('✗')} ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }
}

void main();
