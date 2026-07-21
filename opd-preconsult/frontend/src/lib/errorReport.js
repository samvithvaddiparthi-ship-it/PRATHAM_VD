/**
 * Browser error reporting — posts to our own backend, never to a third party.
 *
 * The backend forwards to Sentry only when SENTRY_DSN is set, so with tracking
 * disabled this costs one cheap request that returns immediately. Nothing here
 * changes what the user sees: reporting is strictly fire-and-forget and every
 * failure path is swallowed.
 *
 * PHI: we send the error's message, stack and the pathname — never the query
 * string, form state, or anything read out of the page. The backend re-scrubs and
 * truncates regardless, on the principle that the browser is not trusted to have
 * done it (see routes/clientError.js).
 */
const ENDPOINT = '/api/client-error';

// A broken page can loop — a render error that re-renders and throws again. Cap
// the reports per page load so a loop cannot flood the backend or the quota.
const MAX_REPORTS = 5;
let sent = 0;
const seen = new Set();
let installed = false;

export function reportError(error, kind = 'error') {
  try {
    if (typeof window === 'undefined') return;
    if (sent >= MAX_REPORTS) return;

    const message = String(error?.message || error || '').slice(0, 500);
    if (!message) return;

    // Deduplicate: the same error firing repeatedly is one fault, not many.
    const key = `${kind}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent += 1;

    const payload = JSON.stringify({
      message,
      name: String(error?.name || '').slice(0, 100),
      stack: String(error?.stack || '').slice(0, 4000),
      path: window.location?.pathname || '',
      kind,
    });

    // sendBeacon survives the page being torn down by the error; fetch is the
    // fallback where it is unavailable or refuses the payload.
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([payload], { type: 'application/json' }))) return;

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* reporting must never surface to the user */
  }
}

/** Catch what React's error boundaries cannot: async throws and event handlers. */
export function installGlobalErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    reportError(event?.error || { message: event?.message }, 'window.onerror');
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    reportError(
      reason instanceof Error ? reason : { message: String(reason) },
      'unhandledrejection',
    );
  });
}
