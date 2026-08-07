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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

const bundle = withWords => `/* GENERATED FILE — do not edit.
 * Built from lib/game.js${withWords ? " and data/words.json" : ""} by tools/build-spike.js
 * Run \`npm run build\` after changing either of those.
 */
(function (global) {
  "use strict";

${body.split("\n").map(l => (l.trim() ? "  " + l : l)).join("\n")}

  global.Game = { ${exported.join(", ")} };
${withWords ? `  global.WORDS = ${words.trim()};\n` : ""}})(typeof window !== "undefined" ? window : globalThis);
`;

/*
 * Both the spike and the real app get a copy of the rules. The app could
 * import the module properly — it is always served over HTTP — but shipping
 * the same file to both means there is exactly one thing to keep in step with
 * lib/game.js.
 *
 * The word list is the exception, and only the spike gets it.
 *
 * The spike pages run off file:// with no server, so they have to deal their
 * own cards. The app never does: cards come from the server, already dealt.
 * Shipping the list anyway put every answer in the browser of every player —
 * one look at the network tab and the game is over — and handed anyone who
 * wanted to script the guess endpoint a ready-made dictionary.
 */
for (const [dir, withWords] of [["spike", true], ["app", false]]) {
  // mkdir because the container image excludes spike/ — the prototypes are
  // never served — and a missing directory should not fail the build.
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "bundle.js"), bundle(withWords));
  console.log(`Wrote ${dir}/bundle.js${withWords ? " (with the word list)" : ""}`);
}

console.log(`  ${exported.length} functions: ${exported.join(", ")}`);
console.log(`  ${["easy", "medium", "hard"]
  .map(t => `${t} ${JSON.parse(words).tiers[t].words.length}`).join(", ")} words`);
