'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  addNeedAction,
  addNoteAction,
  addOfferAction,
  addTagAction,
  deleteContactAction,
  deleteNeedAction,
  deleteNoteAction,
  deleteOfferAction,
  getContactDetailAction,
  removeTagAction,
  setStatusAction,
  toggleNeedResolvedAction,
  toggleOfferResolvedAction,
  updateContactAction,
  updateNeedTextAction,
  updateOfferTextAction,
} from '@/app/actions';
import { Button, EmptyState, InlineError, Sheet } from '@/components/ui';
import type { ContactStatus } from '@/lib/constants';
import type {
  ContactDetail,
  ContactItem,
  ContactListRow,
  ContactPatch,
  Note,
  Tag,
} from '@/lib/types';

import { ConfirmInline } from './confirm-inline';
import { ContactFields, ContactHeader } from './contact-fields';
import {
  itemsOf,
  replaceItem,
  sortNotes,
  sortTags,
  toListRow,
  withItems,
  type ItemKind,
} from './detail-model';
import { ItemSection } from './item-section';
import { NoteSection } from './note-section';
import { TagEditor } from './tag-editor';

/**
 * Die Detailansicht eines Kontakts als Slide-over.
 *
 * DER ZUSTAND, in Kurzform: hier liegt eine Kopie des Kontakts, und jede
 * Aenderung schreibt zuerst auf den Server und danach in diese Kopie. Die
 * Ausnahme sind die beiden gefahrlosen Faelle - Erledigt-Markierung und
 * Tag-Entfernen -, die sofort in der Anzeige stehen und bei einem Fehler
 * zurueckgenommen werden.
 *
 * Warum ueberhaupt eine Kopie und kein router.refresh() nach jeder Aenderung:
 * ein neu gerendertes Panel verliert Scrollstand, Fokus und halb getippte
 * Eingaben. In einer Ansicht, in der man vierzehn Felder hintereinander
 * durchgeht, ist das der Unterschied zwischen einem Werkzeug und einem
 * Formular.
 *
 * detailRef statt nur useState: die Aenderungen laufen asynchron und teils
 * ueberlappend. Jede Handlung muss den Stand sehen, der beim Eintreffen der
 * Antwort gilt, und nicht den, der beim Klick galt - sonst macht eine
 * langsame Antwort eine schnellere daneben rueckgaengig. Die Referenz wird
 * synchron mitgefuehrt, der Zustand ist nur die Anzeige davon.
 *
 * onChanged meldet nach oben, was sich geaendert hat, damit Liste und Board
 * ihre Zeile ersetzen koennen; null heisst geloescht. Beim ERSTEN Laden wird
 * bewusst nicht gemeldet: das Oeffnen einer Ansicht ist keine Aenderung, und
 * das Board wuerde sich sonst bei jedem Klick auf eine Karte neu laden.
 */

/** Wenn zwischen Klick und Antwort das Panel geschlossen wurde. */
const NOT_LOADED = 'Der Kontakt ist nicht mehr geoeffnet.';

export interface ContactDetailSheetProps {
  /** null heisst geschlossen. */
  contactId: number | null;
  onClose: () => void;
  /** Nach jeder Aenderung; null bedeutet, der Kontakt wurde geloescht. */
  onChanged: (updated: ContactListRow | null) => void;
}

