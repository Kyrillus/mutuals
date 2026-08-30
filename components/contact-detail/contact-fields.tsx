'use client';

import {
  CONTACT_STATUSES,
  ROLES,
  ROLE_LABELS,
  SOURCE_LABELS,
  STAGES,
  STAGE_LABELS,
  STATUS_LABELS,
  isContactStatus,
  isRole,
  isStage,
} from '@/lib/constants';
import type { ContactStatus, Role } from '@/lib/constants';
import { formatBirthday, formatDate, formatRelative, toDateInputValue } from '@/lib/format';
import type { Contact, ContactPatch } from '@/lib/types';

import { InlineHeading, InlineSelect, InlineText, type SaveResult } from './inline-edit';
import { joinSubtitle } from './detail-model';

/**
 * Kopf und Felder eines Kontakts.
 *
 * Der Kopf traegt den Namen als Ueberschrift, darunter in einer gedaempften
 * Zeile Rolle, Firma und Stadt - das, was man beim Aufschlagen wissen will,
 * bevor man liest. Alles Weitere steht darunter in zwei Spalten aus
 * Beschriftung und Wert.
 *
 * Kein Feld ist ein sichtbares Formularfeld. Was hier steht, ist ein
 * Datensatz; dass er sich anfassen laesst, zeigt der Rahmen beim Ueberfahren
 * und nicht ein Kasten um jeden Wert.
 */

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));
const STAGE_OPTIONS = STAGES.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] }));
const STATUS_OPTIONS = CONTACT_STATUSES.map((status) => ({
  value: status,
  label: STATUS_LABELS[status],
}));

/**
 * Naehe als Zahl mit zwei Ankern statt als Sterne.
 *
 * Sterne behaupten eine Bewertung des Menschen. 1 bis 5 ist eine Angabe
 * darueber, wie gut man sich kennt - und genau so steht es da.
 */
