'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { createContactAction } from '@/app/actions';
import { Button, Dialog, Field, InlineError, Input } from '@/components/ui';

/**
 * Der Dialog hinter dem Kuerzel "N": ein Feld, ein Knopf.
 *
 * Genau ein Pflichtfeld, weil der Moment, in dem man einen Kontakt anlegt,
 * meistens ein Zuruf ist ("schreib dir Anna Weber auf"). Alles Weitere -
 * Firma, Stadt, Needs - steht danach im Slide-over, das sich von selbst
 * oeffnet; ein Formular mit vierzehn Feldern haette hier nur den Zuruf
 * ausgebremst.
 *
 * Der Knopf liegt im Fuss des Dialogs und damit ausserhalb des Formulars.
 * Verbunden sind beide ueber das form-Attribut - so speichert die
 * Eingabetaste im Feld und der Klick auf "Anlegen" ueber denselben Weg.
 */
export interface NewContactDialogProps {
  open: boolean;
  onClose: () => void;
  /** Der Kontakt steht in der Datenbank; die Palette oeffnet ihn danach. */
  onCreated: (id: number) => void;
}

export function NewContactDialog({ open, onClose, onCreated }: NewContactDialogProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Sperrt das Absenden synchron, siehe submit(). */
  const submitting = useRef(false);
  const formId = useId();
  const fieldId = `${formId}-name`;

  /**
   * Jedes Oeffnen faengt leer an. Der Fokus wird hier gesetzt und nicht ueber
   * autoFocus, weil der Dialog beim Oeffnen zuerst seinem Panel den Fokus
   * gibt - dieser Effekt laeuft danach.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    setName('');
    setError(null);
    setPending(false);
    submitting.current = false;
    inputRef.current?.focus();
  }, [open]);

  const trimmed = name.trim();

  async function submit(): Promise<void> {
    // Die Sperre haengt an einer Referenz, nicht an pending: setPending wirkt
    // erst beim naechsten Rendern. Zwei Ausloeser im selben Zyklus - gedrueckt
    // gehaltene Eingabetaste, Doppelklick auf "Anlegen" - saehen beide noch
    // pending === false und legten den Kontakt zweimal an. pending bleibt
    // daneben bestehen, weil es die Beschriftung und den gesperrten Knopf
    // steuert; die Referenz entscheidet, die Zustandsvariable zeigt an.
    if (trimmed === '' || submitting.current) {
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await createContactAction({ name: trimmed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated(result.data.id);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Neuer Kontakt"
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={pending}
            disabled={trimmed === ''}
          >
            Anlegen
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Name"
          htmlFor={fieldId}
          required
          hint="Firma, Stadt und alles Weitere danach im Slide-over."
        >
          <Input
            ref={inputRef}
            id={fieldId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') {
                return;
              }
              /**
               * Die Eingabetaste sendet ausdruecklich ab, statt es dem
               * Browser zu ueberlassen. Dessen implizite Absendung findet den
               * Absende-Knopf nur ueber das form-Attribut, weil der Knopf im
               * Fuss des Dialogs steht - eine Feinheit, von der die
               * Hauptbedienung dieses Dialogs nicht abhaengen soll.
               *
               * preventDefault verhindert, dass beide Wege zugleich greifen;
               * gerechnet wird weiterhin nur an einer Stelle, im submit des
               * Formulars.
               */
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            aria-invalid={error !== null}
            autoComplete="off"
            placeholder="Vor- und Nachname"
          />
        </Field>
        <InlineError className="mt-2">{error}</InlineError>
      </form>
    </Dialog>
  );
}