export function ContactDetailSheet({ contactId, onClose, onChanged }: ContactDetailSheetProps) {
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [footerPending, setFooterPending] = useState(false);
  const [footerError, setFooterError] = useState<string | null>(null);

  const detailRef = useRef<ContactDetail | null>(null);
  const request = useRef(0);

  /**
   * onChanged in einer Referenz: die Ansichten geben die Funktion bei jedem
   * Rendern neu herein, und die Mutationen sollen deswegen nicht neu gebaut
   * werden.
   */
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  });

  const commit = useCallback((next: ContactDetail) => {
    detailRef.current = next;
    setDetail(next);
    changed.current(toListRow(next));
  }, []);

  /**
   * Laden. Die laufende Nummer verwirft ueberholte Antworten: wer schnell
   * durch die Liste klickt, sieht sonst am Ende den Kontakt, dessen Abfrage
   * zufaellig zuletzt zurueckkam.
   */
  useEffect(() => {
    const seq = request.current + 1;
    request.current = seq;

    detailRef.current = null;
    setDetail(null);
    setLoadError(null);
    setConfirmingDelete(false);
    setFooterError(null);

    if (contactId === null) {
      return;
    }

    void getContactDetailAction(contactId).then((result) => {
      if (seq !== request.current) {
        return;
      }
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      detailRef.current = result.data;
      setDetail(result.data);
    });
  }, [contactId]);

  // -------------------------------------------------------------------------
  // Aenderungen. Alle geben eine anzeigbare Meldung zurueck - oder null.
  // -------------------------------------------------------------------------

  async function patchContact(patch: ContactPatch): Promise<string | null> {
    const current = detailRef.current;
    if (current === null) {
      return NOT_LOADED;
    }
    const result = await updateContactAction(current.id, patch);
    if (!result.ok) {
      return result.error;
    }
    const base = detailRef.current ?? current;
    // Der Server schickt den ganzen Kontakt zurueck - auch den Status, der
    // sich beim Bearbeiten eines importierten Kontakts mit aendert.
    commit({ ...base, ...result.data });
    return null;
  }

  async function changeStatus(status: ContactStatus): Promise<string | null> {
    const current = detailRef.current;
    if (current === null) {
      return NOT_LOADED;
    }
    const result = await setStatusAction(current.id, status);
    if (!result.ok) {
      return result.error;
    }
    const base = detailRef.current ?? current;
    commit({ ...base, ...result.data });
    return null;
  }

  async function addItem(kind: ItemKind, text: string): Promise<string | null> {
    const current = detailRef.current;
    if (current === null) {
      return NOT_LOADED;
    }
    const result =
      kind === 'need' ? await addNeedAction(current.id, text) : await addOfferAction(current.id, text);
    if (!result.ok) {
      return result.error;
    }
    const base = detailRef.current;
    if (base === null) {
      return null;
    }
    commit(withItems(base, kind, [...itemsOf(base, kind), result.data]));
    return null;
  }

  /**
   * Erledigt-Markierung, optimistisch: das Durchstreichen steht sofort da und
   * wird zurueckgenommen, wenn der Server widerspricht. Der Zeitstempel ist
   * nur eine Anzeige - die Antwort ersetzt ihn gleich durch den echten.
   */
  async function toggleItem(kind: ItemKind, item: ContactItem): Promise<string | null> {
    const base = detailRef.current;
    if (base === null) {
      return NOT_LOADED;
    }

    const resolved = item.resolved_at === null;
    commit(
      withItems(
        base,
        kind,
        replaceItem(itemsOf(base, kind), {
          ...item,
          resolved_at: resolved ? new Date().toISOString() : null,
        }),
      ),
    );

    const result =
      kind === 'need'
        ? await toggleNeedResolvedAction(item.id, resolved)
        : await toggleOfferResolvedAction(item.id, resolved);

    const after = detailRef.current;
    if (after === null) {
      return null;
    }
    commit(withItems(after, kind, replaceItem(itemsOf(after, kind), result.ok ? result.data : item)));
    return result.ok ? null : result.error;
  }

  async function editItem(kind: ItemKind, item: ContactItem, text: string): Promise<string | null> {
    const result =
      kind === 'need'
        ? await updateNeedTextAction(item.id, text)
        : await updateOfferTextAction(item.id, text);
    if (!result.ok) {
      return result.error;
    }
    const after = detailRef.current;
    if (after === null) {
      return null;
    }
    commit(withItems(after, kind, replaceItem(itemsOf(after, kind), result.data)));
    return null;
  }

  async function removeItem(kind: ItemKind, item: ContactItem): Promise<string | null> {
    const result = kind === 'need' ? await deleteNeedAction(item.id) : await deleteOfferAction(item.id);
    if (!result.ok) {
      return result.error;
    }
    const after = detailRef.current;
    if (after === null) {
      return null;
    }
    commit(
      withItems(
        after,
        kind,
        itemsOf(after, kind).filter((entry) => entry.id !== item.id),
      ),
    );
    return null;
  }

  async function addNote(body: string, occurredOn: string): Promise<string | null> {
    const current = detailRef.current;
    if (current === null) {
      return NOT_LOADED;
    }
    const result = await addNoteAction(current.id, body, occurredOn);
    if (!result.ok) {
      return result.error;
    }
    const base = detailRef.current;
    if (base === null) {
      return null;
    }
    commit({ ...base, notes: sortNotes([...(base.notes ?? []), result.data]) });

    /*
     * Eine Notiz belegt, dass Kontakt stattgefunden hat - lib/queries.ts zieht
     * deshalb last_contact_at nach. Diese Regel wird hier NICHT nachgebaut,
     * sondern der Kontakt noch einmal geholt. Eine an zwei Stellen
     * geschriebene Geschaeftsregel ist eine Regel, die eines Tages zwei
     * verschiedene Ergebnisse liefert.
     */
    void reload(current.id);
    return null;
  }

  async function removeNote(note: Note): Promise<string | null> {
    const result = await deleteNoteAction(note.id);
    if (!result.ok) {
      return result.error;
    }
    const after = detailRef.current;
    if (after === null) {
      return null;
    }
    commit({ ...after, notes: (after.notes ?? []).filter((entry) => entry.id !== note.id) });
    return null;
  }

  async function addTag(name: string): Promise<string | null> {
    const current = detailRef.current;
    if (current === null) {
      return NOT_LOADED;
    }
    const result = await addTagAction(current.id, name);
    if (!result.ok) {
      return result.error;
    }
    const after = detailRef.current;
    if (after === null) {
      return null;
    }
    // Die Action liefert die vollstaendige neue Tagliste; sie wird ersetzt und
    // nicht fortgeschrieben.
    commit({ ...after, tags: result.data });
    return null;
  }

  /** Optimistisch: der Chip verschwindet sofort und kommt bei einem Fehler zurueck. */
  async function removeTag(tag: Tag): Promise<string | null> {
    const base = detailRef.current;
    if (base === null) {
      return NOT_LOADED;
    }
    commit({ ...base, tags: base.tags.filter((entry) => entry.id !== tag.id) });

    const result = await removeTagAction(base.id, tag.id);
    const after = detailRef.current;
    if (after === null) {
      return null;
    }
    if (!result.ok) {
      commit({ ...after, tags: sortTags([...after.tags, tag]) });
      return result.error;
    }
    commit({ ...after, tags: result.data });
    return null;
  }

  async function reload(id: number): Promise<void> {
    const result = await getContactDetailAction(id);
    if (!result.ok || detailRef.current === null || detailRef.current.id !== id) {
      return;
    }
    commit(result.data);
  }

  async function toggleArchived(): Promise<void> {
    const current = detailRef.current;
    if (current === null) {
      return;
    }
    setFooterPending(true);
    const message = await changeStatus(current.status === 'archived' ? 'active' : 'archived');
    setFooterPending(false);
    setFooterError(message);
  }

  async function removeContact(): Promise<void> {
    const current = detailRef.current;
    if (current === null) {
      return;
    }
    setFooterPending(true);
    const result = await deleteContactAction(current.id);
    setFooterPending(false);
    if (!result.ok) {
      setFooterError(result.error);
      return;
    }
    detailRef.current = null;
    setDetail(null);
    setConfirmingDelete(false);
    changed.current(null);
    onClose();
  }

  // -------------------------------------------------------------------------
  // Anzeige
  // -------------------------------------------------------------------------

  const archived = detail !== null && detail.status === 'archived';

  const footer = (
    <div className="flex w-full min-w-0 items-center gap-2">
      {confirmingDelete ? (
        <ConfirmInline
          question="Kontakt und alle Eintraege endgueltig loeschen?"
          confirmLabel="Loeschen"
          pending={footerPending}
          onConfirm={() => void removeContact()}
          onCancel={() => setConfirmingDelete(false)}
          className="w-full"
        />
      ) : (
        <>
          <Button
            variant="ghost"
            disabled={detail === null}
            loading={footerPending}
            onClick={() => void toggleArchived()}
            className="text-muted hover:text-fg"
          >
            {archived ? 'Archivierung aufheben' : 'Kontakt archivieren'}
          </Button>
          <InlineError className="min-w-0 flex-1 truncate">{footerError}</InlineError>
          <Button
            variant="danger"
            disabled={detail === null}
            onClick={() => {
              setFooterError(null);
              setConfirmingDelete(true);
            }}
            className="ml-auto shrink-0"
          >
            Kontakt loeschen
          </Button>
        </>
      )}
    </div>
  );

  return (
    <Sheet
      open={contactId !== null}
      onClose={onClose}
      ariaLabel={detail === null ? 'Kontakt' : `Kontakt: ${detail.name}`}
      width="lg"
      footer={footer}
    >
      {loadError !== null ? (
        <div className="px-4 py-10">
          <EmptyState
            variant="framed"
            title="Der Kontakt konnte nicht geladen werden."
            description={loadError}
          />
        </div>
      ) : detail === null ? (
        <DetailSkeleton />
      ) : (
        <>
          <ContactHeader contact={detail} onPatch={patchContact} />
          <ContactFields contact={detail} onPatch={patchContact} onStatus={changeStatus} />

          <TagEditor tags={detail.tags} onAdd={addTag} onRemove={removeTag} />

          <ItemSection
            title="Needs"
            noun="Need"
            items={detail.needs}
            addPlaceholder="Was sucht diese Person?"
            emptyTitle="Noch keine Needs erfasst."
            onAdd={(text) => addItem('need', text)}
            onToggle={(item) => toggleItem('need', item)}
            onEditText={(item, text) => editItem('need', item, text)}
            onDelete={(item) => removeItem('need', item)}
          />

          <ItemSection
            title="Offers"
            noun="Offer"
            items={detail.offers}
            addPlaceholder="Was kann diese Person bieten?"
            emptyTitle="Noch keine Offers erfasst."
            onAdd={(text) => addItem('offer', text)}
            onToggle={(item) => toggleItem('offer', item)}
            onEditText={(item, text) => editItem('offer', item, text)}
            onDelete={(item) => removeItem('offer', item)}
          />

          <NoteSection notes={detail.notes ?? []} onAdd={addNote} onDelete={removeNote} />
        </>
      )}
    </Sheet>
  );
}

