import type { Page } from 'playwright';

/**
 * The scripted stand-in for a developer clicking through a bug: add two
 * sensors, delete two, change route, and generate a report through the slow
 * endpoint. Ten actions covering every capture path the recorder has —
 * fill, click, select, route change, and a 1.5s async round trip.
 *
 * Each step waits for the UI to settle before the next, exactly as a human
 * would. Firing actions back to back would give the recorder an empty reaction
 * window and produce weaker waits than a real recording.
 */
export async function demoBugFlow(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="sensor-row-1"]');

  await page.fill('[data-testid="sensor-name-input"]', 'Boiler inlet');
  await page.click('[data-testid="add-sensor"]');
  await page.waitForSelector('[data-testid="sensor-row-4"]');

  await page.fill('[data-testid="sensor-name-input"]', 'Boiler outlet');
  await page.click('[data-testid="add-sensor"]');
  await page.waitForSelector('[data-testid="sensor-row-5"]');

  // No test id on these buttons — they resolve through the role+name candidate.
  await page.click('button[aria-label="Delete Sensor 2"]');
  await page.waitForSelector('[data-testid="confirm-toast"]');

  await page.click('button[aria-label="Delete Sensor 3"]');
  await page.waitForSelector('[data-testid="sensor-row-3"]', { state: 'detached' });

  await page.click('[data-testid="nav-reports"]');
  await page.waitForSelector('[data-testid="report-title-input"]');

  await page.fill('[data-testid="report-title-input"]', 'Weekly rollup');
  // Sensors 2 and 3 were deleted above; pick one that still exists.
  await page.selectOption('[data-testid="report-sensor-select"]', { label: 'Boiler inlet' });
  await page.click('[data-testid="generate-report"]');
  await page.waitForSelector('[data-testid="report-result"]', { timeout: 15_000 });
}

/** How many IR steps `demoBugFlow` is expected to compile down to. */
export const DEMO_FLOW_MIN_STEPS = 10;
