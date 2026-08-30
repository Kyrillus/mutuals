'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ContactDetailSheet } from '@/components/contact-detail';
import { COMMAND_PALETTE_EVENT, notifyContactsChanged } from '@/lib/ui-events';

import { NewContactDialog } from './command-palette/new-contact-dialog';
import { Palette, type PaletteAction } from './command-palette/palette';
import {
  dismissOpenDialogs,
  isBareKey,
  isModalOpen,
  isPaletteChord,
  isTypingTarget,
} from './command-palette/shortcuts';

/**
 * Die Kommandopalette und die globalen Tastenkuerzel.
 *
 * app/layout.tsx rendert diese Komponente einmal am Ende des Body. Sie ist
 * damit auf jeder Seite da und traegt drei Dinge, die zu keiner einzelnen
 * Ansicht gehoeren:
 *
 *   1. die Palette (Cmd/Strg+K oder der Hinweis in der Kopfzeile),
 *   2. den Dialog hinter "N",
 *   3. das Detail-Slide-over zu ?kontakt=<id>.
 *
 * WARUM DAS SLIDE-OVER HIER LIEGT. Die Palette muss einen Kontakt oeffnen
 * koennen, egal von wo - vom Board, vom Import, von der Liste. Der geoeffnete
 * Kontakt steht deshalb in der Adresse (/?kontakt=42): die Palette navigiert
 * zur Liste und oeffnet dort das Panel. Nebeneffekte, die man behalten will:
 * die Adresse ist teilbar, und der Zurueck-Knopf schliesst das Panel.
 *
 * Liste und Board haben ihr EIGENES Slide-over fuer den Klick auf eine Zeile
 * bzw. eine Karte; das hier ist der Weg fuer alles, was von aussen kommt.
 * Damit nie zwei Panels uebereinander liegen, schliesst das Oeffnen aus der
 * Palette ein bereits offenes fremdes Panel - siehe openContact.
 *
 * Aenderungen von hier aus muessen auf zwei Wegen bekanntgegeben werden, weil
 * die beiden Ansichten ihren Zustand verschieden fuehren:
 *   router.refresh()        - das Board leitet seine Spalten aus den Props ab
 *                             und erneuert sich damit von selbst.
 *   notifyContactsChanged() - die Listenansicht fuehrt Filter, Sortierung und
 *                             Zeilen in eigenem Zustand und wuerde ein
 *                             Neurendern der Serverkomponente gar nicht
 *                             bemerken. Sie wiederholt auf dieses Ereignis hin
 *                             ihre aktuelle Abfrage.
 */

/** Der Name des Suchparameters. Deutsch wie die Oberflaeche. */
const CONTACT_PARAM = 'kontakt';

/**
 * Der Parameter wird aus window.location gelesen und NICHT ueber
 * useSearchParams. Das ist hier kein Geschmack, sondern gemessen:
 *
 *   - useSearchParams laesst den Baum bis zur naechsten Suspense-Grenze im
 *     Browser rendern. Eine solche Grenze in dieser Komponente wird unter
 *     Next 16.3.3 im Layout nie aufgeloest - der Teilbaum bleibt nach einem
 *     Seitenaufruf unhydriert, und damit haengt kein einziger Handler: keine
 *     Palette, kein Kuerzel.
 *   - Ohne Suspense-Grenze bricht dafuer `next build` ab, sobald eine
 *     vorgerenderte Seite das Layout enthaelt ("/404").
 *
 * Die Adresse selbst zu lesen umgeht beides. Sie ist im Browser jederzeit
 * verfuegbar, und die drei Wege, auf denen sie sich aendert, sind hier alle
 * abgedeckt: Oeffnen und Schliessen setzen den Zustand selbst, Zurueck und
 * Vorwaerts kommen ueber popstate an.
 */
