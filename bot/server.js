/*
 * Draw-tionary server.
 *
 * Three jobs:
 *   1. POST /interactions   — Discord's webhook (signature-verified)
 *   2. GET  /draw?t=TOKEN   — hands the canvas app its session and card
 *   3. POST /api/submit     — receives a finished drawing and posts it
 *
 * Plus static hosting for the canvas itself.
 *
 * Uses node:http and node:sqlite — no framework, no native modules, nothing
 * to install. Run with:
 *
 *   node --experimental-sqlite bot/server.js
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync, accessSync, statSync, readFileSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, normalize } from "node:path";

import { verifyRequest, isFresh } from "../lib/verify.js";
import { handleInteraction, drawingPost, SESSION_TTL_MS } from "../lib/interactions.js";
import { createRound, submitDrawing, publicView, recordGuess, roundScores } from "../lib/rounds.js";
import { dealCard } from "../lib/game.js";
import { openStore } from "./store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const {
  DISCORD_PUBLIC_KEY,
  DISCORD_BOT_TOKEN,
  DISCORD_APP_ID,
  DISCORD_CLIENT_SECRET,
  PORT = 3000,
  PUBLIC_URL = `http://localhost:${PORT}`,
  DB_FILE
} = process.env;

if (!DISCORD_PUBLIC_KEY) {
  console.error("DISCORD_PUBLIC_KEY is not set — copy it from the Developer Portal.");
  process.exit(1);
}

/*
 * A misconfigured volume is the failure that costs you everything, and it is
 * silent: SQLite happily creates its file on the container's own disk, the app
 * looks healthy, and the drawings vanish at the next deploy. So check up front
 * that the directory exists and is writable, and refuse to start if it isn't.
 */
const PRODUCTION = process.env.NODE_ENV === "production";

/*
 * Unset DB_FILE means the database is written beside the source — which in a
 * container is inside the image, so every deploy starts from nothing. That is
 * fine on a laptop and never fine on a host, and the failure is silent: the
 * server is healthy, the game works, and yesterday's drawings are gone.
 *
 * There is no safe default to fall back to here, so this refuses rather than
 * guesses. Losing an evening's drawings is worse than a deploy that stops and
 * tells you why.
 */
if (!DB_FILE && PRODUCTION) {
  console.error(
    "DB_FILE is not set, so the database would be written inside the container\n" +
    "and thrown away on the next deploy.\n\n" +
    "  Railway: add a volume mounted at /data, then set DB_FILE=/data/draw-tionary.db\n" +
    "  Fly:     fly volumes create data --size 1   (fly.toml already mounts it at /data)\n\n" +
    "Refusing to start rather than quietly losing every drawing."
  );
  process.exit(1);
}

/**
 * Is this directory a mounted volume, or just a folder in the image?
 *
 * "Writable" was never the right question. The Dockerfile creates /data so the
 * first boot has somewhere to go, which means the directory exists and accepts
 * writes whether or not a volume was ever attached — the two are
 * indistinguishable by permissions, which is exactly how a database gets
 * written into a container layer and thrown away on the next deploy.
 *
 * /proc/mounts lists every mount point the kernel knows about, so on Linux —
 * which is every host this runs on — the question has a direct answer, on the
 * first boot, rather than being inferred from yesterday's drawings being gone.
 *
 * Returns null when it cannot tell, which is not the same as false.
 */
function isMountPoint(dir) {
  const target = resolve(dir);

  try {
    const mounts = readFileSync("/proc/mounts", "utf8")
      .split("\n")
      .map(line => line.split(" ")[1])
      .filter(Boolean)
      // Mount targets escape the awkward characters; spaces are the likely one.
      .map(p => p.replace(/\\040/g, " ").replace(/\\011/g, "\t"));

    if (mounts.length) return mounts.includes(target);
  } catch { /* no procfs — a mac, probably. Fall through. */ }

  /*
   * Fallback for anywhere without /proc: a mount is a different filesystem,
   * and a different filesystem usually has a different device number to its
   * parent. Weaker — some sandboxes report the same st_dev either side of a
   * real mount — so it is second, not first.
   */
  try {
    return statSync(target).dev !== statSync(join(target, "..")).dev;
  } catch {
    return null;
  }
}

const dbMounted = DB_FILE ? isMountPoint(dirname(DB_FILE)) : null;

/*
 * Writability, checked after the mount question rather than before it, because
 * the answer changes what "not writable" means.
 *
 * An unmounted directory that cannot be written is a broken path. A *mounted*
 * volume that cannot be written is the opposite problem — the volume arrived,
 * and the container is running as a user it does not belong to. Railway mounts
 * volumes as root, and this image deliberately runs as `node`, so attaching a
 * volume for the first time turns a working deploy into a failing one unless
 * RAILWAY_RUN_UID=0 goes on with it. Saying that here is the difference
 * between a two-minute fix and an evening.
 */
