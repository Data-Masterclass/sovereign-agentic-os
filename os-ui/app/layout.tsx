import type { Metadata } from 'next';
import './globals.css';
import { rubik, oswald, marcellus, fraunces } from './fonts';
import Sidebar from '@/components/Sidebar';
import TutorialProvider from '@/components/tutorials/TutorialProvider';
import { ToolWindowProvider } from '@/components/ToolWindowProvider';
import { ToastProvider } from '@/components/core/Toast';
import AuthGate from '@/components/AuthGate';
import OsAssistant from '@/components/OsAssistant';

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
      className={`${rubik.variable} ${oswald.variable} ${marcellus.variable} ${fraunces.variable}`}
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
        <TutorialProvider>
          <ToolWindowProvider>
            {/* ToastProvider wraps the whole shell so any button on any tab can
                fire the ONE OS-wide "that did something" confirmation. */}
            <ToastProvider>
              <div className="shell">
                <Sidebar />
                <div className="main">{children}</div>
              </div>
              {/* The ONE overarching, tab-aware OS assistant — on every tab, acts
                  through the OS's own governed MCP. */}
              <OsAssistant />
            </ToastProvider>
          </ToolWindowProvider>
        </TutorialProvider>
        <AuthGate />
      </body>
    </html>
  );
}
