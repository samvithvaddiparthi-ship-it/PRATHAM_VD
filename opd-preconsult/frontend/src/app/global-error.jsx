'use client';
/**
 * Last-resort React error boundary (Next.js App Router).
 *
 * Catches a render error anywhere the per-route boundaries do not, reports it, and
 * shows a recoverable screen instead of Next's default crash page — which in
 * production is a bare "Application error" that tells a patient nothing and offers
 * no way forward.
 *
 * Deliberately plain: this renders when the app is already broken, so it uses no
 * providers, no i18n and no imports beyond the reporter. Anything clever here can
 * fail a second time and leave a blank page.
 *
 * The colours are inline hex rather than CSS custom properties — the ONE place that
 * is correct, because global-error replaces the root layout and renders its own
 * <html>/<body>, so globals.css may not have applied. Do not "fix" this to var(...):
 * it would render unstyled exactly when the user most needs to be able to read it.
 * The values are copied from the tokens (--primary, --bg, and the darker
 * --text-light) and must be updated with them. Contrast is well clear of AA.
 */
import { useEffect } from 'react';
import { reportError } from '../lib/errorReport';

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    reportError(error, 'react.global');
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#F5F7FA' }}>
        <main
          role="alert"
          style={{
            maxWidth: 460, margin: '0 auto', padding: '48px 24px',
            minHeight: '100vh', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 16 }} aria-hidden="true">⚠️</div>
          <h1 style={{ fontSize: 22, color: '#1B4F72', margin: '0 0 10px' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 16, color: '#333a44', margin: '0 0 8px', lineHeight: 1.5 }}>
            Your answers so far have been saved. You can try again from here.
          </p>
          <p style={{ fontSize: 15, color: '#333a44', margin: '0 0 24px', lineHeight: 1.5 }}>
            If this keeps happening, please show this screen to the registration desk.
          </p>
          <button
            onClick={() => reset()}
            style={{
              minHeight: 48, padding: '0 28px', fontSize: 16, fontWeight: 600,
              color: '#fff', background: '#1B4F72', border: 'none',
              borderRadius: 10, cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