if (DB_FILE) {
  const dir = dirname(DB_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    console.error(
      `DB_FILE is set to ${DB_FILE} but ${dir} is not writable (${err.code}),\n` +
      `running as uid ${typeof process.getuid === "function" ? process.getuid() : "?"}.\n\n` +
      (dbMounted === true
        ? "That directory IS a mounted volume, so the volume is fine — this container\n" +
          "just isn't allowed to write to it. Railway mounts volumes as root and this\n" +
          "image runs as the `node` user, which is exactly this error.\n\n" +
          "  Fix: set RAILWAY_RUN_UID=0 in the service variables.\n\n" +
          "(That runs the app as root inside its own container. It is Railway's\n" +
          " documented answer, and there is no way to chown a volume you cannot write to.)"
        : "That directory is not a mounted volume, so the path is probably wrong.\n" +
          "Check the volume's mount path matches the directory in DB_FILE.") +
      "\n\nRefusing to start rather than writing a database that will be thrown away."
    );
    process.exit(1);
  }
}

const store = openStore(DB_FILE);
const words = JSON.parse(await readFile(join(root, "data", "words.json"), "utf8"));

const ctx = {
  store,
  words,
  drawUrl: PUBLIC_URL,
  now: () => Date.now(),
  /*
   * Off by default. The link-out flow is the one that is tested end to end and
   * known to work; the Activity has to be proven inside a real Discord client
   * before it becomes the way everyone plays.
   */
  activityEnabled: process.env.ACTIVITY_ENABLED === "1"
};

// ---------------------------------------------------------------- helpers

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", c => {
    size += c.length;
    // A drawing is ~300 KB of JSON; 5 MB is generous and still bounded.
    if (size > 5 * 1024 * 1024) { reject(new Error("payload too large")); req.destroy(); }
    chunks.push(c);
  });
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
};

// ---------------------------------------------------------------- cookies

/*
 * How long someone stays recognised on the replay pages. Long enough that
 * dipping in and out of a busy server doesn't keep making the game look like
 * it has forgotten you; short enough that a borrowed laptop forgets you.
 */
const VIEWER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VIEWER_COOKIE = "dt_viewer";

const secure = PUBLIC_URL.startsWith("https://");

/*
 * When the canvas eventually runs as a Discord Activity it is inside a
 * third-party iframe, where a Lax cookie is simply not sent. SameSite=None
 * plus Partitioned (CHIPS) is what works there, and both require Secure —
 * which is why this follows PUBLIC_URL rather than being hardcoded. Over
 * plain http locally we fall back to Lax, because a browser would drop a
 * None cookie without Secure and the whole thing would silently not work.
 */
/*
 * ACTIVITY_ENABLED implies this. Turning the Activity on while leaving the
 * cookie at Lax produces a failure that looks nothing like its cause: sign-in
 * succeeds, the Set-Cookie comes back, and then every following request in the
 * frame arrives anonymous — "not signed in" on a player who just signed in.
 * EMBEDDED_ACTIVITY stays honoured on its own so the cookie can be switched
 * ahead of the flag while testing.
 */
const EMBEDDED =
  process.env.EMBEDDED_ACTIVITY === "1" || process.env.ACTIVITY_ENABLED === "1";
const sameSite = EMBEDDED && secure ? "None" : "Lax";

const parseCookies = header => Object.fromEntries(
  (header ?? "").split(";").flatMap(part => {
    const i = part.indexOf("=");
    if (i < 0) return [];
    return [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]];
  })
);

const viewerCookie = (token, maxAgeMs) => [
  `${VIEWER_COOKIE}=${encodeURIComponent(token)}`,
  "Path=/",
  // The point of the whole exercise: script cannot read it, so it cannot be
  // copied into a message the way a URL token was.
  "HttpOnly",
  `SameSite=${sameSite}`,
  secure ? "Secure" : null,
  EMBEDDED && secure ? "Partitioned" : null,
  `Max-Age=${Math.floor(maxAgeMs / 1000)}`
].filter(Boolean).join("; ");