const CLOSENESS_OPTIONS = [
  { value: '1', label: '1 · lose bekannt' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5 · eng' },
];

/** Nur echte Web-Adressen werden verlinkt - href nimmt sonst alles an, auch Skripte. */
function asHttpUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function asRole(value: string | null): Role | null {
  return isRole(value) ? value : null;
}

export interface ContactHeaderProps {
  contact: Contact;
  onPatch: (patch: ContactPatch) => SaveResult;
}

export function ContactHeader({ contact, onPatch }: ContactHeaderProps) {
  const subtitle = joinSubtitle([
    contact.role === null ? null : ROLE_LABELS[contact.role],
    contact.company,
    contact.city,
  ]);
  const profile = asHttpUrl(contact.linkedin_url);

  return (
    <div className="px-4 pt-3 pb-3">
      <InlineHeading
        label="Name"
        value={contact.name}
        onSave={async (next) => {
          if (next === null) {
            return 'Der Name darf nicht leer sein.';
          }
          return onPatch({ name: next });
        }}
      />

      {subtitle === null ? null : (
        <p className="truncate px-2 pt-0.5 text-base text-muted">{subtitle}</p>
      )}

      {profile === null ? null : (
        <p className="px-2 pt-1">
          <a
            href={profile}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xs text-sm text-accent underline-offset-2 hover:underline"
          >
            LinkedIn-Profil
          </a>
        </p>
      )}
    </div>
  );
}

export interface ContactFieldsProps {
  contact: Contact;
  onPatch: (patch: ContactPatch) => SaveResult;
  /**
   * Der Status laeuft ueber einen eigenen Weg und nicht ueber den Patch: ein
   * bearbeiteter importierter Kontakt wird sonst nebenbei auf 'active'
   * gezogen, und dann liesse sich ein Kontakt gar nicht mehr auf 'importiert'
   * zuruecksetzen. setStatus sagt ausdruecklich, was gelten soll.
   */
  onStatus: (status: ContactStatus) => SaveResult;
}

export function ContactFields({ contact, onPatch, onStatus }: ContactFieldsProps) {
  /**
   * Der letzte Kontakt als Kalendertag - und ausdruecklich null, wenn keiner
   * hinterlegt ist. toDateInputValue liefert fuer "nichts" einen leeren
   * String, und der ist fuer das Feld ein Wert: es wuerde ihn formatieren
   * ("— · noch nie") statt den Ersatztext zu zeigen.
   */
  const lastContactDay = toDateInputValue(contact.last_contact_at);

  return (
    <div className="border-t border-border px-4 py-2.5">
      <InlineSelect
        label="Rolle"
        value={contact.role}
        options={ROLE_OPTIONS}
        emptyLabel="Keine Rolle"
        placeholder="Keine Rolle"
        onSave={(next) => onPatch({ role: asRole(next) })}
      />

      <InlineText
        label="Firma"
        value={contact.company}
        placeholder="Keine Firma"
        onSave={(next) => onPatch({ company: next })}
      />

      <InlineText
        label="Position"
        value={contact.title}
        placeholder="Keine Position"
        onSave={(next) => onPatch({ title: next })}
      />

      <InlineText
        label="Stadt"
        value={contact.city}
        placeholder="Keine Stadt"
        onSave={(next) => onPatch({ city: next })}
      />

      <InlineText
        label="Land"
        value={contact.country}
        placeholder="Kein Land"
        onSave={(next) => onPatch({ country: next })}
      />

      <InlineText
        label="E-Mail"
        type="email"
        value={contact.email}
        placeholder="Keine E-Mail-Adresse"
        onSave={(next) => onPatch({ email: next })}
      />

      <InlineText
        label="Telefon"
        type="tel"
        value={contact.phone}
        placeholder="Keine Telefonnummer"
        onSave={(next) => onPatch({ phone: next })}
      />

      <InlineText
        label="LinkedIn"
        type="url"
        value={contact.linkedin_url}
        placeholder="Kein Profil hinterlegt"
        onSave={(next) => onPatch({ linkedin_url: next })}
      />

      <InlineText
        label="Geburtstag"
        value={contact.birthday}
        placeholder="Kein Geburtstag"
        hint="JJJJ-MM-TT, oder --MM-TT ohne Jahrgang"
        format={(value) => formatBirthday(value)}
        onSave={(next) => onPatch({ birthday: next })}
      />

      <InlineText
        label="Kennengelernt"
        value={contact.how_we_met}
        placeholder="Nicht festgehalten"
        multiline
        hint="Absatz mit Enter, speichern mit Cmd/Strg+Enter"
        onSave={(next) => onPatch({ how_we_met: next })}
      />

      <InlineSelect
        label="Naehe"
        value={contact.closeness === null ? null : String(contact.closeness)}
        options={CLOSENESS_OPTIONS}
        emptyLabel="Nicht eingeschaetzt"
        placeholder="Nicht eingeschaetzt"
        onSave={async (next) => {
          if (next === null) {
            return onPatch({ closeness: null });
          }
          const value = Number(next);
          return Number.isInteger(value) && value >= 1 && value <= 5
            ? onPatch({ closeness: value })
            : 'Die Naehe liegt zwischen 1 und 5.';
        }}
      />

      <InlineSelect
        label="Phase"
        value={contact.stage}
        options={STAGE_OPTIONS}
        placeholder="Keine Phase"
        onSave={async (next) =>
          isStage(next) ? onPatch({ stage: next }) : 'Diese Phase gibt es nicht.'
        }
      />

      <InlineSelect
        label="Status"
        value={contact.status}
        options={STATUS_OPTIONS}
        placeholder="Kein Status"
        onSave={async (next) =>
          isContactStatus(next) ? onStatus(next) : 'Diesen Status gibt es nicht.'
        }
      />

      <InlineText
        label="Letzter Kontakt"
        type="date"
        // Der Rohwert kann ein Zeitstempel sein; das Datumsfeld nimmt nur den
        // Kalendertag an, und genau der ist hier auch gemeint.
        value={lastContactDay === '' ? null : lastContactDay}
        placeholder="Noch nie"
        format={(value) => `${formatDate(value)} · ${formatRelative(value)}`}
        onSave={(next) => onPatch({ last_contact_at: next })}
      />

      <p className="px-2 pt-2.5 text-sm text-faint">
        Quelle: {SOURCE_LABELS[contact.source]} · angelegt am {formatDate(contact.created_at)} ·
        geaendert {formatRelative(contact.updated_at)}
      </p>
    </div>
  );
}
