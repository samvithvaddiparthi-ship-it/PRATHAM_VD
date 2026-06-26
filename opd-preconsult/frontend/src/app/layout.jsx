import './globals.css';
import Disclaimer from '../components/Disclaimer';

export const metadata = {
  title: 'OPD Pre-Consultation',
  description: 'AI-powered pre-consultation for hospital OPDs',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Disclaimer />
      </body>
    </html>
  );
}