/** Whoever this browser has proved itself to be, or null. */
const viewerOf = req =>
  store.getViewerSession(parseCookies(req.headers.cookie)[VIEWER_COOKIE]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  /*
   * The vendored SDK ships as .mjs. Browsers enforce the MIME type strictly
   * for module scripts and refuse to execute anything that isn't a JavaScript
   * type — serving these as octet-stream fails only inside Discord, which is
   * the worst place to discover it.
   */
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

/*
 * Cache policy for static files.
 *
 * Nothing here has a content hash in its filename, so a long max-age would
 * mean shipping a CSS change and having Cloudflare keep serving the old one
 * for hours. `no-cache` does not mean "don't store" — it means "store it, but
 * revalidate before reuse", which with an ETag costs a 304 and nothing else.
 *
 * Images are exempt because they change far less often than the code that
 * references them, and a stale icon is not a broken page.
 */
const CACHE = {
  ".css":  "no-cache",
  ".js":   "no-cache",
  ".mjs":  "no-cache",
  ".json": "no-cache",
  ".html": "no-cache",
  ".svg":  "public, max-age=86400",
  ".png":  "public, max-age=86400",
  ".ico":  "public, max-age=86400",
  ".webp": "public, max-age=86400"
};

// ---------------------------------------------------------------- discord api

/*
 * Discord's own error bodies are terse, and the interesting information is the
 * status code. These are the four that actually happen when a drawing fails to
 * post, each of which needs a completely different fix — so name them rather
 * than logging "request failed" and leaving somebody to guess.
 */
const DISCORD_HINTS = {
  401: "the bot token is wrong or was reset — check DISCORD_BOT_TOKEN",
  403: "the bot is in the server but lacks Send Messages or Embed Links in that channel",
  404: "no such channel — either the id is empty, or the bot was never added to that server"
};

class DiscordError extends Error {
  constructor(status, path, body) {
    const hint = DISCORD_HINTS[status];
    super(`Discord ${path} → ${status}${hint ? ` (${hint})` : ""} ${body}`);
    this.status = status;
    this.hint = hint;
  }
}

async function discord(path, init = {}) {
  if (!DISCORD_BOT_TOKEN) {
    const err = new Error("DISCORD_BOT_TOKEN is not set");
    err.hint = "the server has no bot token, so it cannot post anything";
    throw err;
  }

  const res = await fetch("https://discord.com/api/v10" + path, {
    ...init,
    headers: {
      authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "content-type": "application/json",
      ...init.headers
    }
  });

  if (!res.ok) {
    throw new DiscordError(res.status, `${init.method ?? "GET"} ${path}`, await res.text());
  }
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------- routes

async function handleInteractionsRoute(req, res) {
  const raw = await readBody(req);
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  /*
   * Discord will not register an endpoint that fails to reject bad
   * signatures, and rightly so — without this anyone who learns the URL
   * could post fake interactions and award themselves points.
   */
  const good = verifyRequest({ rawBody: raw, signature, timestamp, publicKey: DISCORD_PUBLIC_KEY });
  if (!good || !isFresh(timestamp)) {
    res.writeHead(401).end("invalid request signature");
    return;
  }

  let interaction;
  try {
    interaction = JSON.parse(raw.toString("utf8"));
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }

  try {
    json(res, 200, await handleInteraction(interaction, ctx));
  } catch (err) {
    console.error("interaction failed:", err);
    json(res, 200, {
      type: 4,
      data: { content: "Something went wrong on my end. Try again in a moment.", flags: 64 }
    });
  }
}

/** The canvas app asks who it is and which words it may choose from. */
async function handleSessionRoute(req, res, url) {
  const session = await store.getSession(url.searchParams.get("t"));

  if (!session) {
    json(res, 404, { error: "This link has expired. Run /draw again for a fresh one." });
    return;
  }
  if (session.roundId) {
    json(res, 409, { error: "This link has already been used." });
    return;
  }

  json(res, 200, {
    userId: session.userId,
    card: session.card,          // server-dealt; the client may not invent words
    expiresAt: session.expiresAt
  });
}

/** A finished drawing arrives here and becomes a channel post. */
async function handleSubmitRoute(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    json(res, 400, { error: "bad json" });
    return;
  }

  const session = await store.getSession(body.token);
  if (!session)          return json(res, 404, { error: "This link has expired." });
  if (session.roundId)   return json(res, 409, { error: "This drawing was already posted." });

  // The word must be one of the three we dealt. Anything else is someone
  // editing the request to claim points they didn't earn.
  const choice = session.card.find(c => c.word === body.word);
  if (!choice) return json(res, 400, { error: "That word wasn't on your card." });

  const now = Date.now();
  const roundId = randomUUID();

  let round = createRound({
    id: roundId, drawerId: session.userId,
    word: choice.word, tier: choice.tier, points: choice.points, at: now
  });

  const submitted = submitDrawing(round, {
    strokes: body.strokes,
    durationMs: body.durationMs,
    width: body.width, height: body.height,
    at: now
  });

  if (!submitted.ok) return json(res, 400, { error: submitted.error });
  round = submitted.round;

  await store.saveRound(round, { guildId: session.guildId, channelId: session.channelId });

  if (!await store.consumeSession(body.token, roundId, now)) {
    return json(res, 409, { error: "This drawing was already posted." });
  }

  // Post it to the channel the /draw command came from.
  try {
    const post = drawingPost(round, { baseUrl: PUBLIC_URL });
    const msg = await discord(`/channels/${session.channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(post)
    });
    await store.setMessageId(roundId, msg.id);
  } catch (err) {
    /*
     * The drawing is saved either way — don't lose someone's work because
     * Discord had a bad minute. But say clearly what went wrong: "couldn't
     * post" with no reason sends people looking at their own drawing when the
     * answer is a missing permission or a channel the bot was never invited to.
     */
    console.error(
      `could not post round ${roundId} to channel ${session.channelId || "(empty!)"}:`,
      err.message
    );
    return json(res, 200, {
      ok: true,
      roundId,
      posted: false,
      reason: err.hint ?? "Discord refused the message",
      channelId: session.channelId || null
    });
  }

  json(res, 200, { ok: true, roundId, posted: true });
}

/*
 * Guessing is deliberately unlimited — wrong guesses cost nothing, and that
 * is a rule worth keeping. But "unlimited" over HTTP means a script can walk
 * the whole word list in a second, and isCorrect forgives typos, so the
 * margin for error is wide. A short floor between attempts leaves a person
 * typing as fast as they like and makes a machine take longer than the round.
 *
 * Per user *and* round: someone with two drawings open is one person playing,
 * not a suspect.
 */
const GUESS_MIN_GAP_MS = 750;
const lastGuessAt = new Map();

// Unbounded maps are how a small server becomes a memory leak nobody notices.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, at] of lastGuessAt) if (at < cutoff) lastGuessAt.delete(key);
}, 60_000).unref();

/**
 * A guess from the replay page.
 *
 * The same act as the Discord modal, through a different door — both land in
 * recordGuess, so there is one set of rules about what counts, what scores,
 * and who is allowed to try.
 *
 * Identity is the cookie and nothing else. The body names a round, never a
 * player: trusting it would let anyone guess as anyone.
 */
async function handleGuessRoute(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    return json(res, 400, { error: "bad json" });
  }

  const viewer = await viewerOf(req);
  if (!viewer) {
    return json(res, 401, {
      error: "I don't know who you are any more. Press Guess in Discord to start again."
    });
  }

  const round = await store.getRound(body.roundId);
  if (!round) return json(res, 404, { error: "That drawing is no longer around." });

  const typed = String(body.guess ?? "").slice(0, 200);
  if (!typed.trim()) return json(res, 400, { error: "Type something first." });

  const key = viewer.userId + "|" + round.id;
  const now = Date.now();
  const since = now - (lastGuessAt.get(key) ?? 0);
  if (since < GUESS_MIN_GAP_MS) {
    return json(res, 429, {
      error: "Slow down half a second and try that again.",
      retryAfterMs: GUESS_MIN_GAP_MS - since
    });
  }
  lastGuessAt.set(key, now);

  const result = recordGuess(round, { userId: viewer.userId, guess: typed, at: now });

  // canGuess said no — already solved, own drawing, hidden, removed. These are
  // states the page should already be reflecting, so they read as a 409 rather
  // than a failure of the request.
  if (!result.ok) return json(res, 409, { error: result.error, reason: result.reason });

  await store.saveRound(result.round);

  if (!result.correct) {
    return json(res, 200, { ok: true, correct: false, attempts: mineOn(result.round, viewer.userId) });
  }

  await store.applyScores(round.guildId, roundScores(result.round));

  /*
   * Announce it in the channel, because a solve nobody sees is half the game
   * missing — the modal path posts publicly for the same reason.
   *
   * Best-effort on purpose: the points are already banked and the page is
   * about to say so. A bot that cannot post (no token in development, a
   * missing permission in production) must not turn a correct answer into an
   * error message.
   */
  if (round.channelId) {
    try {
      await discord(`/channels/${round.channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content:
            `<@${viewer.userId}> got it — **${round.word}** — for **${result.awarded}** points.` +
            (result.solverIndex === 0 ? " First to crack it." : ""),
          allowed_mentions: { parse: [] }
        })
      });
    } catch (err) {
      console.error(`could not announce a solve on round ${round.id}:`, err.message);
    }
  }

  json(res, 200, {
    ok: true,
    correct: true,
    word: round.word,
    awarded: result.awarded,
    base: result.score.base,
    bonus: result.score.bonus,
    solverIndex: result.solverIndex,
    solverCount: result.round.solvers.length,
    attempts: mineOn(result.round, viewer.userId)
  });
}

