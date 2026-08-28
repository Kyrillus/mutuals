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

## Kontext zum LinkedIn-Export

Der Export kommt als `Connections.csv` und hat **drei Zeilen Präambel**
("Notes:" usw.) vor der eigentlichen Headerzeile. Die muss beim Parsen
übersprungen werden, sonst schlägt der Import fehl.

Spalten: `First Name`, `Last Name`, `URL`, `Email Address`, `Company`,
`Position`, `Connected On`. E-Mail ist bei den allermeisten Kontakten leer —
LinkedIn liefert sie nur, wenn die Person das freigegeben hat. Der Import
liefert also ein Skelett, keine fertige Datenbasis.
