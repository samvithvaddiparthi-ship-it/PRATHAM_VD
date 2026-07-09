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
