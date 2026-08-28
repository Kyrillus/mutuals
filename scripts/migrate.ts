import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_PATH, closeDb, getDb, nowIso, withTransaction } from '../lib/db';

/**
 * Migrationsrunner: führt die nummerierten .sql-Dateien aus db/migrations
 * der Reihe nach aus und merkt sich in der Tabelle _migrations, was schon
 * gelaufen ist. Idempotent - ein zweiter Lauf wendet nichts erneut an.
 *
 * Aufruf: npm run db:migrate
 *
 * Zwei Dinge, die man beim Schreiben einer Migration wissen muss:
 *
 *   1. Normalerweise klammert der Runner jede Datei in eine Transaktion. Eine
 *      Datei, die den Tabellenumbau nach dem 12-Schritte-Verfahren von SQLite
 *      braucht, stellt stattdessen die Marker-Zeile
 *          -- migrate: no-transaction
 *      in ihren Kopf. Sie laeuft dann ohne Klammer, dafuer mit
 *      PRAGMA foreign_keys = OFF davor - innerhalb einer offenen Transaktion
 *      waere dieses PRAGMA ein stiller No-Op.
 *   2. Der Inhalt jeder angewendeten Datei wird als SHA-256 mitgeschrieben.
 *      Aendert sich eine bereits angewendete Datei nachtraeglich, warnt der
 *      naechste Lauf. Er bricht dafuer nicht ab: ein umformatierter Kommentar
 *      soll kein Deployment blockieren.
 *
 * Details zum Tabellenumbau stehen in db/migrations/README.md.
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'db', 'migrations');

/** Marker-Zeile, mit der eine Datei aus der Transaktionsklammer aussteigt. */
const NO_TRANSACTION_MARKER = /^--\s*migrate:\s*no-transaction\s*$/i;

interface MigrationFile {
  readonly name: string;
  readonly fullPath: string;
  readonly order: number;
  readonly sql: string;
  readonly checksum: string;
  /** false, wenn die Datei die no-transaction-Marker-Zeile traegt. */
  readonly useTransaction: boolean;
}

class MigrationError extends Error {}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Sucht die Marker-Zeile im Kopf der Datei - also in allem, was vor der ersten
 * Zeile mit echtem SQL steht. Weiter unten wird bewusst nicht gesucht, damit
 * ein Kommentar mitten im SQL nicht versehentlich die Semantik der ganzen
 * Datei umschaltet.
 */
function readsAsNoTransaction(sql: string): boolean {
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    if (!line.startsWith('--')) {
      return false;
    }
    if (NO_TRANSACTION_MARKER.test(line)) {
      return true;
    }
  }
  return false;
}

/** Liest die Migrationsdateien und sortiert sie nach ihrem numerischen Präfix. */
function collectMigrations(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) {
    throw new MigrationError(`Das Verzeichnis ${dir} existiert nicht.`);
  }

  const names = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort();

  const migrations: MigrationFile[] = [];
  const seenOrders = new Map<number, string>();

  for (const name of names) {
    const match = /^(\d+)[_-]/.exec(name);
    if (match === null) {
      throw new MigrationError(
        `Die Datei ${name} hat kein numerisches Präfix. ` +
          'Erwartet wird das Schema 001_name.sql.',
      );
    }

    const prefix = match[1];
    if (prefix === undefined) {
      throw new MigrationError(`Das Präfix von ${name} ließ sich nicht lesen.`);
    }

    const order = Number.parseInt(prefix, 10);
    const duplicate = seenOrders.get(order);
    if (duplicate !== undefined) {
      throw new MigrationError(
        `Die Nummer ${prefix} wird zweimal benutzt: ${duplicate} und ${name}. ` +
          'Die Reihenfolge wäre nicht eindeutig.',
      );
    }
    seenOrders.set(order, name);

    const fullPath = path.join(dir, name);
    const sql = fs.readFileSync(fullPath, 'utf8');
    migrations.push({
      name,
      fullPath,
      order,
      sql,
      checksum: sha256(sql),
      useTransaction: !readsAsNoTransaction(sql),
    });
  }

  migrations.sort((a, b) => (a.order === b.order ? a.name.localeCompare(b.name) : a.order - b.order));
  return migrations;
}

function ensureMigrationsTable(): void {
  const db = getDb();
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (' +
      'name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT)',
  );

  // Datenbanken, die vor der Einfuehrung der Spalte migriert wurden, bekommen
  // sie hier nachgezogen. NULL heisst dort "Pruefsumme unbekannt".
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('_migrations');
  const hasChecksum = columns.some(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      (row as Record<string, unknown>)['name'] === 'checksum',
  );
  if (!hasChecksum) {
    db.exec('ALTER TABLE _migrations ADD COLUMN checksum TEXT');
  }
}

