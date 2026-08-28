import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Wegwerf-Datenbank fuer die Tests, im Temp-Verzeichnis des Systems - nie
 * data/mutuals.db und nichts im Projektordner. tests/global-setup.ts loescht
 * sie vor jedem Lauf und legt sie ueber den echten Migrationsrunner neu an.
 */
const TEST_DB_PATH = path.join(os.tmpdir(), 'mutuals-vitest.db');

/**
 * Bewusst zweimal gesetzt, weil zwei verschiedene Prozesse den Pfad brauchen:
 * process.env gilt fuer den Hauptprozess (dort laeuft globalSetup), test.env
 * fuer die Testprozesse. Beide bekommen denselben Wert aus einer Quelle.
 */
process.env['MUTUALS_DB_PATH'] = TEST_DB_PATH;

export default defineConfig({
  // Dasselbe "@/..." wie in tsconfig.json, damit Tests und Anwendung dieselben
  // Importpfade benutzen.
  resolve: {
    alias: { '@': projectRoot },
  },
  test: {
    // better-sqlite3 ist ein natives Modul und laesst sich in Worker-Threads
    // nicht zuverlaessig mehrfach laden.
    pool: 'forks',
    // Alle Testdateien teilen sich dieselbe Datenbank.
    fileParallelism: false,
    env: {
      MUTUALS_DB_PATH: TEST_DB_PATH,
    },
    globalSetup: ['./tests/global-setup.ts'],
  },
});
