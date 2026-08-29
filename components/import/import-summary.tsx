'use client';

import Link from 'next/link';

import { Badge, Button, cx } from '@/components/ui';
import type { ImportRowResult, ImportSummary } from '@/lib/import/types';

/**
 * Die Bilanz nach Trockenlauf oder Import.
 *
 * Die vier Zahlen oben sind die Antwort auf "hat es geklappt?". Alles darunter
 * ist die Antwort auf "und was muss ich mir ansehen?" - und die ist der
 * eigentliche Zweck dieser Ansicht. Ein Import, der nur "37 Kontakte
 * importiert" meldet, verschweigt die drei Zeilen, die auf einen bestehenden
 * Kontakt gelaufen sind, weil jemand denselben Namen traegt.
 *
 * Reihenfolge der Abschnitte: erst was schiefging (Fehler), dann was ein
 * Mensch pruefen muss (Namenstreffer), dann was liegen blieb (uebersprungen),
 * zuletzt einzelne Werte, die eine Zeile nicht mitgenommen hat. Absteigend
 * nach Dringlichkeit, nicht nach Menge.
 */

/**
 * Wie viele Zeilen eine Liste hoechstens zeigt.
 *
 * Bei 900 Kontakten sind 300 Namenstreffer moeglich; die alle auszugeben
 * macht die Seite unbenutzbar und wird ohnehin nicht gelesen. Die Zahl daneben
 * bleibt vollstaendig - abgeschnitten ist die Liste, nicht die Bilanz.
 */
const LIST_LIMIT = 40;

interface RowLine {
  rowNumber: number;
  text: string;
}

function pluralRows(count: number): string {
  return count === 1 ? '1 Zeile' : `${count} Zeilen`;
}

/** Ein Abschnitt mit Zeilennummern. Rendert nichts, wenn nichts drinsteht. */
function RowList({
  title,
  description,
  lines,
  tone = 'normal',
}: {
  title: string;
  description: string;
  lines: readonly RowLine[];
  tone?: 'normal' | 'danger';
}) {
  if (lines.length === 0) {
    return null;
  }

  const shown = lines.slice(0, LIST_LIMIT);
  const hidden = lines.length - shown.length;

  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="flex items-baseline gap-1.5 text-sm font-medium text-fg">
        {title}
        <span className="text-sm font-normal text-faint tabular-nums">{lines.length}</span>
      </h2>
      <p className="text-sm text-muted">{description}</p>
      <ul className="mt-0.5 rounded-md border border-border bg-surface">
        {shown.map((line, index) => (
          <li
            // Eine Zeilennummer kann mehrfach vorkommen (eine Zeile kann zwei
            // Werte verworfen haben), der Index macht den Schluessel eindeutig.
            key={`${line.rowNumber}-${index}`}
            className={cx(
              'flex gap-3 px-3 py-1.5',
              index < shown.length - 1 && 'border-b border-border',
            )}
          >
            <span className="w-16 shrink-0 text-right text-sm text-faint tabular-nums">
              Zeile {line.rowNumber}
            </span>
            <span className={cx('min-w-0 flex-1', tone === 'danger' ? 'text-danger' : 'text-fg')}>
              {line.text}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="text-sm text-faint tabular-nums">
          Und {pluralRows(hidden)} mehr, hier nicht aufgefuehrt.
        </p>
      ) : null}
    </section>
  );
}

const REASON_FALLBACK = 'ohne Begruendung';

function errorLines(rows: readonly ImportRowResult[]): RowLine[] {
  return rows
    .filter((row) => row.outcome === 'error')
    .map((row) => ({ rowNumber: row.rowNumber, text: row.reason ?? REASON_FALLBACK }));
}

function skippedLines(rows: readonly ImportRowResult[]): RowLine[] {
  return rows
    .filter((row) => row.outcome === 'skipped')
    .map((row) => ({ rowNumber: row.rowNumber, text: row.reason ?? REASON_FALLBACK }));
}

/**
 * Zeilen, die ueber die SCHWAECHSTE Dublettenstufe zugeordnet wurden.
 *
 * Weder E-Mail noch Profil-URL passten; uebrig blieb der Name. Zwei Menschen
 * mit demselben Namen sind damit ein Datensatz geworden, und das faellt
 * spaeter niemandem mehr auf. Deshalb steht diese Liste eigens da und nicht
 * unter "ergaenzt".
 */
function nameMatchLines(rows: readonly ImportRowResult[]): RowLine[] {
  return rows
    .filter((row) => row.matchedBy === 'name')
    .map((row) => {
      if (row.outcome === 'enriched') {
        const at = row.contactId === undefined ? '' : ` (Nr. ${row.contactId})`;
        return { rowNumber: row.rowNumber, text: `Bestehender Kontakt ergaenzt${at}.` };
      }
      // Der Grund allein ("nichts zu ergänzen") liest sich in DIESEM Abschnitt
      // wie eine Beschreibung des Namenstreffers. Das Vorwort sagt, was mit
      // der Zeile passiert ist, und der Grund bleibt woertlich der aus dem Lauf.
      const reason = row.reason ?? 'als Dublette behandelt';
      return { rowNumber: row.rowNumber, text: `Uebersprungen: ${reason}.` };
    });
}

