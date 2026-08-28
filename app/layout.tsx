import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';

import { AppNav, CommandPaletteHint } from '@/components/app-nav';
import { CommandPalette } from '@/components/command-palette';

import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'Mutuals',
  description: 'Persoenliches CRM fuer das eigene Netzwerk.',
};

/**
 * Die Huelle der Anwendung.
 *
 * Aufbau: 48px Kopfzeile mit Wortmarke, Navigation und dem Hinweis auf die
 * Kommandopalette, darunter der Inhaltsbereich ueber die volle Breite und
 * Hoehe. Kein zentrierter schmaler Container - die Liste ist eine dichte
 * Tabelle und soll die Breite des Fensters nutzen; der Weissraum kommt aus dem
 * Innenabstand der jeweiligen Ansicht, nicht aus einem Rahmen um alles.
 *
 * Die Kopfzeile klebt oben und traegt unten die einzige durchgehende Trennlinie
 * der Anwendung. Der aktive Navigationspunkt setzt seinen Balken genau darauf.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" className={inter.variable}>
      <body className="bg-bg text-fg">
        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-20 flex h-12 shrink-0 items-stretch gap-6 border-b border-border bg-surface px-4">
            <div className="flex items-center">
              <span className="text-md font-semibold tracking-tight text-fg">Mutuals</span>
            </div>
            <AppNav />
            <div className="ml-auto flex items-center">
              <CommandPaletteHint />
            </div>
          </header>

          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        </div>

        <CommandPalette />
      </body>
    </html>
  );
}
