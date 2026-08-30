import type { Metadata } from 'next';

import { ImportView } from '@/components/import/import-view';

export const metadata: Metadata = {
  title: 'Import',
};

/**
 * Die Import-Seite.
 *
 * Anders als Liste und Board holt diese Seite keinen Anfangszustand: es gibt
 * nichts zu laden, bevor eine Datei gewaehlt ist. Die Seite ist deshalb nur
 * die Huelle um die Ansicht, und die gesamte Bedienlogik liegt in
 * components/import.
 *
 * Kein force-dynamic: die Seite haengt an keiner Zeile der Datenbank, sie darf
 * statisch ausgeliefert werden. Was der Import schreibt, macht importCommitAction
 * ueber revalidatePath fuer Liste und Board wieder sichtbar.
 */
export default function ImportPage() {
  return <ImportView />;
}
