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
  return app;
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
