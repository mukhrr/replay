import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_APP_DIR = path.resolve(here, '../../examples/demo-app');
const VITE_BIN = path.join(DEMO_APP_DIR, 'node_modules/vite/bin/vite.js');

export interface DemoServer {
  baseUrl: string;
  /** Restore the mock API to its initial three sensors. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Runs the demo app's Vite binary directly rather than through `npm run dev`.
 * The npm wrapper would leave an orphaned grandchild holding the port when the
 * test run is interrupted.
 */
export async function startDemoServer(port = 5199): Promise<DemoServer> {
  if (!existsSync(VITE_BIN)) {
    throw new Error(
      `Demo app dependencies are missing. Run:  npm --prefix examples/demo-app install`,
    );
  }

  const child: ChildProcess = spawn(process.execPath, [VITE_BIN, '--port', String(port)], {
    cwd: DEMO_APP_DIR,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  });

  const baseUrl = `http://localhost:${port}`;
  await waitForServer(baseUrl, child);

  return {
    baseUrl,
    async reset() {
      await fetch(`${baseUrl}/api/reset`, { method: 'POST' });
    },
    async close() {
      if (child.exitCode !== null || child.killed) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3_000).unref();
      });
    },
  };
}

async function waitForServer(baseUrl: string, child: ChildProcess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Demo server exited early with code ${child.exitCode}.`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/sensors`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error(`Demo server did not start on ${baseUrl} within ${timeoutMs}ms.`);
}