/** How many goes this person has had, which is the bit worth celebrating. */
const mineOn = (round, userId) =>
  round.guesses.filter(g => g.userId === userId).length;

/**
 * Anyone can watch a replay; the answer is withheld unless they've earned it.
 *
 * Identity comes from the `v` token minted when they pressed "Watch it draw",
 * which is the only thing that ties a browser tab to a Discord user. Without
 * one — a shared link, a bookmark, someone else's paste — the view falls back
 * to the strictest possible read rather than failing, because a stranger
 * watching a replay is a feature.
 */
async function handleWatchRoute(req, res, url) {
  const roundId = url.pathname.split("/").pop();
  const round  = await store.getRound(roundId);
  const viewer = await viewerOf(req);

  // Even a miss reports whether we know the caller, so a dead round can still
  // offer them a canvas rather than a bare error.
  if (!round) return json(res, 404, { error: "not found", canStartDrawing: !!viewer });

  const view = publicView(round, viewer?.userId ?? null, {
    isModerator: viewer?.isModerator ?? false
  });

  // Tells the page whether it can offer a canvas without a trip through Discord.
  view.canStartDrawing = !!viewer;

  json(res, 200, view);
}

// ---------------------------------------------------------------- activity

/**
 * Trades the OAuth code from inside an Activity for an identity.
 *
 * The Activity has no session token — nobody ran a slash command to mint one.
 * Instead the iframe asks Discord to authorize it, gets back a short code, and
 * posts it here. We exchange the code for an access token using the client
 * secret (which never leaves the server), read who it belongs to, and hand
 * back our own viewer cookie plus the access token the SDK needs to finish
 * its own handshake.
 */
