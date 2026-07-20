import { z } from 'zod';

/** Bump when a change to the IR shape is not backward-readable. */
export const IR_VERSION = 1;

export const ActionSchema = z.enum([
  'click',
  'dblclick',
  'fill',
  'press',
  'select',
  'goto',
  'scroll',
  'hover',
]);
export type Action = z.infer<typeof ActionSchema>;

/**
 * Who produced this step. Phase 0 only ever writes "human", but the field exists
 * now so an agent-authored step (Phase 1 `repro auto`) is the same shape, and a
 * hybrid recording can interleave both in one stream.
 */
export const AuthorSchema = z.enum(['human', 'agent']);
export type Author = z.infer<typeof AuthorSchema>;

export const TargetSchema = z.object({
  /**
   * Selector strings in priority order, highest-confidence first. Every entry is
   * a valid Playwright selector so the replayer stays dumb: it tries them in
   * order and never rewrites them. A future self-healer patches this array.
   */
  candidates: z.array(z.string().min(1)).min(1),
  /**
   * Rule-based, human-readable description of the element, derived from role,
   * accessible name and nearest row/section label. No LLM involved. Used in
   * failure messages, and as the re-grounding prompt for Phase 1 self-heal.
   */
  semantic: z.string(),
});
export type Target = z.infer<typeof TargetSchema>;

export const NetworkWaitSchema = z.object({
  /** Recorded URL with volatile path/query IDs normalized to `*`. */
  urlPattern: z.string().min(1),
  method: z.string().min(1),
});
export type NetworkWait = z.infer<typeof NetworkWaitSchema>;

export const WaitAfterSchema = z.object({
  network: z.array(NetworkWaitSchema).optional(),
  domAppeared: z.array(z.string()).optional(),
  domGone: z.array(z.string()).optional(),
  /** Set when the action produced no observable reaction at all. */
  networkIdle: z.boolean().optional(),
  /** Ceiling for the whole wait, not a per-signal budget. */
  timeoutMs: z.number().int().positive(),
});
export type WaitAfter = z.infer<typeof WaitAfterSchema>;

export const StepSchema = z.object({
  id: z.string().min(1),
  action: ActionSchema,
  /** Payload for fill/press/select/goto/scroll. Null for click-likes. */
  value: z.string().nullable().default(null),
  /** Absent for `goto`, which addresses a URL rather than an element. */
  target: TargetSchema.optional(),
  waitAfter: WaitAfterSchema,
  author: AuthorSchema.default('human'),
});
export type Step = z.infer<typeof StepSchema>;

/**
 * What the environment looked like at authoring time. Phase 0 uses this to
 * decide whether an invariant is even checkable; Phase 1's `--expect-fixed`
 * uses it as the definition of "the bug" that must no longer occur.
 */
export const ObservedAtRecordSchema = z.object({
  consoleErrors: z.array(z.string()).default([]),
  failedRequests: z
    .array(
      z.object({
        urlPattern: z.string(),
        method: z.string(),
        status: z.number().int().nullable().default(null),
      }),
    )
    .default([]),
});
export type ObservedAtRecord = z.infer<typeof ObservedAtRecordSchema>;

export const InvariantsSchema = z.object({
  noConsoleErrors: z.boolean().default(true),
  noFailedRequests: z.boolean().default(true),
});
export type Invariants = z.infer<typeof InvariantsSchema>;

export const FinalStateSchema = z.object({
  domAppeared: z.array(z.string()).optional(),
  domGone: z.array(z.string()).optional(),
  network: z.array(NetworkWaitSchema).optional(),
});
export type FinalState = z.infer<typeof FinalStateSchema>;

export const AssertionSchema = z.object({
  /**
   * Explicit rather than implied, so both polarities are expressible:
   *   expect-bug   — the recorded final state must occur (Phase 0 `repro run`)
   *   expect-fixed — the flow completes, the bug does NOT occur, invariants hold
   * Phase 0 always records "expect-bug"; the run mode is selected at replay time.
   */
  mode: z.enum(['expect-bug', 'expect-fixed']).default('expect-bug'),
  finalState: FinalStateSchema,
  /**
   * What must be TRUE once the bug is fixed. Hand-written; nothing derives it.
   *
   * `finalState` describes the buggy end state, so it cannot double as a fix
   * criterion. Without this, a bug that leaves no console error and no failed
   * request — a missing element, a wrong number, a broken layout — gives
   * `--expect-fixed` nothing to check, and a tool that reports success after
   * checking nothing is worse than one that refuses to answer.
   */
  expectedWhenFixed: FinalStateSchema.optional(),
  invariants: InvariantsSchema,
  observedAtRecord: ObservedAtRecordSchema.optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

export const ReproSchema = z.object({
  version: z.literal(IR_VERSION),
  name: z.string().min(1),
  createdAt: z.string(),
  baseUrl: z.string().url(),
  /** Path recorded at start, appended to baseUrl when replay begins. */
  startPath: z.string().default('/'),
  viewport: ViewportSchema,
  /** Project-root-relative, e.g. ".repros/<name>/state.json". Null if nothing worth persisting. */
  storageStatePath: z.string().nullable().default(null),
  steps: z.array(StepSchema),
  assertion: AssertionSchema,
});
export type Repro = z.infer<typeof ReproSchema>;

export class IRValidationError extends Error {
  constructor(
    readonly file: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(IRValidationError.format(file, issues));
    this.name = 'IRValidationError';
  }

  private static format(file: string, issues: z.core.$ZodIssue[]): string {
    const lines = issues.map((i) => {
      const path = i.path.length ? i.path.join('.') : '(root)';
      return `  ${path}: ${i.message}`;
    });
    return `Invalid repro IR in ${file}\n${lines.join('\n')}`;
  }
}

/** Parse and validate an unknown value as a Repro, or throw IRValidationError. */
export function parseRepro(data: unknown, file: string): Repro {
  const result = ReproSchema.safeParse(data);
  if (!result.success) throw new IRValidationError(file, result.error.issues);
  return result.data;
}