/**
 * Ein Balken je Feldzeile, in wechselnder Laenge.
 *
 * Die Anzahl ist nicht geraten: es sind genau so viele, wie ContactFields
 * Zeilen hat. Ein zu kurzes Geruest schiebt beim Eintreffen der Daten die
 * Bloecke darunter nach unten - also das, was es verhindern soll.
 */
const SKELETON_WIDTHS = [
  '48%',
  '72%',
  '58%',
  '40%',
  '46%',
  '80%',
  '52%',
  '86%',
  '38%',
  '92%',
  '44%',
  '50%',
  '36%',
  '64%',
];

/**
 * Das Geruest waehrend des Ladens.
 *
 * Es hat die Masse des fertigen Inhalts: dieselbe Kopfhoehe, dieselbe
 * Zeilenhoehe, dieselben Trennlinien. Ein Slide-over, das leer aufgeht und
 * seinen Inhalt danach hineinschiebt, laesst den Blick zweimal suchen.
 */
function DetailSkeleton() {
  return (
    <div>
      <span role="status" className="sr-only">
        Kontakt wird geladen
      </span>

      <div aria-hidden="true" className="animate-pulse">
        <div className="px-4 pt-3 pb-3">
          <div className="mx-2 h-5 w-44 rounded-xs bg-surface-sunken" />
          <div className="mx-2 mt-2 h-3.5 w-60 rounded-xs bg-surface-sunken" />
        </div>

        <div className="border-t border-border px-4 py-2.5">
          {SKELETON_WIDTHS.map((width, index) => (
            <div
              key={index}
              className="grid h-7 grid-cols-[104px_minmax(0,1fr)] items-center gap-x-2 py-0.5"
            >
              <div className="h-3 w-16 rounded-xs bg-surface-sunken" />
              <div className="mx-2 h-3.5 rounded-xs bg-surface-sunken" style={{ width }} />
            </div>
          ))}
          <div className="mx-2 mt-2.5 h-3 w-64 rounded-xs bg-surface-sunken" />
        </div>

        {['Tags', 'Needs', 'Offers', 'Notizen'].map((title) => (
          <div key={title} className="border-t border-border px-4 py-3">
            <div className="h-3 w-14 rounded-xs bg-surface-sunken" />
            <div className="mt-2.5 h-7 rounded-sm border border-border" />
          </div>
        ))}
      </div>
    </div>
  );
}
