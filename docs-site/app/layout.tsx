import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Provider } from '@/components/provider';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

// The whole app is the docs site (served under /docs via basePath), so the
// Fumadocs docs layout lives in the root layout — no marketing home page.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>
          <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
            {children}
          </DocsLayout>
        </Provider>
      </body>
    </html>
  );
}
