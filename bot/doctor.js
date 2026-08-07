/*
 * Draw-tionary — install doctor.
 *
 * Answers one question: "in which channels, of which servers, can this bot
 * actually post a drawing?"
 *
 * It exists because the two things Discord makes you configure look identical
 * from the Developer Portal but are enforced in completely different places:
 *
 *   - Slash commands and button replies are interaction responses. They travel
 *     back through Discord's own webhook and ignore channel permissions
 *     entirely. They work in channels the bot cannot even see.
 *
 *   - Posting the finished drawing is POST /channels/{id}/messages with the bot
 *     token (bot/server.js). That obeys every permission and every channel
 *     override.
 *
 * So "the slash command worked" tells you nothing, and the Default Install
 * Settings page tells you what was *requested*, not what was *granted*. This
 * script computes what was granted, channel by channel, the same way Discord
 * does, and prints it.
 *
 * Read-only. It never posts, edits, or joins anything.
 *
 *   npm run doctor              # every server the bot is in
 *   npm run doctor <guild-id>   # just that one
 */

const { DISCORD_BOT_TOKEN, DISCORD_APP_ID } = process.env;

// ---------------------------------------------------------------- permissions

/*
 * Discord sends permissions as decimal strings because the set outgrew 53 bits
 * years ago. Everything here is BigInt for that reason — a stray Number turns
 * the high bits into silent nonsense.
 */
const P = {
  ADMINISTRATOR:            1n << 3n,
  VIEW_CHANNEL:             1n << 10n,
  SEND_MESSAGES:            1n << 11n,
  MANAGE_MESSAGES:          1n << 13n,
  EMBED_LINKS:              1n << 14n,
  ATTACH_FILES:             1n << 15n,
  READ_MESSAGE_HISTORY:     1n << 16n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n
};

/** What drawingPost() actually needs to land in a channel. */
const REQUIRED = ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS"];

/*
 * The algorithm is Discord's, in Discord's order, and the order is the whole
 * point: a role that allows something can be overridden by a member-specific
 * deny further down, and vice versa. Doing these steps out of sequence gives an
 * answer that is right most of the time, which is worse than useless in a tool
 * whose only job is to be trusted.
 */
function computePermissions({ guild, channel, memberRoleIds, botUserId }) {
  const roleById = new Map(guild.roles.map(r => [r.id, r]));

  /*
   * Each step is recorded as it happens. Knowing a permission is missing is
   * only half an answer — "which of the four places do I go and click" is the
   * half that saves an afternoon, and it is recoverable only by watching where
   * the bit disappears.
   */
  const stages = [];

  // 1. Base: @everyone (its role id is the guild id) plus every role the bot has.
  let base = BigInt(roleById.get(guild.id)?.permissions ?? "0");
  for (const id of memberRoleIds) {
    base |= BigInt(roleById.get(id)?.permissions ?? "0");
  }
  stages.push({ label: "never granted at server level", perms: base });

  // 2. Administrator short-circuits everything, including channel overrides.
  if (base & P.ADMINISTRATOR) return { perms: -1n, admin: true, stages };

  const overwrites = channel.permission_overwrites ?? [];
  const find = (id, type) => overwrites.find(o => o.id === id && Number(o.type) === type);

  // 3a. The @everyone channel override.
  const everyone = find(guild.id, 0);
  if (everyone) {
    base &= ~BigInt(everyone.deny);
    base |= BigInt(everyone.allow);
  }
  stages.push({ label: "denied to @everyone in this channel", perms: base });

  // 3b. Role overrides, accumulated first and applied together — deny before
  //     allow, so an allow on any of the bot's roles wins over a deny on another.
  let roleAllow = 0n, roleDeny = 0n;
  for (const id of memberRoleIds) {
    const o = find(id, 0);
    if (!o) continue;
    roleAllow |= BigInt(o.allow);
    roleDeny  |= BigInt(o.deny);
  }
  base &= ~roleDeny;
  base |= roleAllow;
  stages.push({ label: "denied to the bot's role in this channel", perms: base });

  // 3c. A member override on the bot itself beats all of the above.
  const member = find(botUserId, 1);
  if (member) {
    base &= ~BigInt(member.deny);
    base |= BigInt(member.allow);
  }
  stages.push({ label: "denied to this bot specifically in this channel", perms: base });

  return { perms: base, admin: false, stages };
}

const has = (perms, name) => perms === -1n || (perms & P[name]) !== 0n;

/** Which step took this permission away. Null if it survived. */
function blame(stages, name) {
  const bit = P[name];
  if (!(stages[0].perms & bit)) return stages[0].label;
  for (let i = 1; i < stages.length; i++) {
    if ((stages[i - 1].perms & bit) && !(stages[i].perms & bit)) return stages[i].label;
  }
  return null;
}

// ---------------------------------------------------------------- discord

