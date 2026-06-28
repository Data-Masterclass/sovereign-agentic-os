import type { Metadata } from 'next';
import './globals.css';
import { rubik, oswald, marcellus } from './fonts';
import Sidebar from '@/components/Sidebar';

export const metadata: Metadata = {
  title: 'Sovereign Agentic OS by datamasterclass.com',
  description: 'The front door for the Sovereign Agentic OS — talk to your data.',
  // app/icon.svg is auto-emitted as /icon.svg and served from the standalone
  // build output (public/ is not copied into the container image).
  icons: {
    icon: '/icon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${rubik.variable} ${oswald.variable} ${marcellus.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/* Apply the saved theme before paint. Default is light (no attribute);
            dark mode is opt-in and persisted in localStorage from Settings. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{if(localStorage.getItem('soa-theme')==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();",
          }}
        />
        <div className="shell">
          <Sidebar />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
