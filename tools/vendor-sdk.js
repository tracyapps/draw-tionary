/*
 * Copies Discord's Embedded App SDK into app/vendor/ so the Activity page can
 * import it from our own origin.
 *
 * Why vendor rather than bundle or CDN:
 *
 *   * An Activity runs sandboxed behind Discord's proxy and cannot reach
 *     external origins unless you add a URL mapping. Pulling the SDK from a
 *     CDN would mean maintaining a mapping for someone else's domain.
 *   * The published ESM output imports only relative paths, so the folder is
 *     self-contained and needs no bundler. Copy it and it works.
 *   * The project has zero runtime dependencies and this keeps it that way:
 *     the SDK is a devDependency whose output is checked into the image.
 *
 *   node tools/vendor-sdk.js
 */

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const src  = join(root, "node_modules", "@discord", "embedded-app-sdk");
const dest = join(root, "app", "vendor", "discord-sdk");

if (!existsSync(src)) {
  console.error(
    "@discord/embedded-app-sdk is not installed.\n" +
    "Run `npm install` first — it is a devDependency, and the image build\n" +
    "needs it present to vendor the browser files."
  );
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;

/*
 * Skip when the vendored copy already matches the installed version.
 *
 * `npm run check` runs the build every time, and re-copying 71 files on every
 * test run is waste. It also keeps the step working on filesystems that
 * refuse to overwrite or unlink in place — cloud-synced folders and Windows
 * file locks both do — where an unconditional copy fails for no good reason.
 *
 * Pass --force to re-vendor regardless.
 */
const stamp = join(dest, ".version");
const force = process.argv.includes("--force");

if (!force && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
  console.log(`@discord/embedded-app-sdk ${version} already vendored — skipping.`);
  process.exit(0);
}

/*
 * Clearing first means a downgrade cannot leave stale files behind. If the
 * filesystem refuses, carry on and overwrite what we can.
 */
try {
  rmSync(dest, { recursive: true, force: true });
} catch (err) {
  console.warn(`  (could not clear ${dest}: ${err.code} — overwriting in place)`);
}

mkdirSync(dest, { recursive: true });

/*
 * Only the ESM build and its pieces. The .cjs files are for Node, the .d.ts
 * files are for editors, and neither belongs in something a browser downloads.
 */
cpSync(join(src, "output"), dest, {
  recursive: true,
  filter: p => !p.endsWith(".cjs") && !p.endsWith(".d.ts")
});

cpSync(join(src, "LICENSE.md"), join(dest, "LICENSE.md"));
writeFileSync(stamp, version + "\n");

console.log(`Vendored @discord/embedded-app-sdk ${version} -> app/vendor/discord-sdk/`);
