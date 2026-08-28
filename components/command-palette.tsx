/**
 * PLATZHALTER - wird durch die echte Kommandopalette ersetzt.
 *
 * app/layout.tsx rendert <CommandPalette /> einmal am Ende des Body, damit die
 * Palette auf jeder Seite verfuegbar ist. Bis sie gebaut ist, rendert sie
 * nichts.
 *
 * Erwartete Verdrahtung der echten Fassung:
 *   - 'use client' oben.
 *   - Auf das Fensterereignis COMMAND_PALETTE_EVENT aus '@/lib/ui-events'
 *     hoeren; der Hinweis in der Kopfzeile (components/app-nav.tsx) sendet es
 *     beim Klick. Zusaetzlich das Tastenkuerzel Cmd/Strg+K selbst abfangen.
 *   - Fuer die Huelle den <Dialog> aus '@/components/ui' benutzen
 *     (width="md", flush, ariaLabel="Suche"); Fokusfalle, Escape und
 *     Fokusrueckgabe sind dort erledigt.
 *   - Daten ueber die Server Actions aus '@/app/actions' holen, nicht ueber
 *     lib/queries.ts - die Palette laeuft im Browser.
 */
export function CommandPalette() {
  return null;
}