/** Angewendete Migrationen mit ihrer Pruefsumme (null = vor der Spalte eingetragen). */
function readAppliedMigrations(): Map<string, string | null> {
  const rows = getDb().prepare('SELECT name, checksum FROM _migrations').all();
  const applied = new Map<string, string | null>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const name: unknown = record['name'];
    if (typeof name !== 'string') {
      continue;
    }
    const checksum: unknown = record['checksum'];
    applied.set(name, typeof checksum === 'string' ? checksum : null);
  }
  return applied;
}

function recordMigration(migration: MigrationFile): void {
  getDb()
    .prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)')
    .run(migration.name, nowIso(), migration.checksum);
}

/**
 * Wendet eine Datei an und trägt sie ein.
 *
 * Standardfall: beides in einer Transaktion, ein Fehler rollt die ganze Datei
 * zurück.
 *
 * Sonderfall no-transaction: die Datei läuft ohne Klammer, dafür mit
 * abgeschalteten Fremdschlüsseln - das braucht das 12-Schritte-Verfahren zum
 * Tabellenumbau, und PRAGMA foreign_keys wirkt innerhalb einer offenen
 * Transaktion nicht. Die Datei ist dann selbst für ihre Atomarität zuständig.
 * Vor dem Eintrag prüft der Runner die Fremdschlüssel nach: findet er eine
 * verletzte Beziehung, gilt die Migration als fehlgeschlagen.
 */
function applyMigration(migration: MigrationFile): void {
  const db = getDb();

  if (migration.useTransaction) {
    withTransaction(() => {
      db.exec(migration.sql);
      recordMigration(migration);
    });
    return;
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(migration.sql);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new MigrationError(
        `Nach dem Lauf verletzen ${violations.length} Zeile(n) eine Fremdschlüsselbeziehung. ` +
          'Die Datei läuft ohne Transaktionsklammer, es wurde also nichts zurückgerollt.',
      );
    }

    withTransaction(() => {
      recordMigration(migration);
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function main(): void {
  console.log(`Datenbank:   ${DB_PATH}`);
  console.log(`Migrationen: ${MIGRATIONS_DIR}`);
  console.log('');

  const migrations = collectMigrations(MIGRATIONS_DIR);
  if (migrations.length === 0) {
    console.log('Keine Migrationsdateien gefunden, nichts zu tun.');
    return;
  }

  ensureMigrationsTable();
  const applied = readAppliedMigrations();

  const known = new Set(migrations.map((migration) => migration.name));
  for (const name of applied.keys()) {
    if (!known.has(name)) {
      console.log(
        `Warnung: ${name} ist als angewendet eingetragen, die Datei fehlt aber im Verzeichnis.`,
      );
    }
  }

  const width = Math.max(...migrations.map((migration) => migration.name.length));
  let appliedCount = 0;
  let skippedCount = 0;
  let driftCount = 0;

  for (const migration of migrations) {
    const label = migration.name.padEnd(width, ' ');

    if (applied.has(migration.name)) {
      console.log(`  ${label}  übersprungen (bereits angewendet)`);
      skippedCount += 1;

      // Inhaltliche Drift: die Datei wurde nach dem Anwenden geändert. Diese
      // Datenbank hat das alte Schema, eine frisch migrierte bekäme das neue.
      const recorded = applied.get(migration.name) ?? null;
      if (recorded !== null && recorded !== migration.checksum) {
        console.log(
          `  ${' '.repeat(width)}  WARNUNG: Der Inhalt von ${migration.name} hat sich seit dem ` +
            'Anwenden geändert.',
        );
        console.log(
          `  ${' '.repeat(width)}           eingetragen ${recorded.slice(0, 12)}, ` +
            `Datei jetzt ${migration.checksum.slice(0, 12)}.`,
        );
        console.log(
          `  ${' '.repeat(width)}           Diese Datenbank hat den alten Stand. Änderungen ` +
            'gehören in eine neue Migration.',
        );
        driftCount += 1;
      }
      continue;
    }

    try {
      applyMigration(migration);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        `Die Migration ${migration.name} ist fehlgeschlagen: ${reason}\n` +
          'Aus dieser Datei wurde nichts angewendet, die Transaktion wurde zurückgerollt.',
      );
    }

    console.log(`  ${label}  angewendet${migration.useTransaction ? '' : ' (ohne Transaktion)'}`);
    appliedCount += 1;
  }

  const dateien = migrations.length === 1 ? '1 Datei' : `${migrations.length} Dateien`;
  console.log('');
  console.log(
    `Zusammenfassung: ${appliedCount} angewendet, ${skippedCount} übersprungen, ` +
      `${dateien} insgesamt.`,
  );
  if (driftCount > 0) {
    console.log(
      `${driftCount} bereits angewendete Datei(en) haben sich seit dem Anwenden geändert - ` +
        'siehe die Warnungen oben.',
    );
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('');
  console.error(`Fehler: ${message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
