import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthProvider } from '@/context/AuthContext';
import { AccountNav } from '@/components/AccountNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Brand Marketing Multi-Agent System',
  description: 'Creative content generation and generative engine optimisation for SMBs.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <AuthProvider>
          <header className="border-b border-[var(--color-line)]">
            <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4 text-sm">
              <Link href="/" className="font-semibold">
                BMAS
              </Link>
              <Link
                href="/studio"
                className="text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                Studio
              </Link>
              <Link href="/geo" className="text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                GEO
              </Link>
              <Link
                href="/trends"
                className="text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                Trends
              </Link>
              <AccountNav />
            </nav>
          </header>
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
