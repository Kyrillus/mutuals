'use client';

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';

import { importCommitAction, importPreviewAction } from '@/app/actions';
import type { ActionResult, ImportPreview } from '@/app/actions';
import { Badge, Button, InlineError, cx } from '@/components/ui';
import type { ColumnMapping, ImportSummary } from '@/lib/import/types';

import { DropZone } from './drop-zone';
import { ImportSummaryView } from './import-summary';
import { PreviewTable } from './preview-table';
import { analyzeMapping, valueToTarget, withTarget } from './targets';

/**
 * Die Import-Oberflaeche: Datei waehlen, Zuordnung pruefen, importieren.
 *
 * Der wichtigste Zustand hier ist die Datei selbst. Sie geht ZWEIMAL zum
 * Server - einmal fuer die Vorschau, einmal fuer den Import - und es gibt
 * dazwischen keinen serverseitigen Zwischenspeicher (siehe die Begruendung an
 * importCommitAction). Das File-Objekt bleibt deshalb im Zustand liegen und
 * wird beim Bestaetigen erneut in ein FormData gepackt. Wer die Seite neu
 * laedt, faengt bei der Dateiauswahl an; das ist der Preis dafuer, dass keine
 * halbfertigen Uploads auf dem Server herumliegen.
 *
 * Der Ablauf in Zustaenden:
 *   keine Datei          -> Ablageflaeche
 *   Datei + Vorschau     -> Kopfzeile, Warnungen, Tabelle, Zuordnung, Knoepfe
 *   Bilanz              -> Zusammenfassung (Trockenlauf oder echter Import)
 *
 * Aus der Bilanz eines Trockenlaufs geht es zurueck zur Zuordnung, ohne die
 * Datei erneut zu waehlen - genau dafuer ist ein Trockenlauf da.
 */

/** Dateiformat, wie es in der Kopfzeile stehen soll. */
const FORMAT_LABELS: Record<string, string> = {
  csv: 'CSV',
  xlsx: 'Excel (.xlsx)',
  xls: 'Excel (.xls)',
};

/**
 * Was gerade laeuft. Reicht als Sperre nicht aus (Zustandsaenderungen wirken
 * erst beim naechsten Rendern), deshalb steht daneben noch ein ref - siehe
 * running.
 */
type Busy = 'preview' | 'commit' | null;

interface SummaryState {
  data: ImportSummary;
  /** Ob diese Bilanz aus einem Trockenlauf stammt. Aendert jeden Satz darin. */
  dryRun: boolean;
}

/**
 * Ruft eine Server Action und faengt ab, was gar nicht erst ankommt.
 *
 * Die Actions selbst werfen nie - sie liefern ein ActionResult. Was hier
 * trotzdem als Ausnahme landen kann, ist der Weg dorthin: eine abgerissene
 * Verbindung oder eine Anfrage, die der Server als zu gross zurueckweist. Ein
 * unbehandeltes Promise waere an dieser Stelle eine Seite, die einfach nichts
 * mehr tut.
 */
async function guarded<T>(work: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await work();
  } catch (error) {
    console.error('[import]', error);
    return {
      ok: false,
      error:
        'Die Datei konnte nicht an den Server uebertragen werden. Moeglicherweise ist sie zu '
        + 'gross oder die Verbindung ist abgerissen. Bitte noch einmal versuchen.',
    };
  }
}

function preambleText(lines: number): string {
  if (lines === 0) {
    return 'Keine Praeambel';
  }
  return lines === 1 ? '1 Zeile Praeambel erkannt' : `${lines} Zeilen Praeambel erkannt`;
}

function rowsText(count: number): string {
  return count === 1 ? '1 Datenzeile' : `${count} Datenzeilen`;
}

