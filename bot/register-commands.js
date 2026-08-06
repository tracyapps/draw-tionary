/*
 * Registers Draw-tionary's slash commands with Discord.
 *
 * Run once after creating the app, and again whenever the command list here
 * changes. Guild commands appear instantly, which is what you want while
 * testing; global commands can take up to an hour to propagate.
 *
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
 *     node bot/register-commands.js
 *
 * Omit DISCORD_GUILD_ID to register globally.
 */

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) {
  console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN first.");
  process.exit(1);
}

export const COMMANDS = [
  // Discord caps these at 100 characters. Wording is kept in step with
  // LISTING.md, which is where the player-facing copy is decided.
  {
    name: "draw",
    description: "Get a word and a canvas. No timer, no pressure.",
    type: 1
  },
  {
    name: "scores",
    description: "See who's ahead in this server",
    type: 1
  }
];

const path = DISCORD_GUILD_ID
  ? `/applications/${DISCORD_APP_ID}/guilds/${DISCORD_GUILD_ID}/commands`
  : `/applications/${DISCORD_APP_ID}/commands`;

const api = (method, body) => fetch("https://discord.com/api/v10" + path, {
  method,
  headers: {
    authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "content-type": "application/json"
  },
  body: body && JSON.stringify(body)
});

/*
 * Enabling Activities creates an Entry Point command — the "Launch" item in
 * the App Launcher — that this script does not own and must not delete.
 *
 * PUT replaces the entire command set, so sending only our two would remove
 * it. Discord refuses that outright:
 *
 *   50240: You cannot remove this app's Entry Point command in a bulk update
 *
 * which is a good refusal: silently unregistering it would break the Activity
 * with no obvious cause. So read what is already there and carry any Entry
 * Point (type 4) through untouched. Reading it rather than hardcoding a shape
 * means whatever Discord generated survives, including fields we don't know
 * about.
 */
const existing = await api("GET");
if (!existing.ok) {
  console.error(`Could not read existing commands: ${existing.status}`);
  console.error(await existing.text());
  process.exit(1);
}

const ENTRY_POINT = 4;
const entryPoints = (await existing.json()).filter(c => c.type === ENTRY_POINT);

for (const c of entryPoints) {
  console.log(`Preserving Entry Point command /${c.name} — it launches the Activity.`);
}

const res = await api("PUT", [...COMMANDS, ...entryPoints]);

if (!res.ok) {
  console.error(`Registration failed: ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const registered = await res.json();
console.log(
  DISCORD_GUILD_ID
    ? `Registered ${registered.length} commands in guild ${DISCORD_GUILD_ID} (available immediately):`
    : `Registered ${registered.length} commands globally (may take up to an hour to appear):`
);
for (const c of registered) {
  const kind = c.type === ENTRY_POINT ? " (Entry Point — opens the Activity)" : "";
  console.log(`  /${c.name} — ${c.description}${kind}`);
}
