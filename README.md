# Mutuals

Ein persönliches CRM für Menschen — kein Sales-CRM. Gebaut für den eigenen
Gebrauch, um das eigene Netzwerk so zu strukturieren, dass sich Leute
sinnvoll miteinander verbinden lassen.

## Warum

Klassische Personal CRMs (Dex, Monica, Clay/Mesh) sind ego-zentrisch: „finde
mir jemanden für mich". Der eigentliche Wert liegt aber in der Broker-Rolle:
zwei Personen aus dem eigenen Netzwerk zusammenbringen, ohne selbst Teil der
Transaktion zu sein.

Beispiel: Ich lerne einen Founder kennen, der eine Seed-Runde in HealthTech
raist. Paul (Investor, München, HealthTech, Tickets 100–500k) ist seit Monaten
in meiner Datenbank. Das Match ist trivial — aber kein Tool macht es, weil in
keinem Tool die Felder existieren, aus denen es sich ableiten ließe.

Genau diese Felder sind der Kern dieses Projekts:
`needs` (was sucht die Person gerade) und `offers` (was kann sie bieten).
Alles andere ist Infrastruktur drumherum.

## Nutzung

Rein privat. Ich selbst, später vielleicht ein paar Freunde. Kein
kommerzielles Produkt, kein Multi-Tenant, keine Nutzerverwaltung.

## Grundsatzentscheidungen

Diese Punkte sind bewusst so entschieden und sollen nicht „verbessert" werden:

**SQLite, lokal.** Eine Datei auf dem Rechner. Kein Server, kein Cloud-Anbieter,
kein Hosting. Backup = Datei kopieren. Bei ein paar tausend Kontakten ist das
für immer ausreichend.

**Eine Kontakt-Tabelle, kein Split.** LinkedIn-Import und selbst gepflegte
Kontakte landen in derselben Tabelle, unterschieden über `status`
(`imported` / `active` / `archived`). Beim Matching wird auf `active`
gefiltert, bei der Suche alles durchsucht.

**Jeder Kontakt hat eine numerische ID.** Namen sind nicht eindeutig und
ändern sich. IDs sind intern, im UI und im Gespräch mit Claude tauchen sie
nicht auf.

**`needs` und `offers` sind eigene Tabellen, keine Textfelder.** Sie haben
Zeitstempel und lassen sich als erledigt markieren. Ein Need von vor zwei
Jahren ist wertlos, und das muss das Schema abbilden können.


## Stack

- Next.js (App Router) + TypeScript
- SQLite über `better-sqlite3`, Migrationen über einfache SQL-Dateien
- Tailwind + shadcn/ui
- MCP-Server (stdio) im selben Repo, greift auf dieselbe SQLite-Datei zu

## Struktur

```
mutuals/
  data/mutuals.db        # die Datenbank (gitignored)
  db/migrations/         # nummerierte .sql-Dateien
  app/                   # Next.js
  lib/db.ts              # DB-Zugriff, von App und MCP genutzt
  lib/queries.ts         # alle SQL-Abfragen an einem Ort
  mcp/server.ts          # MCP-Server
  scripts/import.ts      # CSV/XLSX-Import via CLI
```

## Setup

Voraussetzung ist **Node 22 oder neuer** — Next selbst käme mit 20.9 aus, aber
`better-sqlite3` ist ein natives Modul und verlangt 22. Entwickelt und geprüft
wurde mit Node 24 LTS.

```
npm install
npm run db:migrate
npm run dev
```

Die App läuft dann auf http://localhost:3000. `npm run db:migrate` legt
`data/mutuals.db` an, falls die Datei fehlt, und spielt alle noch nicht
angewandten Migrationen ein; ein zweiter Lauf tut nichts.

`npm run seed` legt 21 erfundene Kontakte mit Needs, Offers, Tags und Notizen
an, damit sich die Oberfläche ohne echten Import ansehen lässt — darunter drei
Paare, an denen sich das Verkuppeln zeigen lässt. Das Skript ist idempotent und
additiv; es lässt sich also auch auf eine bereits gefüllte Datenbank anwenden
und mit `--reset` wieder zurücknehmen.

Weitere Befehle:

```
npm test        # Tests zu Import-Parsing und Dublettenlogik
npm run build   # Produktionsbuild
npm run mcp:build   # kompiliert den MCP-Server nach mcp/dist/
```

Die Datenbank lässt sich über die Umgebungsvariable `MUTUALS_DB_PATH` umlenken.
Das ist der Weg, etwas auszuprobieren, ohne den echten Bestand anzufassen:

```
MUTUALS_DB_PATH=/tmp/test.db npm run db:migrate
MUTUALS_DB_PATH=/tmp/test.db npm run seed
```

**Backup ist Dateikopie.** `data/mutuals.db` ist die gesamte Datenbank; sie
liegt nicht im Repo. Vor größeren Eingriffen lohnt sich `cp data/mutuals.db
data/mutuals.db.backup`. Läuft die App gerade, gehören die Dateien
`mutuals.db-wal` und `mutuals.db-shm` dazu.

## MCP-Einrichtung

Damit Claude auf die Kontakte zugreifen kann, muss der Server einmal kompiliert
werden:

```
npm run mcp:build
```

