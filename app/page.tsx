import { STAGES } from '@/lib/constants';

/**
 * Zwischenstand-Seite.
 *
 * Meilenstein 1 (Datenbank und Datenzugriffsschicht) steht, die Oberflaeche
 * aus Meilenstein 3 nicht. Diese Seite sagt genau das - sie ist bewusst kein
 * halbes Interface und behauptet nichts, was es noch nicht gibt. Sie wird
 * durch die Listenansicht ersetzt, sobald Meilenstein 3 gebaut ist.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Mutuals</h1>
        <p className="text-muted">Persoenliches CRM, lokal. Projektstand: Meilenstein 1 von 4.</p>
      </header>

      <section className="flex flex-col gap-2 border-t border-b border-border py-5">
        <h2 className="font-medium text-fg">Fertig</h2>
        <ul className="flex flex-col gap-1.5 text-muted">
          <li>
            <code className="font-mono text-fg">npm run db:migrate</code> legt das Schema an:
            Kontakte, Needs, Offers, Notizen, Tags, Verbindungen und den Volltextindex.
          </li>
          <li>
            <code className="font-mono text-fg">npm run seed</code> fuellt rund zwanzig
            Beispielkontakte ein.
          </li>
          <li>
            <code className="font-mono text-fg">npm test</code> prueft Normalisierung, Suche und
            Matching.
          </li>
          <li>
            Alle Abfragen liegen als benannte Funktionen in{' '}
            <code className="font-mono text-fg">lib/queries.ts</code>.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-fg">Noch offen</h2>
        <ul className="flex flex-col gap-1.5 text-muted">
          <li>Meilenstein 2 — Import des LinkedIn-Exports (CSV und XLSX).</li>
          <li>
            Meilenstein 3 — diese Oberflaeche: Liste, Detailansicht und Board ueber die Stages{' '}
            {STAGES.join(' → ')}.
          </li>
          <li>Meilenstein 4 — MCP-Server fuer den Zugriff aus Claude.</li>
        </ul>
      </section>
    </main>
  );
}
