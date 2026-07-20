import { useEffect, useState } from 'react';
import { useRoute } from './router.js';

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

const TOAST_MS = 4_000;

export function App() {
  const [pathname, navigate] = useRoute();

  return (
    <div className="app">
      <header className="topbar">
        <h1>Sensor console</h1>
        <nav>
          <button
            type="button"
            data-testid="nav-sensors"
            className={pathname === '/' ? 'navlink active' : 'navlink'}
            onClick={() => navigate('/')}
          >
            Sensors
          </button>
          <button
            type="button"
            data-testid="nav-reports"
            className={pathname === '/reports' ? 'navlink active' : 'navlink'}
            onClick={() => navigate('/reports')}
          >
            Reports
          </button>
        </nav>
      </header>
      <main>{pathname === '/reports' ? <ReportsPage /> : <SensorsPage />}</main>
    </div>
  );
}

function SensorsPage() {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch('/api/sensors')
      .then((r) => r.json())
      .then(setSensors);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  async function addSensor() {
    const name = draft.trim();
    if (!name) return;
    setBusy(true);
    const res = await fetch('/api/sensors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const created = (await res.json()) as Sensor;
    setSensors((prev) => [...prev, created]);
    setDraft('');
    setBusy(false);
  }

  async function deleteSensor(sensor: Sensor) {
    await fetch(`/api/sensors/${sensor.id}`, { method: 'DELETE' });
    setSensors((prev) => prev.filter((s) => s.id !== sensor.id));
    setToast(`${sensor.name} deleted`);
  }

  return (
    <section className="panel">
      <h2>Sensors</h2>

      <div className="row addrow">
        <label htmlFor="sensor-name">New sensor name</label>
        <input
          id="sensor-name"
          data-testid="sensor-name-input"
          value={draft}
          placeholder="e.g. Boiler inlet"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addSensor();
          }}
        />
        <button type="button" data-testid="add-sensor" disabled={busy} onClick={() => void addSensor()}>
          Add sensor
        </button>
      </div>

      <ul className="list" data-testid="sensor-list">
        {sensors.map((sensor) => (
          <li key={sensor.id} className="sensor-row" data-testid={`sensor-row-${sensor.id}`}>
            <span className="sensor-name">{sensor.name}</span>
            {/* No test id here on purpose: exercises the role+name selector path. */}
            <button type="button" aria-label={`Delete ${sensor.name}`} onClick={() => void deleteSensor(sensor)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      {toast && (
        <div className="toast" data-testid="confirm-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}

function ReportsPage() {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [title, setTitle] = useState('');
  const [sensorId, setSensorId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void fetch('/api/sensors')
      .then((r) => r.json())
      .then((list: Sensor[]) => {
        setSensors(list);
        if (list[0]) setSensorId(String(list[0].id));
      });
  }, []);

  async function generate() {
    setPending(true);
    setReport(null);
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), sensorId }),
    });
    setReport((await res.json()) as Report);
    setPending(false);
  }

  return (
    <section className="panel">
      <h2>Reports</h2>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <label htmlFor="report-title">Report title</label>
        <input
          id="report-title"
          data-testid="report-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label htmlFor="report-sensor">Sensor</label>
        <select
          id="report-sensor"
          data-testid="report-sensor-select"
          value={sensorId}
          onChange={(e) => setSensorId(e.target.value)}
        >
          {sensors.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name}
            </option>
          ))}
        </select>

        <button type="submit" data-testid="generate-report" disabled={pending || !title.trim()}>
          {pending ? 'Generating…' : 'Generate report'}
        </button>
      </form>

      {pending && (
        <p className="pending" data-testid="report-pending">
          Crunching numbers…
        </p>
      )}

      {report && (
        <div className="result" data-testid="report-result">
          <strong>{report.title}</strong>
          <span> — report #{report.id} ready</span>
        </div>
      )}
    </section>
  );
}
