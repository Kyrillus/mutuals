/**
 * Nachbearbeitung des tsc-Laufs aus tsconfig.mcp.json.
 *
 * Warum es diesen Schritt ueberhaupt gibt:
 *
 *   1. Die Dateien in lib/ importieren einander ohne Dateiendung ("./db",
 *      "./text"). Das ist die Konvention des Projekts und fuer Next.js und
 *      vitest richtig, weil beide einen Bundler-Resolver benutzen. tsc gibt
 *      Modulpfade unveraendert aus, und Node kann eine Endung in ESM nicht
 *      erraten: 'node mcp/dist/server.js' liefe sonst sofort in
 *      ERR_MODULE_NOT_FOUND. Dieser Schritt ergaenzt die fehlenden ".js".
 *
 *   2. rootDir muss die Projektwurzel sein (lib/ liegt ausserhalb von mcp/),
 *      also legt tsc den Einstiegspunkt unter mcp/dist/mcp/server.js ab.
 *      Verlangt ist mcp/dist/server.js. Der Einstiegspunkt wandert deshalb
 *      eine Ebene hoch, und seine relativen Importe werden auf den neuen Ort
 *      umgerechnet.
 *
 * Beides sind reine Pfadumrechnungen: jeder relative Modulpfad wird gegen das
 * urspruengliche Verzeichnis aufgeloest, bekommt seine Endung und wird gegen
 * das endgueltige Verzeichnis neu relativiert. Am Code selbst aendert sich
 * nichts.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'mcp', 'dist');
/** Dorthin legt tsc den Einstiegspunkt, weil rootDir die Projektwurzel ist. */
const EMITTED_ENTRY = path.join(DIST_DIR, 'mcp', 'server.js');
/** Dort soll er liegen. */
const FINAL_ENTRY = path.join(DIST_DIR, 'server.js');

/**
 * Relative Modulpfade in ESM-Ausgabe: 'from "./x"', 'import "./x"',
 * 'import("./x")' und 'export … from "./x"'. Gesucht wird nur, was mit einem
 * Punkt beginnt - Paketnamen wie 'better-sqlite3' bleiben unangetastet.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

const HAS_EXTENSION = /\.(js|mjs|cjs|json|node)$/;

/** Alle .js-Dateien unterhalb von dir. */
function collectJsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectJsFiles(full));
    } else if (entry.isFile() && full.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Rechnet jeden relativen Modulpfad von fromDir auf toDir um und ergaenzt die
 * fehlende Endung. fromDir und toDir sind identisch, solange die Datei liegen
 * bleibt; nur beim Einstiegspunkt unterscheiden sie sich.
 */
function rewriteSpecifiers(code, fromDir, toDir) {
  return code.replace(SPECIFIER, (match, prefix, quote, specifier) => {
    const target = path.resolve(fromDir, specifier);
    const withExtension = HAS_EXTENSION.test(target) ? target : `${target}.js`;
    let rewritten = path.relative(toDir, withExtension).split(path.sep).join('/');
    if (!rewritten.startsWith('.')) {
      rewritten = `./${rewritten}`;
    }
    return `${prefix}${quote}${rewritten}${quote}`;
  });
}

function main() {
  if (!fs.existsSync(EMITTED_ENTRY)) {
    console.error(
      `[mcp:build] ${path.relative(PROJECT_ROOT, EMITTED_ENTRY)} fehlt - hat tsc etwas ausgegeben?`,
    );
    process.exit(1);
  }

  for (const file of collectJsFiles(DIST_DIR)) {
    const isEntry = file === EMITTED_ENTRY;
    const fromDir = path.dirname(file);
    const toDir = isEntry ? path.dirname(FINAL_ENTRY) : fromDir;
    const rewritten = rewriteSpecifiers(fs.readFileSync(file, 'utf8'), fromDir, toDir);
    fs.writeFileSync(isEntry ? FINAL_ENTRY : file, rewritten);
  }

  // Das Zwischenverzeichnis mcp/dist/mcp/ wird nach dem Hochziehen nicht mehr
  // gebraucht. Es enthaelt nur Build-Ausgabe.
  fs.rmSync(path.join(DIST_DIR, 'mcp'), { recursive: true, force: true });

  console.error(`[mcp:build] ${path.relative(PROJECT_ROOT, FINAL_ENTRY)} ist startbereit.`);
}

main();
