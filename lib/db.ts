import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { normalizeText } from './text';

/**
 * Zentraler Datenbankzugriff für Mutuals.
 *
 * Die Datei liegt unter <projektwurzel>/data/mutuals.db. Der Pfad wird bewusst
 * NICHT über process.cwd() bestimmt, weil derselbe Code später vom
 * MCP-Server aus einem beliebigen Arbeitsverzeichnis gestartet wird.
 * Überschreibbar über die Umgebungsvariable MUTUALS_DB_PATH (für Tests).
 */

const PACKAGE_NAME = 'mutuals';
const DB_DIR_NAME = 'data';
const DB_FILE_NAME = 'mutuals.db';

/** Verzeichnis dieses Moduls, sofern es sich ESM-tauglich auflösen lässt. */
function moduleDir(): string | null {
  try {
    const url: string = import.meta.url;
    if (!url.startsWith('file:')) {
      return null;
    }
    return path.dirname(fileURLToPath(url));
  } catch {
    return null;
  }
}

/** Liest das Feld "name" aus einer package.json, ohne bei kaputtem JSON zu werfen. */
function readPackageName(packageJsonPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(packageJsonPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const name: unknown = (parsed as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : null;
}

/** Sucht aufwärts nach dem Verzeichnis mit der package.json des Projekts. */
function findProjectRootFrom(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (readPackageName(path.join(dir, 'package.json')) === PACKAGE_NAME) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Projektwurzel: erst vom Modulpfad aus aufwärts suchen (funktioniert auch,
 * wenn der Code aus mcp/dist oder .next/server heraus läuft), sonst vom
 * Arbeitsverzeichnis aus.
 */
function resolveProjectRoot(): string {
  const fromModule = moduleDir();
  if (fromModule !== null) {
    const root = findProjectRootFrom(fromModule);
    if (root !== null) {
      return root;
    }
  }

  const fromCwd = findProjectRootFrom(process.cwd());
  if (fromCwd !== null) {
    return fromCwd;
  }

  // Letzter Ausweg: lib/db.ts liegt eine Ebene unter der Projektwurzel.
  if (fromModule !== null) {
    return path.dirname(fromModule);
  }
  return process.cwd();
}

function resolveDbPath(): string {
  const override = process.env['MUTUALS_DB_PATH'];
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  return path.join(resolveProjectRoot(), DB_DIR_NAME, DB_FILE_NAME);
}

/** Absoluter Pfad der SQLite-Datei, die dieser Prozess benutzt. */
export const DB_PATH: string = resolveDbPath();

let instance: Database.Database | null = null;

/** Geöffnete Datenbank (Singleton). Legt data/ an, falls noch nicht vorhanden. */
export function getDb(): Database.Database {
  if (instance !== null && instance.open) {
    return instance;
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  registerFunctions(db);

  instance = db;
  return db;
}

/**
 * Eigene SQL-Funktionen dieser Verbindung.
 *
 * norm_text(x) faltet Gross-/Kleinschreibung und diakritische Zeichen genauso
 * wie normalizeText() auf der JavaScript-Seite. Gebraucht wird das ueberall
 * dort, wo COLLATE NOCASE nicht ausreicht - NOCASE kennt nur ASCII A-Z, womit
 * 'MÜNCHEN' und 'München' als verschiedene Staedte gelten wuerden.
 *
 * deterministic: true, weil dieselbe Eingabe immer dasselbe Ergebnis liefert;
 * SQLite darf den Aufruf dann aus Schleifen ziehen.
 */
function registerFunctions(db: Database.Database): void {
  db.function('norm_text', { deterministic: true }, (value: unknown): string | null =>
    typeof value === 'string' ? normalizeText(value) : null,
  );
}

/** Schließt die Verbindung. Ein späterer getDb()-Aufruf öffnet sie neu. */
export function closeDb(): void {
  if (instance === null) {
    return;
  }
  const db = instance;
  instance = null;
  if (db.open) {
    db.close();
  }
}

/**
 * Führt fn in einer Transaktion aus und gibt deren Rückgabewert zurück.
 * Alle Schreiboperationen laufen hierüber. Verschachtelte Aufrufe sind
 * erlaubt, better-sqlite3 benutzt dann intern Savepoints. fn muss synchron
 * sein - better-sqlite3 erlaubt in Transaktionen keine Promises.
 */
export function withTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

/** Einheitlicher Zeitstempel für created_at/updated_at (ISO 8601, UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Heutiges Datum als YYYY-MM-DD in lokaler Zeit (für notes.occurred_on).
 * Bewusst lokal und nicht UTC: "heute" richtet sich nach dem Kalender des
 * Nutzers, nicht nach Greenwich.
 */
export function todayIso(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
