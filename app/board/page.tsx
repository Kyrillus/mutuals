import type { Metadata } from 'next';

import { listBoardAction } from '@/app/actions';
import { BoardView } from '@/components/board/board-view';
import { EmptyState } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Board',
};

/**
 * Die Daten liegen in einer lokalen SQLite-Datei und aendern sich zwischen
 * zwei Aufrufen. Vorrendern zur Bauzeit waere hier nicht schneller, sondern
 * falsch - die Seite wird bei jedem Aufruf frisch gerendert.
 */
export const dynamic = 'force-dynamic';

/**
 * Das Kanban ueber die Phasen.
 *
 * Die Serverkomponente holt einmal den kompletten Stand (listBoardAction
 * liefert alle fuenf Phasen, ausschliesslich aktive Kontakte) und uebergibt
 * ihn an die Ansicht. Alles Weitere - Ziehen, Speichern, Detailansicht -
 * passiert im Browser, ohne die Seite neu zu laden.
 */
export default async function BoardPage() {
  const result = await listBoardAction();

  if (!result.ok) {
    return (
      <div className="mx-auto w-full max-w-md px-6 py-16">
        <EmptyState
          variant="framed"
          title="Das Board konnte nicht geladen werden."
          description={result.error}
        />
      </div>
    );
  }

  return <BoardView board={result.data} />;
}