async function handleTokenRoute(req, res) {
  if (!DISCORD_CLIENT_SECRET) {
    console.error("DISCORD_CLIENT_SECRET is not set — the Activity cannot authenticate anyone.");
    return json(res, 503, {
      error: "This server isn't set up for Activities yet.",
      detail: "DISCORD_CLIENT_SECRET is missing."
    });
  }

  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    return json(res, 400, { error: "bad json" });
  }

  if (!body.code) return json(res, 400, { error: "no code" });

  let token, user;
  try {
    /*
     * Discord wants this form-encoded, not JSON — a mismatch here returns a
     * bare "invalid_request" that says nothing about which field was wrong.
     */
    const res1 = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_APP_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: body.code
      })
    });

    token = await res1.json();

    if (!res1.ok || !token.access_token) {
      console.error("oauth exchange failed:", res1.status, token);
      return json(res, 401, { error: "Couldn't verify you with Discord. Try reopening the app." });
    }

    const res2 = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    user = await res2.json();

    if (!res2.ok || !user.id) {
      console.error("could not read the user:", res2.status, user);
      return json(res, 401, { error: "Couldn't verify you with Discord. Try reopening the app." });
    }
  } catch (err) {
    console.error("oauth exchange threw:", err);
    return json(res, 502, { error: "Discord didn't answer. Try again in a moment." });
  }

  /*
   * The Activity tells us which channel it is running in. That is safe to
   * trust for routing — it comes from Discord's own query parameters — but
   * identity comes from the token exchange above, never from the frame.
   */
  const now = Date.now();
  const guildId   = String(body.guildId ?? "");
  const channelId = String(body.channelId ?? "");

  /*
   * Loud, because everything downstream depends on it and the symptom is
   * otherwise a drawing that saves and then refuses to post — which looks
   * like a bot permission problem rather than a missing query parameter.
   */
  if (!channelId) {
    console.warn(
      `${user.username ?? user.id} signed in from an Activity with no channel_id. ` +
      `Drawings from this session will have nowhere to post.`
    );
  }

  const session = await store.createViewerSession({
    userId: user.id,
    guildId,
    channelId,
    isModerator: false,   // re-established per round by publicView
    issuedAt: now,
    expiresAt: now + VIEWER_TTL_MS
  });

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": viewerCookie(session, VIEWER_TTL_MS),
    "cache-control": "no-store"
  });

  // access_token goes back so the SDK can call authenticate(); it is the
  // user's own token and never touches our database.
  res.end(JSON.stringify({
    access_token: token.access_token,
    user: { id: user.id, username: user.username, global_name: user.global_name }
  }));
}

/** What the Activity should show: the drawing you pressed, or a fresh card. */
async function handleActivityContextRoute(req, res, url) {
  const viewer = await viewerOf(req);
  if (!viewer) return json(res, 401, { error: "not signed in" });

  const channelId = url.searchParams.get("channel_id") || viewer.channelId;
  const intent = await store.getLaunchIntent(viewer.userId, channelId);

  if (!intent || intent.kind === "draw") {
    return json(res, 200, { kind: "draw" });
  }

  const round = await store.getRound(intent.roundId);
  if (!round) return json(res, 200, { kind: "draw" });

  json(res, 200, {
    kind: "guess",
    round: publicView(round, viewer.userId, { isModerator: viewer.isModerator })
  });
}

/** "No thanks, deal me a word instead." */
async function handleActivitySkipRoute(req, res) {
  const viewer = await viewerOf(req);
  if (!viewer) return json(res, 401, { error: "not signed in" });

  let body = {};
  try { body = JSON.parse((await readBody(req)).toString("utf8")); } catch { /* optional */ }

  await store.clearLaunchIntent(viewer.userId, body.channelId || viewer.channelId);
  json(res, 200, { ok: true });
}

