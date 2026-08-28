# Build-Auftrag: Mutuals

Lies zuerst `README.md` im Projektwurzelverzeichnis. Die dort festgehaltenen
Grundsatzentscheidungen sind bindend.

Bau einen funktionierenden Prototypen. Kein Gerüst, keine TODO-Kommentare an
Stellen, die eigentlich Logik enthalten sollten. Am Ende muss ich meinen
LinkedIn-Export importieren, im Interface arbeiten und über Claude auf die
Daten zugreifen können.

Arbeite in den unten definierten Meilensteinen. Nach jedem Meilenstein: kurz
zusammenfassen was läuft, dann weiter. Frag nach, wenn eine Entscheidung
mehrere sinnvolle Wege hat — rate nicht.

---

## Meilenstein 1 — Datenbank

SQLite unter `data/mutuals.db`, angelegt über nummerierte Migrationsdateien in
`db/migrations/`. Ein Script `npm run db:migrate` führt sie in Reihenfolge aus
und merkt sich in einer `_migrations`-Tabelle, was schon gelaufen ist.

### Schema

**contacts**
```
id                INTEGER PRIMARY KEY
name              TEXT NOT NULL
status            TEXT NOT NULL DEFAULT 'imported'   -- imported | active | archived
stage             TEXT NOT NULL DEFAULT 'new'
role              TEXT        -- founder | investor | operator | student | community | other
company           TEXT
title             TEXT        -- Freitext, z.B. "Head of Engineering"
city              TEXT
country           TEXT
email             TEXT
phone             TEXT
linkedin_url      TEXT
birthday          TEXT        -- ISO, Jahr optional -> auch '--03-14' erlaubt
how_we_met        TEXT
closeness         INTEGER     -- 1..5, nullable
source            TEXT NOT NULL DEFAULT 'manual'     -- manual | linkedin | csv
last_contact_at   TEXT
created_at        TEXT NOT NULL
updated_at        TEXT NOT NULL
```

**needs** — was die Person gerade sucht
```
id           INTEGER PRIMARY KEY
contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
text         TEXT NOT NULL
created_at   TEXT NOT NULL
resolved_at  TEXT        -- NULL = offen
```

**offers** — was die Person bieten kann (identische Struktur)

**notes**
```
id           INTEGER PRIMARY KEY
contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
body         TEXT NOT NULL
occurred_on  TEXT        -- Datum des Treffens/Gesprächs, default heute
created_at   TEXT NOT NULL
```

**tags** (`id`, `name` UNIQUE) und **contact_tags** (`contact_id`, `tag_id`,
PK über beide). Tags sind für Themen und Branchen: `healthtech`, `energy`,
`llm-research`, `climate` usw.

**connections** — wer wen kennt, für später schon anlegen
```
id            INTEGER PRIMARY KEY
contact_a_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
contact_b_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
note          TEXT
created_at    TEXT NOT NULL
```
Beim Einfügen immer so normalisieren, dass `contact_a_id < contact_b_id`, und
einen UNIQUE-Index über das Paar setzen. Damit gibt es keine Duplikate.

### Stages

Feste Liste, als Konstante in `lib/constants.ts`:
`new` → `reached_out` → `in_touch` → `close` → `dormant`

### Indizes

Auf `contacts(status)`, `contacts(stage)`, `contacts(name)`,
`contacts(linkedin_url)`, `contacts(email)`, `needs(contact_id)`,
`offers(contact_id)`, `notes(contact_id)`.

Zusätzlich eine FTS5-Volltexttabelle über `contacts.name`, `company`, `title`,
`how_we_met` und die Texte aus `needs`/`offers` — über Trigger aktuell
gehalten. **Notizen gehören nicht in den Volltextindex**, siehe README.

### Datenzugriff

`lib/db.ts` öffnet die Datenbank (Singleton, `better-sqlite3`, WAL-Modus an).
`lib/queries.ts` enthält alle Abfragen als benannte Funktionen mit
TypeScript-Typen. App und MCP-Server nutzen beide ausschließlich diese
Funktionen — kein rohes SQL an anderer Stelle.

