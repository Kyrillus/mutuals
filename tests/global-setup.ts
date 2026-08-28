import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Legt die Test-Datenbank vor dem Lauf frisch an - ueber den echten
 * Migrationsrunner, nicht ueber eine Kopie des Schemas. So laufen die
 * DB-gestuetzten Tests immer gegen das Schema, das auch ausgeliefert wird.
 *
 * Den Pfad setzt vitest.config.ts, sowohl auf process.env dieses Prozesses als
 * auch auf test.env der Testprozesse.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testDbPath(): string {
  const configured = process.env['MUTUALS_DB_PATH'];
  if (configured === undefined || configured.trim() === '') {
    throw new Error(
      'MUTUALS_DB_PATH ist nicht gesetzt. Die Tests duerfen nie gegen data/mutuals.db laufen - ' +
        'siehe vitest.config.ts.',
    );
  }
  return configured;
}

function removeDatabase(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

export function setup(): void {
  const dbPath = testDbPath();
  removeDatabase(dbPath);

  execFileSync(
    path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
    [path.join(PROJECT_ROOT, 'scripts', 'migrate.ts')],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, MUTUALS_DB_PATH: dbPath },
      stdio: 'pipe',
    },
  );
}

export function teardown(): void {
  removeDatabase(testDbPath());
}