/**
 * Trades the viewer cookie for a fresh drawing session.
 *
 * This is the "your turn" button on the replay page. It is the same act as
 * running /draw — the card is dealt here, server-side. Identity comes off the
 * cookie and the destination comes off the round being watched, so the
 * browser names neither.
 *
 * Dealing into the round's own channel rather than the cookie's last-seen one
 * is what makes this work on a server with several game channels: the drawing
 * lands where the thing you were just looking at lives.
 */
async function handleDrawSessionRoute(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    return json(res, 400, { error: "bad json" });
  }

  const viewer = await viewerOf(req);
  if (!viewer) {
    return json(res, 401, {
      error: "I don't know who you are any more. Run /draw in Discord to start one."
    });
  }

  const round = await store.getRound(body.roundId);
  const guildId   = round?.guildId   ?? viewer.guildId;
  const channelId = round?.channelId ?? viewer.channelId;

  /*
   * No channel means the finished drawing has nowhere to go. Minting a session
   * anyway lets somebody spend an hour on a hard word and only then discover
   * it cannot be posted — the failure has to happen here, before they draw.
   *
   * The channel is never taken from the request body. It comes from the round
   * being viewed, or from the Activity's own query parameters recorded at sign
   * in. Trusting the browser would let anyone make the bot post into any
   * channel it can see.
   */
  if (!channelId) {
    console.error(
      `refusing to deal a card to ${viewer.userId}: no channel on the session ` +
      `(guild "${guildId}"). Discord did not supply channel_id when the Activity started.`
    );
    return json(res, 409, {
      error: "I can't tell which channel to post to.",
      detail: "Try launching from a channel, or run /draw there instead."
    });
  }

  const now = Date.now();
  const recent = await store.recentWords(guildId, 40);
  const card = dealCard(words, { exclude: new Set(recent) });

  const token = await store.createSession({
    guildId, channelId,
    userId: viewer.userId,
    card,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS
  });

  json(res, 200, { url: `/draw?t=${token}` });
}

/*
 * /draw?t=… and /watch/:id are pages, not files. They serve the same HTML to
 * everyone and let the client fetch what it needs — which keeps the token out
 * of the markup and means these can be cached by anything in front of us.
 */
async function servePage(res, name, headers = {}) {
  try {
    let html = await readFile(join(root, "app", name), "utf8");

    /*
     * The Activity needs the application id to construct the SDK. It is
     * public — it is in every invite link — so substituting it here rather
     * than in a build step costs nothing and keeps the page a plain file.
     */
    if (html.includes("__DISCORD_APP_ID__")) {
      html = html.replaceAll("__DISCORD_APP_ID__", DISCORD_APP_ID ?? "");
    }

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The link is single-use and the round state changes; never cache these.
      "cache-control": "no-store",
      ...headers
    });
    res.end(html);
  } catch {
    console.error(`app/${name} is missing — run \`npm run build\`.`);
    res.writeHead(500).end("the canvas is missing");
  }
}

/**
 * The replay page, plus the one-time swap that gets identity out of the URL.
 *
 * Arriving with `?g=` means the person just pressed the button in Discord.
 * We spend the grant, set a cookie, and redirect to the bare `/watch/:id`.
 * After that the address bar holds nothing worth stealing, and every later
 * load — reload, back button, a link they saved — runs on the cookie.
 *
 * A spent or expired grant is not an error. It usually means a reload, or
 * somebody opening a link that was pasted into the channel. Both get the page
 * on whatever identity their own cookie carries, which for a stranger is
 * none at all.
 */
async function handleWatchPage(req, res, url) {
  const grantToken = url.searchParams.get("g");
  if (!grantToken) return servePage(res, "watch.html");

  const grant = await store.consumeViewGrant(grantToken);
  const clean = url.pathname;

  if (!grant) {
    res.writeHead(302, { location: clean, "cache-control": "no-store" }).end();
    return;
  }

  const now = Date.now();
  const expiresAt = now + VIEWER_TTL_MS;

  // Someone who already has a session keeps it and gets it extended, so a
  // phone and a laptop stay two independent logins.
  const existing = await viewerOf(req);
  const token = existing?.token ?? await store.createViewerSession({
    userId: grant.userId,
    guildId: grant.guildId,
    channelId: grant.channelId,
    isModerator: grant.isModerator,
    issuedAt: now,
    expiresAt
  });

  if (existing) {
    /*
     * Re-snapshot the permission. Someone promoted to moderator this morning
     * should not be stuck with last week's answer until their cookie expires.
     *
     * If the cookie belongs to a different Discord account — a shared
     * computer — the grant wins, because the grant is the thing Discord just
     * vouched for.
     */
    if (existing.userId !== grant.userId) {
      const fresh = await store.createViewerSession({
        userId: grant.userId,
        guildId: grant.guildId,
        channelId: grant.channelId,
        isModerator: grant.isModerator,
        issuedAt: now,
        expiresAt
      });
      res.writeHead(302, {
        location: clean,
        "set-cookie": viewerCookie(fresh, VIEWER_TTL_MS),
        "cache-control": "no-store"
      }).end();
      return;
    }

    await store.refreshViewerSession(token, {
      guildId: grant.guildId,
      channelId: grant.channelId,
      isModerator: grant.isModerator,
      expiresAt
    }, now);
  }

  res.writeHead(302, {
    location: clean,
    "set-cookie": viewerCookie(token, VIEWER_TTL_MS),
    "cache-control": "no-store"
  }).end();
}