async function api(path) {
  const res = await fetch("https://discord.com/api/v10" + path, {
    headers: { authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });

  if (res.status === 401) fail("DISCORD_BOT_TOKEN is wrong, or was reset in the portal.");
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    fail(`Rate limited. Wait ${body.retry_after ?? "a few"}s and run it again.`);
  }
  if (!res.ok) {
    const err = new Error(`${path} → ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------- output

/*
 * Marks are ✓ / ✗ / — rather than red and green text. Colour alone is not a
 * signal; this has to survive a screenshot pasted into a support thread, a
 * screen reader, and whoever is reading it on a phone at 2am.
 */
const MARK = { yes: "✓", no: "✗", na: "—" };

const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - [...String(s)].length));
const rule = (n = 74) => console.log("─".repeat(n));

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- checks

/** The app object as Discord holds it — the portal page, but authoritative. */
async function checkApplication() {
  console.log("\nAPPLICATION");
  rule();

  const app = await api("/applications/@me");
  const me  = await api("/users/@me");

  console.log(`  Name                 ${app.name}`);
  console.log(`  Bot user             ${me.username} (${me.id})`);

  if (DISCORD_APP_ID && DISCORD_APP_ID !== app.id) {
    console.log(`  ${MARK.no} DISCORD_APP_ID       ${DISCORD_APP_ID}`);
    console.log(`      …but this token belongs to application ${app.id}.`);
    console.log("      Your .env is pointing at a different app than the token.");
  } else {
    console.log(`  ${MARK.yes} App id               ${app.id}`);
  }

  /*
   * No interactions endpoint means Discord has nowhere to send slash commands,
   * and the symptom is "the command times out" rather than any error you'd
   * connect to this page.
   */
  const url = app.interactions_endpoint_url;
  console.log(
    url
      ? `  ${MARK.yes} Interactions URL     ${url}`
      : `  ${MARK.no} Interactions URL     not set — Discord has nowhere to deliver commands`
  );

  /*
   * integration_types_config is the "Select Methods" checkboxes. Guild install
   * (1) is the one that matters: it is what lets an admin add the bot to a
   * server. User install (0) only adds the app to one person's account so they
   * can run its commands anywhere — it has no bearing on whether other members
   * can SEE a message the bot posted in a channel. Messages in a channel are
   * visible to everyone who can read that channel, full stop.
   */
  const types = Object.keys(app.integration_types_config ?? {});
  console.log(
    types.includes("1")
      ? `  ${MARK.yes} Guild install        enabled`
      : `  ${MARK.no} Guild install        DISABLED — admins cannot add this bot to a server`
  );
  console.log(`  ${MARK.na} User install         ${types.includes("0") ? "enabled" : "off (fine — not needed here)"}`);

  const scopes = app.install_params?.scopes ?? [];
  const perms  = BigInt(app.install_params?.permissions ?? "0");
  if (scopes.length) {
    const missing = ["bot", "applications.commands"].filter(s => !scopes.includes(s));
    console.log(
      missing.length
        ? `  ${MARK.no} Default scopes       missing ${missing.join(", ")}`
        : `  ${MARK.yes} Default scopes       ${scopes.join(", ")}`
    );
    const lacking = REQUIRED.filter(k => (perms & P[k]) === 0n);
    console.log(
      lacking.length
        ? `  ${MARK.no} Default permissions  missing ${lacking.join(", ")}`
        : `  ${MARK.yes} Default permissions  view, send, embed all requested`
    );
    /*
     * The trap that costs people an afternoon: these are applied at install
     * time. Fixing them here does nothing to a server that already added the
     * bot — that server has to re-run the install link.
     */
    console.log("      (applied when a server ADDS the app — existing servers keep what they got)");
  }

  return me.id;
}

/** Commands have to exist, or nothing the user types reaches the bot at all. */
async function checkCommands(appId, guildIds) {
  console.log("\nREGISTERED COMMANDS");
  rule();

  const global = await api(`/applications/${appId}/commands`);
  console.log(
    global.length
      ? `  ${MARK.yes} Global               ${global.map(c => "/" + c.name).join(" ")}`
      : `  ${MARK.na} Global               none registered`
  );

  let anyGuild = false;
  for (const id of guildIds) {
    const cmds = await api(`/applications/${appId}/guilds/${id}/commands`).catch(() => []);
    if (cmds.length) {
      anyGuild = true;
      console.log(`  ${MARK.yes} Guild ${id}  ${cmds.map(c => "/" + c.name).join(" ")}`);
    }
  }

  if (!global.length && !anyGuild) {
    console.log(`  ${MARK.no} Nothing is registered anywhere. Run: npm run register`);
  }
}

async function checkGuild(guildId, botUserId, appName) {
  const guild = await api(`/guilds/${guildId}`);

  console.log(`\nSERVER — ${guild.name}  (${guild.id})`);
  rule();

  let member;
  try {
    member = await api(`/guilds/${guildId}/members/${botUserId}`);
  } catch (err) {
    if (err.status === 403) {
      /*
       * Reading its own membership needs the guild to actually have the bot in
       * it. A 403 here almost always means the app was added with only the
       * applications.commands scope — commands appear, a bot user never joins,
       * and every attempt to post 404s.
       */
      console.log(`  ${MARK.no} The bot is not a member of this server.`);
      console.log("      Likely added with applications.commands only, without the bot scope.");
      console.log("      Fix: re-run the install link, keeping BOTH scopes ticked.");
      return { guild, blocked: true };
    }
    throw err;
  }

  const channels = (await api(`/guilds/${guildId}/channels`))
    .filter(c => c.type === 0 || c.type === 5)   // text and announcement
    .sort((a, b) => a.position - b.position);

  if (!channels.length) {
    console.log("  No text channels.");
    return { guild, blocked: false };
  }

  console.log(
    `  ${pad("channel", 26)}${pad("view", 6)}${pad("send", 6)}${pad("embed", 7)}verdict`
  );

  /*
   * A channel the bot cannot even see is almost never a mistake — it is a
   * staff room, a ticket thread, a members-only area. Counting those as
   * failures buries the one or two channels that are genuinely misconfigured
   * under a wall of red, which is how a diagnostic tool trains you to ignore
   * it. Only a channel the bot CAN see but cannot post in is broken.
   */
  const broken = [];
  let hidden = 0, fine = 0;

  for (const ch of channels) {
    const { perms, admin, stages } = computePermissions({
      guild, channel: ch, memberRoleIds: member.roles, botUserId
    });

    const flags = REQUIRED.map(k => has(perms, k));
    const [canView, canSend, canEmbed] = flags;

    let verdict;
    if (!canView) { verdict = "private — expected"; hidden++; }
    else if (canSend && canEmbed) { verdict = admin ? "can post (admin)" : "can post"; fine++; }
    else {
      verdict = "BROKEN";
      broken.push({
        ch,
        why: REQUIRED.slice(1)
          .filter(k => !has(perms, k))
          .map(k => `${k.toLowerCase().replace("_", " ")}: ${blame(stages, k)}`)
      });
    }

    console.log(
      "  " +
      pad("#" + ch.name, 26) +
      flags.map((f, i) => pad(f ? MARK.yes : MARK.no, i === 2 ? 7 : 6)).join("") +
      verdict
    );
  }

  console.log("");
  console.log(`  ${fine} postable · ${hidden} private (fine) · ${broken.length} broken`);

  if (broken.length) {
    console.log("");
    for (const b of broken) {
      console.log(`  ✗ #${b.ch.name}`);
      for (const w of b.why) console.log(`      ${w}`);
    }

    /*
     * When every visible channel fails for the same server-level reason, the
     * per-channel advice is a wild goose chase — the bot's own role is empty
     * and no amount of channel fiddling will help.
     */
    const allServerLevel = broken.every(b =>
      b.why.every(w => w.endsWith("never granted at server level"))
    );

    console.log("");
    if (allServerLevel) {
      console.log(`  ⚑ Every one of these fails at the SERVER level, not the channel level.`);
      console.log(`    The "${appName}" role in this server was created without Send Messages`);
      console.log("    and Embed Links. Default Install Settings are applied once, when a");
      console.log("    server adds the app — editing them later does nothing here.");
      console.log("");
      console.log("    Two ways to fix it, either is enough:");
      console.log(`    a) Server Settings → Roles → "${appName}" → turn on Send Messages`);
      console.log("       and Embed Links. Takes ten seconds, no admin re-install needed.");
      console.log("    b) Have an admin re-run the install link to re-grant the defaults.");
    } else {
      console.log("    Fix per channel: Edit Channel → Permissions → add the");
      console.log(`    "${appName}" role → set View Channel, Send Messages and Embed Links`);
      console.log("    to the green ✓. Grey is not neutral — grey inherits, and inherits a");
      console.log("    deny if @everyone is denied there.");
    }
  }

  return { guild, blocked: false, badChannels: broken.length };
}