---

## Meilenstein 2 — Import

CLI: `npm run import -- <pfad> [--source=linkedin]`
Zusätzlich als Upload im Interface (siehe Meilenstein 3).

Unterstützt `.csv`, `.xlsx`, `.xls`. Ablauf:

1. Datei parsen. **Bei LinkedIn: die ersten drei Zeilen überspringen**, bevor
   die Headerzeile gelesen wird. Erkenne das robust — wenn die erste Zeile
   nicht wie ein Header aussieht, such nach der Zeile, die `First Name`
   enthält.
2. Spalten automatisch auf Felder mappen. Bekannte LinkedIn-Header direkt
   zuordnen (`First Name` + `Last Name` → `name`, `Position` → `title`,
   `URL` → `linkedin_url`, `Connected On` → `created_at`). Bei unbekannten
   Dateien: Mapping-Vorschlag ausgeben und bestätigen lassen.
3. Duplikate prüfen, in dieser Reihenfolge: `linkedin_url`, dann `email`,
   dann normalisierter Name (lowercase, Whitespace kollabiert, Akzente
   entfernt). Treffer werden **ergänzt, nicht überschrieben** — leere Felder
   auffüllen, gefüllte Felder in Ruhe lassen.
4. Alles Importierte bekommt `status = 'imported'`.
5. Zusammenfassung ausgeben: X neu, Y ergänzt, Z übersprungen.

Der Import muss idempotent sein: dieselbe Datei zweimal einlesen darf keine
Duplikate erzeugen.

---

## Meilenstein 3 — Interface

Next.js App Router, Tailwind, shadcn/ui. Läuft lokal über `npm run dev`.

### Gestaltung

Aufgeräumt und dicht, in Richtung Linear oder Attio — **nicht** wie ein
Standard-Dashboard-Template. Konkret:

- Neutrale Graustufen-Palette, genau **eine** Akzentfarbe, sparsam eingesetzt
- Trennung über feine Rahmen (1px), nicht über Schatten und Karten-Stapel
- Inter oder Geist, Textgrößen 13–14px im UI, klare Hierarchie über Gewicht
  statt über Größe
- Großzügiger Weißraum, aber dichte Tabellen — Listen sollen scanbar sein
- Keine Emojis in der UI, keine Farbverläufe, keine dekorativen Icons
- Dark Mode über `prefers-color-scheme`, nicht als Toggle
- Alle Interaktionen ohne Vollseiten-Reload, sichtbarer Ladezustand

### Ansichten

**Liste** (Startseite)
Tabelle mit Name, Rolle, Firma, Stadt, Stage, offene Needs (Anzahl), letzter
Kontakt. Sortierbar. Filterleiste oben: Status, Stage, Rolle, Stadt, Tag,
„hat offene Needs". Suchfeld über FTS, live gefiltert.
Standardfilter beim Laden: `status != 'archived'`.

**Detail** (Slide-over von rechts, kein Seitenwechsel)
Kopf mit Name, Rolle, Firma, Stadt, LinkedIn-Link. Alle Felder inline
editierbar — Klick aufs Feld, Enter speichert, Escape bricht ab. Darunter
drei Blöcke: Needs, Offers, Notizen. Jeweils schnell hinzufügbar über ein
einzeiliges Eingabefeld. Needs und Offers lassen sich per Klick als erledigt
markieren (durchgestrichen, nicht gelöscht). Tags als Chips mit
Autovervollständigung.

**Board**
Kanban nach Stage, Spalten in der Reihenfolge aus `lib/constants.ts`.
Drag & drop verschiebt und speichert sofort. Zeigt nur `status = 'active'`.
Karten kompakt: Name, Firma, oberster offener Need.