/*
 * The public pages. Cached, unlike the app pages — they hold nothing
 * personal and change only when we deploy.
 */
async function servePublicPage(res, name) {
  try {
    const html = await readFile(join(root, "app", name));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Revalidate rather than hold for 5 minutes. These pages are small, and
      // a stale landing page after a deploy is more annoying than a 304.
      "cache-control": "no-cache"
    });
    res.end(html);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function serveStatic(req, res, url) {
  const rel = url.pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, safe);

  if (!file.startsWith(root)) { res.writeHead(403).end("nope"); return; }

  const ext = extname(file);

  try {
    /*
     * A weak ETag from size and mtime. Enough to answer "has this changed
     * since you last asked", which is all `no-cache` revalidation needs, and
     * far cheaper than hashing the file on every request.
     */
    const info = await stat(file);
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(36)}"`;

    const headers = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": CACHE[ext] ?? "no-cache",
      etag,
      "last-modified": info.mtime.toUTCString()
    };

    // Revalidation hit: the browser or the CDN already has this byte-for-byte.
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers).end();
      return;
    }

    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("not found");
  }
}

// ---------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);

  /*
   * HEAD is GET without a body, and it is not optional.
   *
   * Link checkers, CDNs, uptime monitors and — the one that cost us an
   * afternoon — URL validators routinely send HEAD first. Answering 405 makes
   * a perfectly healthy page look broken to anything that asks politely
   * before downloading.
   *
   * Node suppresses the response body for HEAD automatically, so routing it
   * exactly like GET is both correct and enough.
   */
  const method = req.method === "HEAD" ? "GET" : req.method;

  try {
    if (method === "POST" && url.pathname === "/interactions") return await handleInteractionsRoute(req, res);
    if (method === "GET"  && url.pathname === "/api/session")  return await handleSessionRoute(req, res, url);
    if (method === "POST" && url.pathname === "/api/submit")   return await handleSubmitRoute(req, res);
    if (method === "POST" && url.pathname === "/api/draw-session") return await handleDrawSessionRoute(req, res);
    if (method === "POST" && url.pathname === "/api/guess")    return await handleGuessRoute(req, res);
    if (method === "POST" && url.pathname === "/api/token")        return await handleTokenRoute(req, res);
    if (method === "GET"  && url.pathname === "/api/activity/context") return await handleActivityContextRoute(req, res, url);
    if (method === "POST" && url.pathname === "/api/activity/skip")    return await handleActivitySkipRoute(req, res);
    if (method === "GET"  && url.pathname.startsWith("/api/watch/")) return await handleWatchRoute(req, res, url);
    if (method === "GET"  && url.pathname === "/health")       return json(res, 200, { ok: true });

    // Pages before static, so /draw isn't mistaken for a file called "draw".
    //
    // `/` is the landing page, NOT the canvas. Someone who types the domain
    // should learn what the game is, not land on a drawing tool they have no
    // session for and cannot post from.
    /*
     * Discord's Activity iframe loads the root of the mapped domain, and the
     * root mapping's prefix cannot be changed. So `/` has to serve two
     * different things.
     *
     * Discord appends its own query parameters when it opens the frame —
     * frame_id is the reliable one — which is how we tell "an Activity is
     * starting" from "somebody typed the domain into a browser".
     */
    if (method === "GET"  && url.pathname === "/") {
      return url.searchParams.has("frame_id")
        ? await servePage(res, "activity.html")
        : await servePublicPage(res, "index.html");
    }
    if (method === "GET"  && url.pathname === "/privacy")      return await servePublicPage(res, "privacy.html");
    if (method === "GET"  && url.pathname === "/terms")        return await servePublicPage(res, "terms.html");

    if (method === "GET"  && url.pathname === "/draw")         return await servePage(res, "draw.html");
    if (method === "GET"  && url.pathname.startsWith("/watch/")) return await handleWatchPage(req, res, url);

    if (method === "GET")                                      return await serveStatic(req, res, url);

    res.writeHead(405, { allow: "GET, HEAD, POST" }).end("method not allowed");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "server error" });
  }
});

// Expired sessions are worthless; sweep them hourly.
setInterval(() => store.purgeExpiredSessions(), 60 * 60 * 1000).unref();

