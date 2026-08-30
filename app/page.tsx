import { ContactListView } from '@/components/contact-list/contact-list-view';

import { listContactsAction, listFilterOptionsAction } from './actions';

/**
 * Die Startseite: die Kontaktliste.
 *
 * Die Seite ist eine Server-Komponente und tut genau zwei Dinge - den ersten
 * Zustand holen und ihn an die Ansicht geben. Kein Zustand, kein Effekt, keine
 * Bedienlogik: die liegt vollstaendig in components/contact-list.
 *
 * Warum der erste Zustand hier und nicht im Browser entsteht: die Liste ist
 * damit im ersten gerenderten Bild schon gefuellt. Ein Client, der beim Mounten
 * erst seine erste Abfrage stellt, zeigt fuer einen Moment eine leere Tabelle -
 * bei einer lokalen SQLite-Datenbank ein selbst gemachtes Flackern.
 *
 * Geladen wird ueber dieselben Server Actions, die auch der Browser ruft. Sie
 * sind gewoehnliche asynchrone Funktionen auf dem Server; sie hier zu benutzen
 * statt lib/queries.ts direkt aufzurufen, haelt Validierung und Fehlertexte
 * auf beiden Wegen identisch.
 *
 * force-dynamic, weil die Daten in einer lokalen Datei liegen und sich
 * jederzeit aendern koennen - ein zur Bauzeit eingefrorenes Adressbuch waere
 * fuer diese Anwendung sinnlos.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [rowsResult, optionsResult] = await Promise.all([
    // Leere Filter: listContacts blendet dann genau die archivierten Kontakte
    // aus. Das ist der Standardfilter der Liste, und er steht nur an dieser
    // einen Stelle - in der Datenzugriffsschicht.
    listContactsAction({}),
    listFilterOptionsAction(),
  ]);

  const rows = rowsResult.ok ? rowsResult.data : [];
  const options = optionsResult.ok ? optionsResult.data : { cities: [], tags: [] };

  // Scheitert das Laden der Auswahlwerte, bleibt die Liste trotzdem benutzbar;
  // gemeldet wird der erste Fehler, der aufgetreten ist.
  const error = !rowsResult.ok
    ? rowsResult.error
    : !optionsResult.ok
      ? optionsResult.error
      : null;

  return <ContactListView initialRows={rows} initialOptions={options} initialError={error} />;
}
