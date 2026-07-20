import type { Connect, Plugin } from 'vite';

/**
 * A fake backend served from Vite's own middleware, so `npm run dev` is one
 * process. State is per-server-instance and resets on restart, which keeps
 * repeated replays deterministic.
 */

interface Sensor {
  id: number;
  name: string;
}

interface Report {
  id: number;
  title: string;
  sensorId: number;
  generatedAt: string;
}

const SLOW_REPORT_MS = 1_500;

function createState() {
  return {
    sensors: [
      { id: 1, name: 'Sensor 1' },
      { id: 2, name: 'Sensor 2' },
      { id: 3, name: 'Sensor 3' },
    ] as Sensor[],
    reports: [] as Report[],
    nextSensorId: 4,
    nextReportId: 1,
  };
}

function readBody(req: Connect.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mockApi(): Plugin {
  let state = createState();

  return {
    name: 'replay-demo-mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) return next();

        const send = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };

        const method = (req.method ?? 'GET').toUpperCase();
        const [pathname] = url.split('?') as [string];

        // Test-only hook so an integration test can start from a known state.
        if (pathname === '/api/reset' && method === 'POST') {
          state = createState();
          return send(200, { ok: true });
        }

        if (pathname === '/api/sensors' && method === 'GET') {
          return send(200, state.sensors);
        }

        if (pathname === '/api/sensors' && method === 'POST') {
          const body = (await readBody(req)) as { name?: string };
          const name = (body.name ?? '').trim();
          if (!name) return send(400, { error: 'name is required' });
          const sensor: Sensor = { id: state.nextSensorId++, name };
          state.sensors.push(sensor);
          return send(201, sensor);
        }

        const deleteMatch = /^\/api\/sensors\/(\d+)$/.exec(pathname);
        if (deleteMatch && method === 'DELETE') {
          const id = Number(deleteMatch[1]);
          const before = state.sensors.length;
          state.sensors = state.sensors.filter((s) => s.id !== id);
          if (state.sensors.length === before) return send(404, { error: 'not found' });
          return send(200, { ok: true, id });
        }

        if (pathname === '/api/reports' && method === 'POST') {
          // Drain the request stream before sleeping — deferring the read risks
          // attaching listeners to an already-ended stream.
          const body = (await readBody(req)) as { title?: string; sensorId?: string };
          // The deliberately slow endpoint: proves replay waits on the real
          // signal rather than on a sleep the recorder guessed at.
          await sleep(SLOW_REPORT_MS);
          const title = (body.title ?? '').trim();
          if (!title) return send(400, { error: 'title is required' });
          const report: Report = {
            id: state.nextReportId++,
            title,
            sensorId: Number(body.sensorId ?? 0),
            generatedAt: new Date().toISOString(),
          };
          state.reports.push(report);
          return send(201, report);
        }

        return send(404, { error: `no route for ${method} ${pathname}` });
      });
    },
  };
}
