/**
 * What counts as environment noise rather than evidence about the app.
 *
 * This lives in one module on purpose. Filtering only at record time produced a
 * worse bug than not filtering at all: the compiler saw an empty error list,
 * inferred "this app is clean", and switched the invariants to their strictest
 * setting — while the replayer checked raw, unfiltered output. The same CORS
 * error that was correctly ignored while recording became a hard failure on
 * every replay. Both sides must agree on what noise is.
 */

/**
 * Console output a production SPA emits regardless of what the user did:
 * blocked third-party beacons, CORS preflights, DNS failures, CSP reports,
 * extension chatter, framework advertising.
 */
const AMBIENT_CONSOLE_PATTERNS = [
  /blocked by CORS policy/i,
  /Access-Control-Allow-Origin/i,
  /net::ERR_/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_CONNECTION_REFUSED/i,
  /Failed to load resource/i,
  /chrome-extension:/i,
  /Content Security Policy/i,
  /favicon/i,
  /ResizeObserver loop/i,
  /Download the React DevTools/i,
];

export function isAmbientConsoleError(text: string): boolean {
  return AMBIENT_CONSOLE_PATTERNS.some((re) => re.test(text));
}

/** Telemetry and error-reporting hosts. Never evidence about the app's behaviour. */
const TELEMETRY_HOSTS =
  /(^|\.)(sentry\.io|segment\.(io|com)|google-analytics\.com|googletagmanager\.com|datadoghq\.com|amplitude\.com|mixpanel\.com|intercom\.io|hotjar\.com|fullstory\.com|launchdarkly\.com|bugsnag\.com|newrelic\.com|pusher\.com)$/i;

/** Build output and media. Cached on the second run, so never a reliable signal. */
const STATIC_ASSET = /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)$/i;

/**
 * Requests that must never become a recorded wait.
 *
 * A content-hashed bundle breaks on the next deploy *and* on the very next
 * replay, because the browser already has it cached and never re-requests it.
 * Telemetry is unrelated to the app's behaviour by definition.
 */
export function isIncidentalRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (TELEMETRY_HOSTS.test(parsed.hostname)) return true;
    if (STATIC_ASSET.test(parsed.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Elements whose whole job is to be temporary.
 *
 * A spinner recorded as a required `domAppeared` fails on every warm replay:
 * the data is cached, the spinner never renders, and a healthy app is reported
 * broken. It survives an "is it still there next action?" check on a cold run,
 * so it has to be excluded by what it is rather than how long it lasted.
 */
const TRANSIENT_NAME = /\b(loading|spinner|progress|skeleton|please wait|submitting|saving)\b/i;

export function isTransientIndicator(role: string | null, name: string): boolean {
  if (role === 'progressbar') return true;
  return TRANSIENT_NAME.test(name);
}