**Import**
Datei-Upload mit Drag & Drop, danach Vorschau der ersten zehn Zeilen mit dem
erkannten Spalten-Mapping, änderbar über Dropdowns. Bestätigen startet den
Import, danach die Zusammenfassung aus Meilenstein 2.

### Interaktion

- `Cmd+K` öffnet eine Kommandopalette: Kontakte suchen und direkt öffnen,
  neuen Kontakt anlegen, zwischen Ansichten wechseln
- `N` legt einen neuen Kontakt an (nur Name als Pflichtfeld, Rest später)
- Escape schließt Slide-over und Palette

Ein neu angelegter Kontakt bekommt automatisch `status = 'active'`. Wird ein
importierter Kontakt bearbeitet, wechselt sein Status ebenfalls auf `active`.

---

## Meilenstein 4 — MCP-Server

`mcp/server.ts`, stdio-Transport, `@modelcontextprotocol/sdk`. Greift über
`lib/queries.ts` auf dieselbe Datenbank zu. Build-Script, sodass er sich als
kompiliertes JS starten lässt.

### Tools

| Tool | Zweck |
|---|---|
| `search_contacts` | Volltext + Filter (status, stage, role, city, tag, has_open_needs). Gibt kompakte Treffer zurück, **ohne Notizen** |
| `get_contact` | Ein Kontakt vollständig, inkl. Needs, Offers, Tags — und Notizen nur, wenn `include_notes: true` explizit gesetzt ist |
| `create_contact` | Neu anlegen, alle Felder optional außer `name` |
| `update_contact` | Felder ändern |
| `add_note` | Notiz an Kontakt hängen |
| `add_need` / `add_offer` | Need bzw. Offer anlegen |
| `resolve_need` | Need als erledigt markieren |
| `set_stage` | Stage ändern |
| `find_matches` | Kern-Tool, siehe unten |

### `find_matches`

Nimmt entweder eine `contact_id` oder einen Freitext (`query`). Sucht Kontakte
mit `status = 'active'`, deren offene `offers` zum Need passen — und umgekehrt.
Für den Prototypen reicht Keyword- und Tag-Überlappung über FTS; keine
Embeddings. Gibt maximal zehn Kandidaten zurück, jeweils mit den konkreten
Feldern, auf denen die Überlappung beruht, damit das aufrufende Modell selbst
urteilen kann.

Wichtig: Das Tool liefert Kandidaten, keine Empfehlung. Kein Score, der
Sicherheit vortäuscht, wo keine ist.

Am Ende: die fertige Config für `claude_desktop_config.json` ausgeben, mit dem
korrekten absoluten Pfad.

---

## Qualität

- TypeScript strict, keine `any`
- Alle Schreiboperationen in Transaktionen
- Eingaben serverseitig validieren (zod), nicht nur im Formular
- `data/` und `.env*` in `.gitignore`
- Ein Seed-Script `npm run seed` mit ~20 erfundenen Kontakten inklusive Needs
  und Offers, damit sich das Interface ohne echten Import testen lässt
- Tests nur für Import-Parsing und Dedup-Logik — dort passieren die Fehler.
  Für UI keine Tests.

## Definition of Done

1. `npm run db:migrate && npm run seed && npm run dev` läuft ohne Fehler
2. Ein echter LinkedIn-`Connections.csv` importiert sauber durch, zweimal
   ausgeführt entstehen keine Duplikate
3. Ich kann im Interface einen Kontakt anlegen, Felder editieren, Need und
   Offer hinzufügen, eine Notiz schreiben und ihn im Board verschieben
4. Der MCP-Server startet, Claude Desktop sieht die Tools, und ich kann per
   Chat einen Kontakt anlegen und wiederfinden
5. `README.md` ist um einen Setup-Abschnitt ergänzt: Installation, Migration,
   Import, MCP-Einrichtung

## Reihenfolge

Bau strikt 1 → 2 → 3 → 4. Fang nicht mit dem Interface an. Wenn die Zeit
knapp wird, ist ein vollständiger Meilenstein 1–3 mehr wert als vier halbe.