function readContactId(): number | null {
  const raw = new URLSearchParams(window.location.search).get(CONTACT_PARAM);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function CommandPalette() {
  const router = useRouter();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  /** null heisst: kein Panel offen. Startet null, auch bei /?kontakt=42 -
      der erste Stand kommt aus dem Effekt unten, damit sich das Rendern im
      Browser nicht vom serverseitigen unterscheidet. */
  const [contactId, setContactId] = useState<number | null>(null);

  /** Erster Abgleich mit der Adresse, danach bei jedem Zurueck und Vorwaerts. */
  useEffect(() => {
    const sync = (): void => setContactId(readContactId());
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  /**
   * Kontakt oeffnen: zur Liste navigieren und den Parameter setzen.
   *
   * router.push und kein Vollseiten-Reload; scroll: false, weil die Liste
   * beim Oeffnen eines Panels nicht an den Anfang springen soll. Das Panel
   * selbst haengt am Zustand und nicht an der Antwort der Navigation - es
   * steht damit sofort und nicht erst, wenn der Server die Liste neu
   * gerendert hat.
   *
   * Liegt schon ein fremdes Slide-over offen (Liste oder Board), wird es
   * vorher geschlossen - zwei Panels uebereinander waeren zweimal Escape und
   * ein doppelt abgedunkelter Grund. Ist dagegen bereits DIESES Panel offen,
   * bleibt es stehen und laedt nur den neuen Kontakt: dieselbe Komponente,
   * andere contactId.
   */
  const openContact = useCallback(
    (id: number) => {
      setPaletteOpen(false);
      if (contactId === null) {
        dismissOpenDialogs();
      }
      setContactId(id);
      router.push(`/?${CONTACT_PARAM}=${id}`, { scroll: false });
    },
    [contactId, router],
  );

  /** Schliessen heisst: Parameter aus der Adresse nehmen, ohne Verlaufseintrag. */
  const closeContact = useCallback(() => {
    setContactId(null);
    const params = new URLSearchParams(window.location.search);
    params.delete(CONTACT_PARAM);
    const query = params.toString();
    const path = window.location.pathname;
    router.replace(query === '' ? path : `${path}?${query}`, { scroll: false });
  }, [router]);

  /** Ansicht wechseln. Das Panel gehoert zur Liste und geht dabei zu. */
  const navigate = useCallback(
    (href: string) => {
      setContactId(null);
      router.push(href);
    },
    [router],
  );

  /**
   * Nach jeder Aenderung im Panel beide Ansichten benachrichtigen - warum zwei
   * Wege noetig sind, steht im Kopfkommentar.
   */
  const handleChanged = useCallback(() => {
    router.refresh();
    notifyContactsChanged();
  }, [router]);

  const handleCreated = useCallback(
    (id: number) => {
      setCreating(false);
      // Der neue Kontakt fehlt in der Tabelle dahinter, bis sie neu abfragt.
      router.refresh();
      notifyContactsChanged();
      openContact(id);
    },
    [openContact, router],
  );

  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        id: 'new-contact',
        label: 'Neuen Kontakt anlegen',
        keywords: 'neu person hinzufuegen erstellen',
        run: () => setCreating(true),
      },
      {
        id: 'list',
        label: 'Zur Liste',
        keywords: 'kontakte tabelle start uebersicht',
        run: () => navigate('/'),
      },
      {
        id: 'board',
        label: 'Zum Board',
        keywords: 'kanban phasen stage spalten',
        run: () => navigate('/board'),
      },
      {
        id: 'import',
        label: 'Zum Import',
        keywords: 'csv xlsx linkedin datei hochladen',
        run: () => navigate('/import'),
      },
    ],
    [navigate],
  );

  /** Der Hinweis in der Kopfzeile kennt die Palette nicht - er ruft ueber das Fenster. */
  useEffect(() => {
    const open = (): void => setPaletteOpen(true);
    window.addEventListener(COMMAND_PALETTE_EVENT, open);
    return () => window.removeEventListener(COMMAND_PALETTE_EVENT, open);
  }, []);

  /**
   * Die globalen Kuerzel.
   *
   * Der Unterschied zwischen den beiden ist der wichtigste Teil dieser Datei:
   *
   *   Cmd/Strg+K ist ein Griff mit Zusatztaste. Er gilt IMMER, auch mitten im
   *   Suchfeld der Liste - dort will man ihn sogar. preventDefault ist
   *   Pflicht, sonst legt der Browser seine eigene Suche darueber.
   *
   *   "N" ist ein nackter Buchstabe und damit ein Zeichen, das der Nutzer
   *   genauso gut schreiben wollte. Es feuert nur, wenn beides gilt: das
   *   Ereignis kommt nicht aus einem Eingabefeld (isTypingTarget) UND es
   *   liegt nichts Modales offen (isModalOpen). Die erste Sperre ist die
   *   entscheidende - ohne sie legt jedes "n" in einer Notiz einen Kontakt
   *   an. Die zweite haelt zusaetzlich den Fall ab, dass der Fokus im
   *   Slide-over gerade auf einem Knopf steht.
   *
   * Der Empfaenger ist das Fenster in der Blasenphase: Ereignisse aus einem
   * offenen <dialog> steigen bis hierher auf, und was Popover oder
   * Inline-Editor vorher fuer sich beansprucht haben (Escape, Enter), kommt
   * gar nicht erst an.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Schon behandelt, oder Teil einer Zeichenkomposition (IME): nicht unseres.
      if (event.defaultPrevented || event.isComposing) {
        return;
      }

      if (isPaletteChord(event)) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (isTypingTarget(event.target) || isModalOpen()) {
        return;
      }

      if (isBareKey(event, 'n')) {
        event.preventDefault();
        setCreating(true);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <Palette
        open={paletteOpen}
        onClose={closePalette}
        actions={actions}
        onSelectContact={openContact}
      />
      <NewContactDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={handleCreated}
      />
      <ContactDetailSheet contactId={contactId} onClose={closeContact} onChanged={handleChanged} />
    </>
  );
}
