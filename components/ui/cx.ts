/**
 * Klassennamen zusammensetzen.
 *
 * Bewusst kein clsx/tailwind-merge: die Primitive hier setzen ihre Klassen in
 * fester Reihenfolge und haengen die von aussen gereichte className immer ganz
 * hinten an. Bei gleicher Spezifitaet gewinnt in CSS die zuletzt DEFINIERTE
 * Regel, nicht die zuletzt genannte Klasse - wer eine Grundklasse wirklich
 * ueberschreiben muss, nimmt deshalb eine Utility mit hoeherer Spezifitaet
 * (z.B. eine Variante wie hover:) oder das passende Prop. Das kommt selten vor
 * und ist billiger als eine weitere Abhaengigkeit.
 */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
