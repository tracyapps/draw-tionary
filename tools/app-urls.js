/*
 * Reads and sets the application's Privacy Policy / Terms URLs via the API.
 *
 * Why this exists: the Developer Portal collapses every failure into one
 * sentence ("The Privacy Policy URL provided is not allowed."). The API
 * returns a structured error with a code and a per-field message, which is
 * usually enough to tell a blocked domain from a malformed value from an
 * application that isn't in a state to accept the field at all.
 *
 *   npm run app:urls                          # show what's set now
 *   npm run app:urls -- --privacy=https://…   # set one
 *   npm run app:urls -- --privacy=https://… --terms=https://…
 *   npm run app:urls -- --probe               # try several URLs, report each
 *
 * Needs DISCORD_BOT_TOKEN in .env.
 */

const { DISCORD_BOT_TOKEN } = process.env;

if (!DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is not set. Run with `npm run app:urls` so .env is loaded.");
  process.exit(1);
}

const API = "https://discord.com/api/v10/applications/@me";
const auth = { authorization: `Bot ${DISCORD_BOT_TOKEN}`, "content-type": "application/json" };

const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** Prints whatever Discord actually said, not a summary of it. */
async function show(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  console.log(`  HTTP ${res.status}`);
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    console.log("  (rate limited — wait a moment and retry)");
  }
  console.dir(body, { depth: 8, colors: true });
  return body;
}

async function current() {
  console.log("\nCurrent application settings:");
  const res = await fetch(API, { headers: auth });
  const app = await res.json();

  if (!res.ok) return show(res);

  console.log(`  name:        ${app.name}`);
  console.log(`  id:          ${app.id}`);
  console.log(`  public bot:  ${app.bot_public}`);
  console.log(`  privacy url: ${app.privacy_policy_url ?? "(not set)"}`);
  console.log(`  terms url:   ${app.terms_of_service_url ?? "(not set)"}`);
  console.log(`  flags:       ${app.flags}`);

  installSettings(app);
  return app;
}

/*
 * The "Add App" button in the App Directory is a Discord Provided Link: it
 * carries no scopes in the URL and uses whatever Default Install Settings say.
 *
 * If Guild Install's scopes omit `bot`, everyone who installs from discovery
 * gets an app with no bot in their server — the Activity opens, drawings save,
 * and nothing can ever be posted. Nothing in the code can detect or fix that,
 * so it is worth being able to read it from here.
 */
function installSettings(app) {
  const NAMES = { 0: "Guild install (to a server)", 1: "User install (to an account)" };
  const cfg = app.integration_types_config ?? {};

  console.log("\nDefault install settings — what the App Directory button asks for:");

  if (!Object.keys(cfg).length) {
    console.log("  (none reported — set them on the Installation page)");
    return;
  }

  for (const [type, conf] of Object.entries(cfg)) {
    const params = conf?.oauth2_install_params;
    console.log(`\n  ${NAMES[type] ?? "type " + type}`);

    if (!params) {
      console.log("    no default install params");
      continue;
    }

    const scopes = params.scopes ?? [];
    const perms  = BigInt(params.permissions ?? "0");

    console.log(`    scopes:      ${scopes.join(", ") || "(none)"}`);
    console.log(`    permissions: ${perms}`);

    const NEED = { VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, EMBED_LINKS: 1n << 14n };
    const missingPerms = Object.entries(NEED)
      .filter(([, bit]) => (perms & bit) === 0n)
      .map(([n]) => n);

    if (type === "0") {
      if (!scopes.includes("bot")) {
        console.log("    ⚠ MISSING `bot` — installs from the App Directory will have no bot,");
        console.log("      so drawings will save but never post to the channel.");
      }
      if (missingPerms.length) {
        console.log(`    ⚠ missing permissions: ${missingPerms.join(", ")}`);
        console.log("      Without VIEW_CHANNEL, posting fails with 50001 Missing Access.");
      }
      if (scopes.includes("bot") && !missingPerms.length) {
        console.log("    ✓ a discovery install will include a working bot");
      }
    }

    if (type === "1") {
      console.log("    note: a user install never carries a bot. Someone who installs");
      console.log("      this way can open the Activity but cannot post a drawing.");
    }
  }
}

async function patch(payload) {
  const res = await fetch(API, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify(payload)
  });
  return { ok: res.ok, body: await show(res) };
}

// ---------------------------------------------------------------- probe

/*
 * Sends a series of candidate URLs one at a time and reports which are
 * accepted. This is the fastest way to tell "Discord dislikes my domain" from
 * "Discord dislikes this field right now" — if a well-known URL is also
 * refused, the problem is not your website.
 */
async function probe() {
  const candidates = [
    ["your domain",        "https://draw-tionary.app/privacy"],
    ["your domain, root",  "https://draw-tionary.app/"],
    ["github repo",        "https://github.com/tracyapps/draw-tionary"],
    ["github raw file",    "https://raw.githubusercontent.com/tracyapps/draw-tionary/main/README.md"],
    ["a known-good site",  "https://discord.com/privacy"]
  ];

  console.log("\nProbing candidate privacy policy URLs one at a time.\n");

  for (const [label, url] of candidates) {
    console.log(`- ${label}: ${url}`);
    const { ok } = await patch({ privacy_policy_url: url });
    console.log(ok ? "  ACCEPTED\n" : "  refused\n");
    await new Promise(r => setTimeout(r, 1200));   // be polite to the API
  }

  console.log("Reading back what actually stuck:");
  await current();

  console.log(`
How to read this:
  * If every URL is refused, including discord.com, the field or the
    application is the problem — not your site. Take it to Discord support.
  * If only your domain is refused, the domain is being blocked.
  * If your domain is accepted here but the portal still complains, the
    portal UI is stale. Reload it.
`);
}

// ---------------------------------------------------------------- main

if (process.argv.includes("--probe")) {
  await probe();
} else {
  const privacy = arg("privacy");
  const terms   = arg("terms");

  if (!privacy && !terms) {
    await current();
    console.log(`
Nothing to set. Pass --privacy=… and/or --terms=…, or --probe to test
several URLs and see which Discord will accept.
`);
  } else {
    const payload = {};
    if (privacy) payload.privacy_policy_url = privacy;
    if (terms)   payload.terms_of_service_url = terms;

    console.log("\nPATCH /applications/@me");
    console.dir(payload);
    const { ok } = await patch(payload);
    if (ok) await current();
  }
}