// ---------------------------------------------------------------- main

async function main() {
  if (!DISCORD_BOT_TOKEN) {
    fail("DISCORD_BOT_TOKEN is not set. Run this as `npm run doctor` so .env is loaded.");
  }

  const only = process.argv[2];

  const botUserId = await checkApplication();
  const app = await api("/applications/@me");

  const guilds = await api("/users/@me/guilds");
  if (!guilds.length) {
    console.log("\n✗ The bot is not in any server yet. Use the install link from the portal.\n");
    return;
  }

  const targets = only ? guilds.filter(g => g.id === only) : guilds;
  if (only && !targets.length) {
    fail(`The bot is not in server ${only}. It is in: ${guilds.map(g => `${g.name} (${g.id})`).join(", ")}`);
  }

  await checkCommands(app.id, targets.map(g => g.id));

  let broken = 0;
  for (const g of targets) {
    const r = await checkGuild(g.id, botUserId, app.name);
    if (r.blocked || r.badChannels) broken++;
  }

  console.log("");
  rule();
  console.log(
    broken
      ? `${MARK.no} ${broken} of ${targets.length} server(s) have a problem — see above.`
      : `${MARK.yes} All ${targets.length} server(s) look correct.`
  );
  console.log("");
}

main().catch(err => fail(err.message));
