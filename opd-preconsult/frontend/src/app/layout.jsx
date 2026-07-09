import { Noto_Sans, Noto_Sans_Devanagari, Noto_Sans_Telugu } from 'next/font/google';
import './globals.css';
import A11yProvider from '../components/A11yProvider';

// Fonts are fetched by Next at BUILD time and emitted as self-hosted woff2 under
// /_next/static. Nothing is requested from fonts.googleapis.com at runtime, which
// matters twice over: a hospital LAN is often firewalled or offline (the old
// @import in globals.css would silently fall back to a system font), and the old
// import also sent every patient's IP to a third party on page load.
//
// Three families, because 'Noto Sans' alone ships Latin/Greek/Cyrillic only — it
// has no Devanagari or Telugu glyphs, so the app's own hi/te strings were falling
// back to whatever the device happened to have (tofu on a bare kiosk). The
// browser walks the font-family list per character, so listing all three gives
// each script a font that actually contains it. See globals.css `body`.
//
// NOTE: `next build` now needs network access to fetch these once. If you move to
// a fully air-gapped build, swap to next/font/local with the woff2 files vendored
// into the repo — the CSS variables below stay identical.
const notoSans = Noto_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-sans',
  display: 'swap',
});
const notoSansDevanagari = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-devanagari',
  display: 'swap',
});
const notoSansTelugu = Noto_Sans_Telugu({
  subsets: ['telugu'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-telugu',
  display: 'swap',
});

export const metadata = {
  title: 'OPD Pre-Consultation',
  description: 'AI-powered pre-consultation for hospital OPDs',
  // Next emits <link rel="manifest"> from app/manifest.js on its own. iOS does
  // not read the manifest's icon list, so apple-touch-icon has to be declared
  // here or a home-screen install gets a screenshot of the page instead.
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Pratham OPD',
    // 'default' keeps the iOS status bar legible over the navy header. 'black-
    // translucent' would let content slide under the notch.
    statusBarStyle: 'default',
  },
};

// Next 14 wants themeColor/viewport here, not in `metadata` — it warns otherwise.
// viewportFit + maximum-scale are left at their defaults on purpose: pinch-zoom
// must stay available (WCAG 1.4.4), and this app is used by elderly patients.
export const viewport = {
  themeColor: '#1B4F72',
};

export default function RootLayout({ children }) {
  const fontVars = `${notoSans.variable} ${notoSansDevanagari.variable} ${notoSansTelugu.variable}`;
  return (
    // lang="en" is the server-rendered default; A11yProvider rewrites it to the
    // patient's chosen language on the client so screen readers switch voice for
    // Hindi/Telugu instead of reading Devanagari with an English pronunciation.
    <html lang="en" className={fontVars}>
      <body>
        <A11yProvider>{children}</A11yProvider>
      </body>
    </html>
  );
}