Danach in `claude_desktop_config.json` eintragen (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mutuals": {
      "command": "node",
      "args": ["/Users/simonfuhrbach/code/crm/mcp/dist/server.js"]
    }
  }
}
```

Der Pfad muss absolut sein. Ein `cwd` ist nicht nötig: der Server sucht die
Projektwurzel selbst und findet `data/mutuals.db` auch, wenn Claude Desktop ihn
ohne sinnvolles Arbeitsverzeichnis startet. Liegt die Datenbank woanders, lässt
sich das über einen `env`-Block in derselben Konfiguration überschreiben:

```json
"env": { "MUTUALS_DB_PATH": "/pfad/zur/mutuals.db" }
```

Nach dem Eintragen Claude Desktop neu starten. Der Server meldet beim Start auf
stderr, welche Datenbank er benutzt und wie viele Kontakte darin stehen; diese
Zeilen stehen im Log von Claude Desktop. Fehlt das Schema, sagt die Meldung das
ausdrücklich und nennt den Befehl zum Migrieren — ein Tippfehler im Pfad ist
sonst nicht davon zu unterscheiden, weil SQLite eine unbekannte Datei
stillschweigend als leere Datenbank anlegt.

### Werkzeuge

| Werkzeug | Zweck |
|---|---|
| `search_contacts` | Volltext und Filter, kompakte Treffer. Zum Nachschlagen einer Person. |
| `get_contact` | Ein Kontakt vollständig, inklusive Needs, Offers und Tags. |
| `create_contact` / `update_contact` | Anlegen und ändern. |
| `add_note` | Notiz anhängen. |
| `add_need` / `add_offer` | Was jemand sucht bzw. bieten kann. |
| `resolve_need` | Need als erledigt markieren, nicht löschen. |
| `set_stage` | Phase ändern. |
| `find_matches` | Das Kernwerkzeug: wer aus dem Netzwerk passt zu wem. |

**Notizen sind die private Schicht.** Sie stehen nicht im Volltextindex,
tauchen in keinem Suchergebnis auf und kommen über `get_contact` nur zurück,
wenn `include_notes: true` ausdrücklich gesetzt ist. Claude sieht sie also nicht
beiläufig beim Stöbern, sondern nur, wenn danach gefragt wird.

**`find_matches` liefert Kandidaten, keine Empfehlung.** Es gibt bewusst keinen
Score: die Überlappung ist schlichter Stichwort- und Tag-Abgleich, und eine Zahl
würde eine Sicherheit behaupten, die dahinter nicht steht. Jeder Kandidat kommt
mit den konkreten Feldern, auf denen die Überlappung beruht — das Urteil bildet
sich daran, nicht an einer Rangziffer.

## Kontext zum LinkedIn-Export

Der Export kommt als `Connections.csv` und hat **drei Zeilen Präambel**
("Notes:" usw.) vor der eigentlichen Headerzeile. Die muss beim Parsen
übersprungen werden, sonst schlägt der Import fehl.

Spalten: `First Name`, `Last Name`, `URL`, `Email Address`, `Company`,
`Position`, `Connected On`. E-Mail ist bei den allermeisten Kontakten leer —
LinkedIn liefert sie nur, wenn die Person das freigegeben hat. Der Import
liefert also ein Skelett, keine fertige Datenbasis.

## Import

```
npm run import -- <pfad> [--source=linkedin] [--sheet=<name|nr>] [--dry-run] [--yes]
```

Unterstützt `.csv`, `.xlsx` und `.xls`. Die Kopfzeile wird gesucht, nicht
abgezählt; bei unbekannten Dateien zeigt die CLI den Mapping-Vorschlag samt
Vorschau und fragt nach (`--yes` überspringt die Rückfrage, `--dry-run`
rechnet alles durch, ohne zu schreiben).

Rückgabewert 0, wenn der Lauf etwas importiert oder als bereits vorhanden
erkannt hat, sonst 1 — ein Lauf, der gar nichts erreicht (Artikelliste statt
Kontaktliste), ist im Cron-Betrieb damit vom Erfolg zu unterscheiden.

**Ergänzen, nicht überschreiben.** Bei einer Dublette füllt der Import nur
Felder, die leer sind. Gepflegte Werte bleiben stehen, der Status bleibt
unangetastet.

**Ein bewusst geleertes Feld gilt als leer.** Wer einen falschen Wert löscht,
bekommt ihn beim nächsten Import derselben Datei wieder eingetragen, und zwar
bei jedem Lauf erneut. Eine *geänderte* Angabe gewinnt dauerhaft gegen den
Import, eine *gelöschte* nicht. Wer einen Wert endgültig loswerden will, muss
die Quellzeile korrigieren.

**Dubletten in drei Stufen:** Profil-URL, dann E-Mail, dann normalisierter
Name. Die Namensstufe ist die schwächste — zwei Menschen können denselben
Namen tragen. Deshalb zwei Sicherungen: Ein Treffer wird verworfen, wenn beide
Seiten eine belastbare, aber verschiedene URL bzw. E-Mail tragen (dann sind es
nachweislich zwei Personen), und bei einem reinen Namenstreffer schreibt der
Import weder E-Mail noch Profil-URL. Solche Zeilen listet die Zusammenfassung
einzeln zum Nachsehen auf.

**Was nicht geraten wird:** mehrdeutige Datumsformate (`03/14/2023`),
zweistellige Jahre und Platzhalter in der E-Mail-Spalte (`n/a`, `-`). Diese
Werte werden verworfen *und in der Zusammenfassung gemeldet*, mit einem
Beispiel aus der Datei.

Der Import ist idempotent: dieselbe Datei zweimal einzulesen erzeugt keine
Dubletten. Die gesamte Logik liegt in `lib/import/` und hängt nicht am
Dateisystem (`parseBuffer` + `importParsedFile`), damit der Upload im
Interface denselben Weg nimmt wie die CLI.
