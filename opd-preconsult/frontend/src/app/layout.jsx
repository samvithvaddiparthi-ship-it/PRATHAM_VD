import './globals.css';
import Disclaimer from '../components/Disclaimer';
import A11yProvider from '../components/A11yProvider';

export const metadata = {
  title: 'OPD Pre-Consultation',
  description: 'AI-powered pre-consultation for hospital OPDs',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <A11yProvider>{children}</A11yProvider>
        <Disclaimer />
      </body>
    </html>
  );
}