function droppedLines(rows: readonly ImportRowResult[]): RowLine[] {
  const lines: RowLine[] = [];
  for (const row of rows) {
    for (const dropped of row.dropped ?? []) {
      lines.push({
        rowNumber: row.rowNumber,
        text: `${dropped.reason}: "${dropped.value}"`,
      });
    }
  }
  return lines;
}

export interface ImportSummaryViewProps {
  summary: ImportSummary;
  /** true, wenn nichts geschrieben wurde. Aendert jeden Satz auf dieser Seite. */
  dryRun: boolean;
  filename: string;
  /** Zurueck zur Vorschau derselben Datei - nach einem Trockenlauf der Normalfall. */
  onBack: () => void;
  /** Von vorn mit einer anderen Datei. */
  onReset: () => void;
}

export function ImportSummaryView({
  summary,
  dryRun,
  filename,
  onBack,
  onReset,
}: ImportSummaryViewProps) {
  const stats: ReadonlyArray<{ label: string; value: number }> = [
    { label: dryRun ? 'Waeren neu' : 'Neu angelegt', value: summary.created },
    { label: dryRun ? 'Waeren ergaenzt' : 'Ergaenzt', value: summary.enriched },
    { label: 'Uebersprungen', value: summary.skipped },
    { label: 'Fehler', value: summary.errors },
  ];

  const nameMatches = nameMatchLines(summary.rows);
  const dropped = droppedLines(summary.rows);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-md font-semibold tracking-tight text-fg">
            {dryRun ? 'Trockenlauf abgeschlossen' : 'Import abgeschlossen'}
          </h1>
          {dryRun ? <Badge variant="outline">Nichts gespeichert</Badge> : null}
        </div>
        <p className="text-sm text-muted">
          {dryRun
            ? `${filename}: ${pluralRows(summary.total)} durchgerechnet und wieder verworfen. `
              + 'In der Datenbank hat sich nichts geaendert.'
            : `${filename}: ${pluralRows(summary.total)} verarbeitet.`}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-surface px-3 py-2.5">
            <dt className="text-sm text-muted">{stat.label}</dt>
            <dd
              className={cx(
                'text-lg font-medium tabular-nums',
                stat.label === 'Fehler' && stat.value > 0 ? 'text-danger' : 'text-fg',
              )}
            >
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      <RowList
        title="Fehlerhafte Zeilen"
        description="Diese Zeilen wurden nicht uebernommen. Der Rest der Datei ist davon unberuehrt."
        lines={errorLines(summary.rows)}
        tone="danger"
      />

      <RowList
        title="Nur ueber den Namen zugeordnet"
        description={
          'Hier passte weder E-Mail noch Profil-URL, uebrig blieb der Name. Das ist die '
          + 'schwaechste Zuordnung - zwei verschiedene Menschen gleichen Namens landen so in '
          + 'einem Datensatz. Bitte diese Zeilen einzeln nachsehen.'
        }
        lines={nameMatches}
      />

      <RowList
        title="Uebersprungene Zeilen"
        description="Bereits vorhanden oder ohne verwertbaren Inhalt - hier ging nichts verloren."
        lines={skippedLines(summary.rows)}
      />

      <RowList
        title="Nicht uebernommene Werte"
        description={
          'Diese Zellen standen in der Datei, waren aber nicht eindeutig genug, um sie zu '
          + 'speichern. Die Zeile selbst wurde importiert.'
        }
        lines={dropped}
      />

      {/*
        Der Weg zurueck zur Liste ist ein next/link und kein window.location:
        die Anwendung navigiert im Router, ohne das Buendel neu zu laden. Die
        Klassen bilden die Button-Varianten nach, weil Button ein <button> ist
        und ein Link kein Knopf sein darf, der wie einer aussieht - hier ist es
        umgekehrt richtig herum.
      */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {dryRun ? (
          <Button variant="primary" onClick={onBack}>
            Zurueck zur Zuordnung
          </Button>
        ) : null}
        <Link
          href="/"
          className={cx(
            'inline-flex h-7 items-center rounded-sm border px-2.5 text-base font-medium',
            'transition-colors duration-75',
            dryRun
              ? 'border-border bg-surface text-fg hover:border-border-strong hover:bg-surface-sunken'
              : 'border-accent bg-accent text-accent-contrast hover:border-accent-strong hover:bg-accent-strong',
          )}
        >
          Zur Kontaktliste
        </Link>
        <Button variant={dryRun ? 'ghost' : 'outline'} onClick={onReset}>
          Weitere Datei importieren
        </Button>
      </div>
    </div>
  );
}
