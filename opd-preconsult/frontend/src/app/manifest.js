// Served by Next at /manifest.webmanifest; Next injects the <link rel="manifest">
// into every page automatically. See app/layout.jsx for the iOS-side meta.
//
// This is a MANIFEST ONLY. There is deliberately no service worker, and adding
// one is not a small change — read the engineering notes first. Without a service
// worker nothing is intercepted or cached, so this file cannot affect runtime
// behaviour: it only tells the OS how to present the app if someone adds it to
// their home screen.
//
// Notes on the choices below:
//   start_url '/'  drops the QR's ?h=<hospital_id>. Harmless — parseEntry() in
//                  app/page.jsx falls back to NEXT_PUBLIC_HOSPITAL_ID. A launched
//                  icon just begins a fresh intake, which is the right behaviour.
//   no `orientation` — the waiting-room board (/queue) runs landscape on a TV and
//                  the doctor dashboard is used both ways. Locking it would break
//                  one of them.
//   theme_color    --primary; background_color --bg, so the splash matches the
//                  first paint instead of flashing white.
export default function manifest() {
  return {
    id: '/',
    name: 'Pratham — OPD Pre-Consultation',
    short_name: 'Pratham OPD',
    description:
      'Complete your hospital OPD pre-consultation before you see the doctor, and let doctors review AI-assisted summaries.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F5F7FA',
    theme_color: '#1B4F72',
    lang: 'en',
    dir: 'ltr',
    categories: ['medical', 'health'],
    prefer_related_applications: false,
    icons: [
      // `any` and `maskable` are separate art, not the same file listed twice:
      // Android crops maskable icons, which would shave the rounded corners off
      // the `any` version and make it look like a rendering bug.
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
