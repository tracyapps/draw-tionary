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
import { mkdirSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

import { verifyRequest, isFresh } from "../lib/verify.js";
import { handleInteraction, drawingPost, SESSION_TTL_MS } from "../lib/interactions.js";
import { createRound, submitDrawing, publicView } from "../lib/rounds.js";
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
if (DB_FILE) {
  const dir = dirname(DB_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    console.error(
      `DB_FILE is set to ${DB_FILE} but ${dir} is not writable (${err.code}).\n` +
      `On Railway or Fly this usually means the volume isn't mounted there yet.\n` +
      `Refusing to start rather than writing a database that will be thrown away.`
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
const EMBEDDED = process.env.EMBEDDED_ACTIVITY === "1";
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

async function discord(path, init = {}) {
  if (!DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is not set");

  const res = await fetch("https://discord.com/api/v10" + path, {
    ...init,
    headers: {
      authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "content-type": "application/json",
      ...init.headers
    }
  });

  if (!res.ok) {
    throw new Error(`Discord ${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
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
    const post = drawingPost(round);
    const msg = await discord(`/channels/${session.channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(post)
    });
    await store.setMessageId(roundId, msg.id);
  } catch (err) {
    // The drawing is saved either way — don't lose someone's work because
    // Discord had a bad minute.
    console.error("could not post to channel:", err);
    return json(res, 200, { ok: true, roundId, posted: false });
  }

  json(res, 200, { ok: true, roundId, posted: true });
}

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
  const session = await store.createViewerSession({
    userId: user.id,
    guildId: String(body.guildId ?? ""),
    channelId: String(body.channelId ?? ""),
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
  if (!DISCORD_BOT_TOKEN) console.log("  (DISCORD_BOT_TOKEN unset — channel posting disabled)");
  if (PUBLIC_URL.startsWith("http://") && process.env.NODE_ENV === "production") {
    console.warn("  WARNING: PUBLIC_URL is http. The viewer cookie will not be Secure,");
    console.warn("           and Discord requires https for an interactions endpoint.");
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
