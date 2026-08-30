'use client';

import { Select, cx } from '@/components/ui';
import type { ColumnMapping, RawRow } from '@/lib/import/types';

import { IGNORE_VALUE, TARGET_OPTIONS, readTarget, targetToValue } from './targets';

/**
 * Die Vorschau: hoechstens zehn Datenzeilen, und ueber jeder Spalte das Ziel,
 * in das sie laeuft.
 *
 * Das Auswahlfeld sitzt im Tabellenkopf und nicht in einer Liste daneben, weil
 * die Frage "wohin gehoert diese Spalte?" nur mit den Werten darunter zu
 * beantworten ist. Eine Zuordnungsliste ueber der Tabelle zwaenge dazu, den
 * Spaltennamen im Kopf zu behalten und hin- und herzuschauen.
 *
 * Nicht importierte Spalten stehen vollstaendig in faint - der Ton, den die
 * Anwendung sonst fuer fehlende Werte benutzt. Man sieht auf einen Blick, was
 * die Datei verlaesst, ohne jedes Auswahlfeld einzeln zu lesen.
 */

const DASH = '—';

/** Zellzugriff, der nur eigene Properties gelten laesst - siehe readTarget. */
function cellOf(row: RawRow, header: string): string {
  if (!Object.hasOwn(row, header)) {
    return '';
  }
  const value: unknown = row[header];
  return typeof value === 'string' ? value : '';
}

export interface PreviewTableProps {
  headers: readonly string[];
  rows: readonly RawRow[];
  mapping: ColumnMapping;
  /** Spalten, deren Ziel doppelt vergeben ist. Werden markiert, nicht gesperrt. */
  conflictingHeaders: ReadonlySet<string>;
  disabled: boolean;
  onTargetChange: (header: string, value: string) => void;
}

export function PreviewTable({
  headers,
  rows,
  mapping,
  conflictingHeaders,
  disabled,
  onTargetChange,
}: PreviewTableProps) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full border-separate border-spacing-0 text-base">
        <caption className="sr-only">
          Die ersten Zeilen der Datei. Ueber jeder Spalte steht ein Auswahlfeld mit dem Feld,
          in das die Spalte importiert wird.
        </caption>

        <thead>
          <tr>
            {headers.map((header) => {
              const value = targetToValue(readTarget(mapping, header));
              const conflict = conflictingHeaders.has(header);
              return (
                <th
                  key={header}
                  scope="col"
                  className="border-b border-border bg-surface-sunken px-2 py-2 text-left align-bottom"
                >
                  <div className="flex w-44 flex-col gap-1.5">
                    <span
                      title={header}
                      className={cx(
                        'truncate text-sm font-medium',
                        value === IGNORE_VALUE ? 'text-faint' : 'text-muted',
                      )}
                    >
                      {header}
                    </span>
                    <Select
                      value={value}
                      disabled={disabled}
                      aria-invalid={conflict || undefined}
                      aria-label={`Zielfeld fuer die Spalte "${header}"`}
                      onChange={(event) => onTargetChange(header, event.target.value)}
                    >
                      {TARGET_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {rows.map((row, rowIndex) => (
            // Der Index ist hier ein zulaessiger Schluessel: die Vorschauzeilen
            // werden nie umsortiert, eingefuegt oder entfernt.
            <tr key={rowIndex}>
              {headers.map((header) => {
                const cell = cellOf(row, header);
                const ignored = targetToValue(readTarget(mapping, header)) === IGNORE_VALUE;
                return (
                  <td
                    key={header}
                    className={cx(
                      'h-8 border-border px-2 align-middle',
                      // Die letzte Zeile bekommt keine Linie: sie laege genau
                      // auf dem Rahmen des Kastens und ergaebe einen 2px-Strich.
                      rowIndex < rows.length - 1 && 'border-b',
                    )}
                  >
                    <span
                      title={cell === '' ? undefined : cell}
                      className={cx(
                        'block w-44 truncate',
                        cell === '' || ignored ? 'text-faint' : 'text-fg',
                      )}
                    >
                      {cell === '' ? DASH : cell}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
