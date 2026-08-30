# Migrationen

Nummerierte `.sql`-Dateien, ausgeführt von `scripts/migrate.ts`
(`npm run db:migrate`). Reihenfolge über das numerische Präfix, jede Nummer
darf nur einmal vergeben werden. Was gelaufen ist, steht in der Tabelle
`_migrations` — mit `applied_at` und einer SHA-256-Prüfsumme des Dateiinhalts.

## Regeln

**Angewendete Dateien nicht mehr ändern.** Der Runner vergleicht bei jedem Lauf
die Prüfsumme und warnt bei Abweichung. Er bricht dabei nicht ab (ein
umformatierter Kommentar soll kein Deployment blockieren), aber die Warnung
bedeutet: bestehende Datenbanken haben den alten Stand, frisch migrierte den
neuen. Änderungen gehören in eine neue Datei.

**Keine Transaktionssteuerung im SQL.** Der Runner klammert jede Datei in eine
Transaktion — außer im unten beschriebenen Sonderfall.

## Sonderfall: Tabellenumbau (`-- migrate: no-transaction`)

SQLite kann CHECK-Constraints nicht per `ALTER TABLE` ändern. `contacts` trägt
fünf davon (`status`, `stage`, `role`, `source`, `closeness`), also erzwingt
jeder neue Stage- oder Role-Wert den Tabellenumbau nach dem offiziellen
[12-Schritte-Verfahren](https://sqlite.org/lang_altertable.html#otherlang).

Schritt 1 dieses Verfahrens ist `PRAGMA foreign_keys = OFF` — und dieses PRAGMA
ist innerhalb einer offenen Transaktion ein **stiller No-Op**. Eine solche
Migration lässt sich in der normalen Klammer deshalb nicht ausführen. Sie
steigt über eine Marker-Zeile in ihrem Kopf aus:

```sql
-- migrate: no-transaction
-- 004_beispiel_stage_erweitern.sql
```

Die Marker-Zeile muss im Kopf der Datei stehen, also vor der ersten Zeile mit
echtem SQL. Der Runner setzt dann `PRAGMA foreign_keys = OFF` davor, führt die
Datei ohne Klammer aus, prüft danach `PRAGMA foreign_key_check` und schaltet
die Fremdschlüssel wieder ein. **Die Datei ist selbst für ihre Atomarität
zuständig** — sie sollte ihr eigenes `BEGIN`/`COMMIT` mitbringen.

### Dabei nicht vergessen: die FTS-Trigger

`001_initial_schema.sql` legt neun Trigger an (`contacts_ai/au/ad`,
`needs_ai/au/ad`, `offers_ai/au/ad`), die `contacts_fts` aktuell halten. Sie
verweisen namentlich auf `contacts`, `needs` und `offers`.

Beim Umbau einer dieser drei Tabellen laufen sie gegen die Zieltabelle, die
während des Umbaus noch nicht existiert — der Lauf bricht mit
`no such table: main.contacts` ab. Ein Tabellenumbau muss deshalb:

1. die betroffenen Trigger droppen,
2. die Tabelle umbauen (neue Tabelle, `INSERT INTO ... SELECT`, alte löschen,
   neue umbenennen, Indizes neu anlegen),
3. die Trigger wortgleich wieder anlegen,
4. die FTS-Zeilen der umgebauten Tabelle neu aufbauen, falls sich am Inhalt
   der indizierten Spalten etwas geändert hat.

Der Wiederaufbau einer FTS-Zeile folgt immer demselben Muster — erst `DELETE`,
dann `INSERT ... SELECT`, siehe die Trigger in `001_initial_schema.sql`.