export function ImportView() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dryRun, setDryRun] = useState(false);
  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const [, startTransition] = useTransition();

  /**
   * Die eigentliche Sperre gegen doppeltes Absenden.
   *
   * Die Knoepfe sind waehrend eines Laufs zwar deaktiviert, aber zwischen dem
   * Klick und dem Rendern mit busy liegt ein Moment, in dem ein zweiter Klick
   * (oder die Leertaste, die noch gedrueckt ist) durchkommt. Ein ref ist sofort
   * gesetzt und kennt diese Luecke nicht. Bei einem Import ist der Unterschied
   * nicht kosmetisch: zwei Laeufe legen dieselben Kontakte doppelt an.
   */
  const running = useRef(false);

  const analysis = useMemo(
    () => analyzeMapping(preview?.headers ?? [], mapping),
    [preview, mapping],
  );

  const handleReject = useCallback((message: string) => {
    setError(message);
  }, []);

  const handleFile = useCallback(
    (next: File) => {
      if (running.current) {
        return;
      }
      running.current = true;

      setError(null);
      setSummary(null);
      setPreview(null);
      setMapping({});
      setFile(next);
      setBusy('preview');

      startTransition(async () => {
        const form = new FormData();
        form.append('file', next);
        const result = await guarded(() => importPreviewAction(form));

        if (result.ok) {
          setPreview(result.data);
          setMapping(result.data.suggestion.mapping);
        } else {
          setFile(null);
          setError(result.error);
        }
        setBusy(null);
        running.current = false;
      });
    },
    [startTransition],
  );

  const handleTargetChange = useCallback((header: string, value: string) => {
    setMapping((previous) => withTarget(previous, header, valueToTarget(value)));
  }, []);

  const handleReset = useCallback(() => {
    if (running.current) {
      return;
    }
    setFile(null);
    setPreview(null);
    setMapping({});
    setSummary(null);
    setError(null);
  }, []);

  const handleBack = useCallback(() => {
    setSummary(null);
    setError(null);
  }, []);

  const blocked = analysis.conflictLabels.length > 0;

  /**
   * Der Satz zu den doppelt vergebenen Zielen. Als Variable und nicht im JSX,
   * damit der Einzahlfall den ersten Eintrag sauber herausgreifen kann - eine
   * Indizierung im Text haette bei leerer Liste "undefined" gerendert.
   */
  const [firstConflict] = analysis.conflictLabels;
  const conflictSentence =
    firstConflict === undefined
      ? null
      : analysis.conflictLabels.length === 1
        ? `Das Zielfeld "${firstConflict}" ist mehrfach vergeben.`
        : `Diese Zielfelder sind mehrfach vergeben: ${analysis.conflictLabels.join(', ')}.`;

  function handleRun(): void {
    if (running.current || file === null || preview === null || blocked) {
      return;
    }
    running.current = true;

    // Festgehalten, bevor der Lauf beginnt: waehrend er laeuft, kann sich der
    // Schalter nicht mehr aendern (die Bedienelemente sind gesperrt), aber die
    // Bilanz muss hinterher wissen, welcher Lauf sie erzeugt hat.
    const wasDryRun = dryRun;

    // LinkedIn-Dateien bekommen source 'linkedin', alles andere 'csv'. Die
    // Erkennung stammt aus suggestMapping und wird hier nur weitergereicht.
    const source = preview.suggestion.detectedSource === 'linkedin' ? 'linkedin' : 'csv';

    setError(null);
    setBusy('commit');

    startTransition(async () => {
      const form = new FormData();
      form.append('file', file);
      const result = await guarded(() => importCommitAction(form, mapping, source, wasDryRun));

      if (result.ok) {
        setSummary({ data: result.data, dryRun: wasDryRun });
      } else {
        setError(result.error);
      }
      setBusy(null);
      running.current = false;
    });
  }

  if (summary !== null && file !== null) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6">
        <ImportSummaryView
          summary={summary.data}
          dryRun={summary.dryRun}
          filename={file.name}
          onBack={handleBack}
          onReset={handleReset}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-md font-semibold tracking-tight text-fg">Import</h1>
        <p className="text-sm text-muted">
          Kontakte aus einer CSV- oder Excel-Datei uebernehmen. Vor dem Schreiben wird
          angezeigt, welche Spalte in welches Feld laeuft - erst danach passiert etwas.
        </p>
      </div>

      <InlineError>{error}</InlineError>

      {preview === null || file === null ? (
        <DropZone
          onFile={handleFile}
          onReject={handleReject}
          disabled={busy !== null}
          busy={busy === 'preview'}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface px-3 py-2.5">
            <span className="text-base font-medium text-fg">{file.name}</span>
            <Badge variant="outline">{FORMAT_LABELS[preview.format] ?? preview.format}</Badge>
            <span className="text-sm text-muted tabular-nums">{rowsText(preview.totalRows)}</span>
            <span
              className={cx(
                'text-sm tabular-nums',
                preview.preambleLines > 0 ? 'text-fg' : 'text-muted',
              )}
            >
              {preambleText(preview.preambleLines)}
            </span>
            {preview.suggestion.detectedSource === 'linkedin' ? (
              <Badge>LinkedIn-Export erkannt</Badge>
            ) : null}
            <Button
              variant="outline"
              className="ml-auto"
              disabled={busy !== null}
              onClick={handleReset}
            >
              Andere Datei
            </Button>
          </div>

          {preview.warnings.length > 0 ? (
            <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5">
              <p className="text-sm font-medium text-fg">Beim Lesen aufgefallen</p>
              <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-base text-muted">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 className="text-sm font-medium text-fg">Zuordnung der Spalten</h2>
              <p className="text-sm text-muted">
                {preview.rows.length === preview.totalRows
                  ? 'Alle Zeilen der Datei.'
                  : `Die ersten ${preview.rows.length} von ${preview.totalRows} Zeilen.`}{' '}
                Ueber jeder Spalte steht das Feld, in das sie geschrieben wird.
              </p>
            </div>

            <PreviewTable
              headers={preview.headers}
              rows={preview.rows}
              mapping={mapping}
              conflictingHeaders={analysis.conflictingHeaders}
              disabled={busy !== null}
              onTargetChange={handleTargetChange}
            />

            <div className="flex flex-col gap-1">
              {conflictSentence === null ? null : (
                <InlineError>
                  {conflictSentence} Jedes Feld kann nur aus einer Spalte kommen; die zweite Spalte
                  ginge stillschweigend verloren. Ausgenommen sind Vorname und Nachname - die bilden
                  gemeinsam den Namen.
                </InlineError>
              )}

              {analysis.missingName ? (
                <p className="text-sm text-danger">
                  Keine Spalte fuellt den Namen. Ohne Namen bleibt jede Zeile liegen - bitte eine
                  Spalte auf &bdquo;Name&ldquo; oder auf &bdquo;Vorname&ldquo; und
                  &bdquo;Nachname&ldquo; stellen.
                </p>
              ) : null}

              {analysis.nameOverridesParts ? (
                <p className="text-sm text-muted">
                  Neben &bdquo;Name&ldquo; sind auch Vorname oder Nachname vergeben. Die
                  vollstaendige Namensspalte hat Vorrang; die Teile bleiben ungenutzt.
                </p>
              ) : null}

              {analysis.ignoredCount > 0 ? (
                <p className="text-sm text-muted tabular-nums">
                  {analysis.ignoredCount === 1
                    ? '1 Spalte wird nicht importiert'
                    : `${analysis.ignoredCount} Spalten werden nicht importiert`}
                  {' '}
                  - ihre Werte landen nicht in der Datenbank.
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <label
              htmlFor="import-dry-run"
              className="flex max-w-md items-start gap-2 rounded-sm border border-border bg-surface px-2.5 py-2"
            >
              <input
                id="import-dry-run"
                type="checkbox"
                checked={dryRun}
                disabled={busy !== null}
                onChange={(event) => setDryRun(event.target.checked)}
                className="mt-1 size-3.5 shrink-0 accent-accent"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-medium text-fg">Nur testen</span>
                <span className="text-sm text-muted">
                  Rechnet den vollstaendigen Import durch, einschliesslich Dublettenpruefung, und
                  verwirft ihn am Ende wieder. Es wird nichts gespeichert.
                </span>
              </span>
            </label>

            <Button
              variant="primary"
              loading={busy === 'commit'}
              disabled={blocked || busy !== null}
              onClick={handleRun}
            >
              {dryRun ? 'Trockenlauf starten' : `${rowsText(preview.totalRows)} importieren`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
