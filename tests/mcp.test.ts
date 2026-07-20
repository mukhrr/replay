import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, record } from '../src/api.js';
import { startDemoServer, type DemoServer } from './helpers/demo-server.js';
import { demoBugFlow } from './helpers/flow.js';

/**
 * The MCP surface is what a coding agent actually sees, so it is exercised
 * through a real client over a real transport rather than by calling the
 * handlers directly.
 */

interface ToolResult {
  content: ({ type: string; text?: string; data?: string; mimeType?: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let server: DemoServer;
let root: string;
let client: Client;

beforeAll(async () => {
  server = await startDemoServer(5240);
  root = await mkdtemp(path.join(tmpdir(), 'replay-mcp-'));

  await record({
    name: 'checkout-crash',
    baseUrl: server.baseUrl,
    root,
    headless: true,
    drive: demoBugFlow,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([
    createServer(root).connect(serverTransport),
    client.connect(clientTransport),
  ]);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe('mcp server', () => {
  it('advertises the three tools an agent needs', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'repro_artifacts',
      'repro_list',
      'repro_run',
    ]);
    // The description is the only thing steering an agent toward using it.
    const run = tools.find((t) => t.name === 'repro_run');
    expect(run?.description).toMatch(/after every code change/i);
    expect(run?.description).toMatch(/expect_fixed/);
  });

  it('lists repros', async () => {
    const result = await call('repro_list');
    expect(result.content[0]?.text).toContain('checkout-crash');
    expect((result.structuredContent?.repros as unknown[]).length).toBe(1);
  });

  it('verifies in one call and returns the page as an image', async () => {
    await server.reset();
    const result = await call('repro_run', { name: 'checkout-crash' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/^PASS/);
    expect(result.structuredContent?.passed).toBe(true);
    expect(result.structuredContent?.totalSteps).toBe(10);

    // The eye: the model sees the resulting page, not a path to a PNG.
    const image = result.content.find((c) => c.type === 'image');
    expect(image, 'expected an inline screenshot').toBeDefined();
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('reports a failure with the step, its meaning, and a screenshot', async () => {
    await server.reset();
    // Stand in for a code change that moved the button.
    const { readFile, writeFile } = await import('node:fs/promises');
    const irPath = path.join(root, '.repros/checkout-crash.json');
    const original = await readFile(irPath, 'utf8');
    const repro = JSON.parse(original);
    const target = repro.steps.find((s: { target?: { semantic: string } }) =>
      s.target?.semantic.includes('Delete Sensor 2'),
    );
    target.target.candidates = ['[data-testid="gone"]'];
    await writeFile(irPath, JSON.stringify(repro, null, 2));

    try {
      const result = await call('repro_run', { name: 'checkout-crash' });

      expect(result.isError).toBe(true);
      const failure = result.structuredContent?.failure as Record<string, unknown>;
      expect(failure.stepId).toBe(target.id);
      // The semantic description is what lets an agent locate the code.
      expect(failure.semantic).toContain('Delete Sensor 2');
      expect(failure.observed).toContain('gone');
      expect(result.content.some((c) => c.type === 'image')).toBe(true);
    } finally {
      await writeFile(irPath, original);
    }
  });

  it('refuses to certify a fix when the repro states no criterion', async () => {
    // A green here would mean "we checked nothing and it passed".
    await server.reset();
    const result = await call('repro_run', { name: 'checkout-crash', expect_fixed: true });

    expect(result.isError).toBe(true);
    const failure = result.structuredContent?.failure as Record<string, unknown>;
    expect(failure.semantic).toBe('fix criterion');
    expect(String(failure.observed)).toMatch(/expectedWhenFixed/);
  });

  it('flips polarity under expect_fixed so green means fixed', async () => {
    await server.reset();
    const { readFile, writeFile } = await import('node:fs/promises');
    const irPath = path.join(root, '.repros/checkout-crash.json');
    const original = await readFile(irPath, 'utf8');
    const repro = JSON.parse(original);
    repro.assertion.expectedWhenFixed = { domAppeared: ['[data-testid="report-result"]'] };
    await writeFile(irPath, JSON.stringify(repro, null, 2));

    try {
      const result = await call('repro_run', { name: 'checkout-crash', expect_fixed: true });
      expect(result.structuredContent?.passed).toBe(true);
      expect(result.content[0]?.text).toContain('expect-fixed');
      expect(result.content[0]?.text).toMatch(/fix holds/i);
    } finally {
      await writeFile(irPath, original);
    }
  });

  it('explains a repro without re-running it', async () => {
    const result = await call('repro_artifacts', { name: 'checkout-crash' });
    const text = result.content.map((c) => c.text ?? '').join('\n');

    expect(text).toContain('checkout-crash');
    expect(text).toContain('Delete Sensor 2');
    expect(text).toContain('expect-bug');
  });
});
