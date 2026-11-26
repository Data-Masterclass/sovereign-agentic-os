import type { Metadata } from 'next';
import './globals.css';
import { rubik, oswald, marcellus, fraunces } from './fonts';
import Sidebar from '@core/ui/Sidebar';
import { ToolWindowProvider } from '@core/ui/ToolWindowProvider';
import { ToastProvider } from '@core/ui/core/Toast';
import { PageContextProvider } from '@core/ui/core/PageContext';
import AuthGate from '@core/ui/AuthGate';
import OsAssistant from '@core/ui/OsAssistant';
import { NextIntlClientProvider } from 'next-intl';
import { requestLocaleState } from '@core/i18n/request-state';
import LocaleCookieSync from '@core/ui/LocaleCookieSync';

export const metadata: Metadata = {
  title: 'Sovereign Agentic OS by datamasterclass.com',
  description: 'The front door for the Sovereign Agentic OS — talk to your data.',
  // app/icon.svg is auto-emitted as /icon.svg and served from the standalone
  // build output (public/ is not copied into the container image).
  icons: {
    icon: '/icon.svg',
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The user's saved language (core/i18n/request.ts) — English unless they chose another under My Settings.
  const { locale, cookieStale } = await requestLocaleState();
  return (
    <html
      lang={locale}
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
        {/* Messages and locale are inherited from the request config (next-intl v4), so every client
            component can translate without a prop. */}
        <NextIntlClientProvider>
        <ToolWindowProvider>
          {/* ToastProvider wraps the whole shell so any button on any tab can
              fire the ONE OS-wide "that did something" confirmation. */}
          <ToastProvider>
            {/* PageContextProvider wraps BOTH the tab surfaces (which publish the
                open artifact + stage) AND the assistant (which reads it), so
                "Ask the OS" knows exactly where the user is. */}
            <PageContextProvider>
              <div className="shell">
                <Sidebar />
                <div className="main">{children}</div>
              </div>
              {/* The ONE overarching, tab-aware OS assistant — on every tab, acts
                  through the OS's own governed MCP. */}
              <OsAssistant />
            </PageContextProvider>
          </ToastProvider>
        </ToolWindowProvider>
        <AuthGate />
        {/* The cookie lags the saved preference (changed on another device): re-set it. */}
        {cookieStale ? <LocaleCookieSync /> : null}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