/*
 * 0.0.0.0, not the default. Inside a container, binding to localhost means the
 * platform's router cannot reach the process, and the symptom is a healthcheck
 * that times out with no error in the logs to explain why.
 */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Draw-tionary listening on port ${PORT}`);
  console.log(`  public url: ${PUBLIC_URL}`);
  console.log(`  interactions endpoint: ${PUBLIC_URL}/interactions`);
  console.log(`  database: ${DB_FILE ?? "(default, beside the source)"}`);

  if (DB_FILE) {
    const dir = dirname(DB_FILE);
    console.log(`  volume: ${dir} ${
      dbMounted === true  ? "is a mounted volume"
    : dbMounted === false ? "is NOT a mount — it is part of the container image"
    :                       "could not be checked"}`);

    /*
     * The whole failure, named on the first boot rather than the second.
     *
     * DB_FILE pointing at a real path with the right name is not the same as
     * a volume being attached to it, and every other signal — writable, boots
     * cleanly, game works — looks identical either way.
     */
    if (dbMounted === false && PRODUCTION) {
      console.warn("");
      console.warn(`  WARNING: DB_FILE is ${DB_FILE}, but ${dir} is not a mounted volume.`);
      console.warn("           The database is being written into the container image, so");
      console.warn("           every deploy starts from an empty one and all drawings are lost.");
      console.warn("           Setting DB_FILE is only half of it — the volume has to be");
      console.warn(`           attached to this service with its mount path set to exactly ${dir}.`);
      console.warn("");
    }
  }

  /*
   * Whether this is the same database as last time.
   *
   * Comparing the contents line across two deploys works but asks somebody to
   * remember yesterday's numbers. This answers it in one line: a database that
   * has survived says how old it is and how many boots it has seen, and one
   * that is being recreated every deploy can only ever say "boot 1".
   */
  store.recordBoot().then(b => {
    const days  = Math.floor(b.ageMs / 86_400_000);
    const hours = Math.floor(b.ageMs / 3_600_000);
    const age = days ? `${days} day${days === 1 ? "" : "s"} old`
              : hours ? `${hours} hour${hours === 1 ? "" : "s"} old`
              : "created just now";

    console.log(`  this database: ${age}, boot ${b.boots}`);

    /*
     * Right on a genuine first deploy and wrong on nothing else. If the volume
     * is not mounted, this is the line that says so — every single time, from
     * the first deploy, instead of after someone loses a drawing.
     */
    if (b.boots === 1 && PRODUCTION) {
      console.warn("  WARNING: this database was created seconds ago.");
      console.warn("           If you have deployed this app before, the volume is not");
      console.warn("           persisting and every drawing is thrown away on each deploy.");
      console.warn(`           Check that a volume is mounted at ${dirname(DB_FILE ?? ".")}.`);
    }
  }).catch(err => console.error("  could not stamp the database:", err.message));

  /*
   * Print what survived the restart. If these numbers reset to zero after a
   * deploy, the database is not on a persistent volume — which looks exactly
   * like a working server until somebody presses a button on yesterday's
   * drawing and is told it no longer exists.
   */
  store.stats().then(s => {
    console.log(`  contents: ${s.posted} posted drawings, ${s.guesses} guesses, ${s.players} players`);
    if (s.rounds === 0) {
      console.log("            (empty — expected on a first run, a warning on any other)");
    }
  }).catch(err => console.error("  could not read the database:", err.message));
  if (!DISCORD_BOT_TOKEN) console.log("  (DISCORD_BOT_TOKEN unset — channel posting disabled)");
  if (PUBLIC_URL.startsWith("http://") && process.env.NODE_ENV === "production") {
    console.warn("  WARNING: PUBLIC_URL is http. The viewer cookie will not be Secure,");
    console.warn("           and Discord requires https for an interactions endpoint.");
  }
  console.log(`  viewer cookie: SameSite=${sameSite}${secure ? "; Secure" : ""}${EMBEDDED && secure ? "; Partitioned" : ""}`);
  /*
   * The one combination that fails invisibly. Say so at boot rather than
   * letting a player discover it.
   */
  if (EMBEDDED && !secure) {
    console.warn("  WARNING: the Activity is on but PUBLIC_URL is not https, so the viewer");
    console.warn("           cookie stays SameSite=Lax and will be dropped inside the frame.");
    console.warn("           Players will sign in and then be told they are not signed in.");
  }
});

/*
 * Managed hosts send SIGTERM and then kill the container a few seconds later.
 * Closing the server first lets in-flight requests finish — someone mid-submit
 * loses an hour's drawing otherwise — and closing the database makes sure WAL
 * is checkpointed rather than left for recovery on next boot.
 */
let shuttingDown = false;

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — finishing in-flight requests.`);

    const done = () => {
      try { store.close(); } catch { /* already closed */ }
      process.exit(0);
    };

    server.close(done);
    // Don't hang forever on a wedged keep-alive connection.
    setTimeout(done, 10_000).unref();
  });
}

export { server, store };
