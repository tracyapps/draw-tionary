/*
 * Generates spike/bundle.js so the spike pages work when opened straight from
 * the filesystem — no local server needed.
 *
 * Why this exists: file:// blocks both fetch() and ES module imports, so
 * `import ... from "../lib/game.js"` and `fetch("../data/words.json")` both
 * die silently in the console. The spike pages are meant to be double-clicked
 * and evaluated by eye, so they must not require a web server.
 *
 * lib/game.js stays the single source of truth. This just re-emits it as a
 * plain script that assigns a global, alongside the word list.
 *
 *   node tools/build-spike.js
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const gameSrc = readFileSync(join(root, "lib", "game.js"), "utf8");
const words   = readFileSync(join(root, "data", "words.json"), "utf8");

// Collect every exported name, then strip the `export` keywords so the body
// can run inside a plain IIFE.
const exported = [...gameSrc.matchAll(/^export\s+(?:const|function)\s+([A-Za-z0-9_$]+)/gm)]
  .map(m => m[1]);

if (!exported.length) {
  console.error("No exports found in lib/game.js — refusing to write an empty bundle.");
  process.exit(1);
}

const body = gameSrc.replace(/^export\s+/gm, "");

const out = `/* GENERATED FILE — do not edit.
 * Built from lib/game.js and data/words.json by tools/build-spike.js
 * Run \`npm run build\` after changing either of those.
 */
(function (global) {
  "use strict";

${body.split("\n").map(l => (l.trim() ? "  " + l : l)).join("\n")}

  global.Game = { ${exported.join(", ")} };
  global.WORDS = ${words.trim()};
})(typeof window !== "undefined" ? window : globalThis);
`;

/*
 * Both the spike and the real app get a copy. The app could import the module
 * properly — it is always served over HTTP — but shipping the same file to
 * both means there is exactly one thing to keep in step with lib/game.js.
 */
for (const dir of ["spike", "app"]) {
  writeFileSync(join(root, dir, "bundle.js"), out);
  console.log(`Wrote ${dir}/bundle.js`);
}

console.log(`  ${exported.length} functions: ${exported.join(", ")}`);
console.log(`  ${["easy", "medium", "hard"]
  .map(t => `${t} ${JSON.parse(words).tiers[t].words.length}`).join(", ")} words`);
