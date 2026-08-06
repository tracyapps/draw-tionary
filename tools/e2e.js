/*
 * End-to-end test: boots the real server against a real (temporary) database
 * and drives one full round over HTTP.
 *
 * /draw -> session -> submit a drawing -> guess it -> check the leaderboard.
 *
 * Signatures are real Ed25519, generated here and handed to the server as its
 * public key, so the verification path is genuinely exercised rather than
 * stubbed out.
 *
 *   node --experimental-sqlite tools/e2e.js
 */

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const ok  = m => console.log("PASS  " + m);
const bad = m => { failures++; console.log("FAIL  " + m); };

// ---------------------------------------------------------------- setup

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_HEX = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");

const tmp = mkdtempSync(join(tmpdir(), "drawtionary-"));
const PORT = 39_517;
const BASE = `http://localhost:${PORT}`;

process.env.DISCORD_PUBLIC_KEY = PUB_HEX;
// The Activity page needs an application id substituted into it, so the
// server has to have one the way it would in production.
process.env.DISCORD_APP_ID = "1234567890";
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = BASE;
process.env.DB_FILE = join(tmp, "test.db");
delete process.env.DISCORD_BOT_TOKEN;    // no real Discord calls

const { server, store } = await import(join(root, "bot", "server.js"));
await new Promise(r => setTimeout(r, 150));

// ---------------------------------------------------------------- helpers

async function interact(payload, { tamper = false } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = edSign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey)
    .toString("hex");

  return fetch(BASE + "/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": tamper ? "0".repeat(128) : sig,
      "x-signature-timestamp": ts
    },
    body
  });
}

const asUser = id => ({
  guild_id: "guild1", channel_id: "chan1",
  member: { user: { id }, permissions: "0" }
});

// ---------------------------------------------------------------- security

{
  const res = await fetch(BASE + "/health");
  res.ok ? ok("server is up") : bad("server did not start");
}

{
  const res = await interact({ type: 1 }, { tamper: true });
  res.status === 401
    ? ok("an unsigned request is rejected with 401")
    : bad(`expected 401 for a bad signature, got ${res.status}`);
}

{
  const res = await fetch(BASE + "/interactions", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  res.status === 401 ? ok("a request with no signature headers is rejected")
                     : bad(`expected 401, got ${res.status}`);
}

{
  const res = await interact({ type: 1 });
  const body = await res.json();
  body.type === 1 ? ok("a correctly signed PING gets a PONG")
                  : bad("PING was not answered: " + JSON.stringify(body));
}

// ---------------------------------------------------------------- /draw

let token;
{
  const res = await interact({ type: 2, data: { name: "draw" }, ...asUser("tapps") });
  const body = await res.json();
  const url = body.data?.components?.[0]?.components?.[0]?.url ?? "";
  token = new URL(url).searchParams.get("t");

  token ? ok("/draw returned a private canvas link with a session token")
        : bad("no token in /draw response: " + JSON.stringify(body));

  body.data.flags === 64 ? ok("the canvas link is ephemeral")
                         : bad("the canvas link was posted publicly");
}

// ---------------------------------------------------------------- activity

{
  /*
   * The Activity iframe loads the root of the mapped domain, and the root
   * mapping's prefix cannot be changed — so `/` has to serve the landing page
   * to the world and the game to Discord. frame_id is how they're told apart.
   */
  const plain = await (await fetch(`${BASE}/`)).text();
  const framed = await (await fetch(`${BASE}/?frame_id=abc&channel_id=c1&guild_id=g1`)).text();

  /Add to Discord/.test(plain) && !/discord-client-id/.test(plain)
    ? ok("/ serves the landing page to an ordinary browser")
    : bad("/ served the Activity to a normal visitor");

  /discord-client-id/.test(framed) && !/Add to Discord/.test(framed)
    ? ok("/ serves the Activity when Discord frames it")
    : bad("/ did not serve the Activity to a framed request");

  /content="\d+"/.test(framed)
    ? ok("the application id is substituted into the Activity page")
    : bad("client id placeholder was not filled in");

  // The SDK is vendored to our own origin because an Activity is sandboxed
  // and cannot reach a CDN without a URL mapping for someone else's domain.
  const sdk = await fetch(`${BASE}/app/vendor/discord-sdk/index.mjs`);
  sdk.ok && /javascript/.test(sdk.headers.get("content-type") ?? "")
    ? ok("the vendored SDK is served as JavaScript, which module scripts require")
    : bad(`SDK served as ${sdk.status} ${sdk.headers.get("content-type")}`);
}

{
  // Without the client secret the token exchange must say so plainly rather
  // than failing somewhere deep inside an OAuth call.
  const res = await fetch(`${BASE}/api/token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "whatever" })
  });
  const body = await res.json();

  res.status === 503 && /CLIENT_SECRET/.test(body.detail ?? "")
    ? ok("an unconfigured token exchange names the missing setting")
    : bad(`expected a clear 503, got ${res.status} ${JSON.stringify(body)}`);

  const noCookie = await fetch(`${BASE}/api/activity/context`);
  noCookie.status === 401
    ? ok("activity context needs a session — the frame can't ask anonymously")
    : bad(`expected 401 without a cookie, got ${noCookie.status}`);
}

// ---------------------------------------------------------------- HEAD

{
  /*
   * HEAD is not optional. Link checkers, CDNs, uptime monitors and URL
   * validators all send it before committing to a download, and answering 405
   * makes a healthy page look broken to every one of them.
   *
   * Discord's Developer Portal refused this app's privacy policy URL for
   * exactly this reason — same 405 on the custom domain and the platform
   * domain, which is what ruled out DNS and made it obvious it was us.
   */
  for (const path of ["/", "/privacy", "/terms", "/draw", "/health"]) {
    const res = await fetch(BASE + path, { method: "HEAD" });
    res.ok
      ? ok(`HEAD ${path} answers ${res.status}`)
      : bad(`HEAD ${path} returned ${res.status} — link checkers will call this broken`);
  }

  const head = await fetch(`${BASE}/privacy`, { method: "HEAD" });
  const body = await head.text();
  body === ""
    ? ok("HEAD sends headers with no body, as it should")
    : bad("HEAD returned a body");

  head.headers.get("content-type")?.startsWith("text/html")
    ? ok("HEAD still reports the content type a validator is checking for")
    : bad("HEAD dropped the content-type header");
}

// ---------------------------------------------------------------- caching

{
  /*
   * Nothing is content-hashed, so a long max-age on CSS means shipping a
   * change and having the CDN serve the old file for hours. That happened:
   * a restyle went out and the site kept the previous stylesheet, which
   * looked like broken layout rather than a caching problem.
   */
  const css = await fetch(`${BASE}/app/site.css`);
  const cc  = css.headers.get("cache-control") ?? "";
  const tag = css.headers.get("etag");

  /no-cache/.test(cc)
    ? ok("CSS is served no-cache, so a deploy is picked up immediately")
    : bad(`CSS cache-control is "${cc}" — a stale stylesheet will outlive a deploy`);

  tag ? ok("CSS carries an ETag so revalidation is a cheap 304")
      : bad("no ETag on CSS — every revalidation refetches the whole file");

  const again = await fetch(`${BASE}/app/site.css`, { headers: { "if-none-match": tag } });
  again.status === 304
    ? ok("an unchanged stylesheet revalidates to 304")
    : bad(`expected 304 on revalidation, got ${again.status}`);

  const png = await fetch(`${BASE}/app/icon/og.png`);
  /max-age=\d\d\d\d/.test(png.headers.get("cache-control") ?? "")
    ? ok("images are cached properly — they change far less than the code")
    : bad("images are not cached");
}

// ---------------------------------------------------------------- public site

{
  const res  = await fetch(`${BASE}/`);
  const html = await res.text();

  /*
   * `/` must be the landing page, not the canvas. Someone typing the domain
   * should learn what the game is — landing on a drawing tool they have no
   * session for, with a sticky "you're in preview" notice, is a bad front door
   * for the URL that goes in the App Directory.
   */
  res.ok && /Add to Discord/.test(html) && !/id="board"/.test(html)
    ? ok("/ serves the landing page, not the drawing canvas")
    : bad("/ is not the landing page");

  // The invite link has to carry the permissions the bot actually needs.
  const invite = /discord\.com\/oauth2\/authorize\?[^"]+/.exec(html)?.[0] ?? "";
  /permissions=18432/.test(invite) && /scope=bot(%20|\+)applications\.commands/.test(invite)
    ? ok("the invite link asks for Send Messages + Embed Links and nothing else")
    : bad("invite link has the wrong scopes or permissions: " + invite);

  for (const [path, needle] of [["/privacy", "dt_viewer"], ["/terms", "Acceptable use"]]) {
    const r = await fetch(BASE + path);
    const body = await r.text();
    r.ok && body.includes(needle)
      ? ok(`${path} serves real content, not a placeholder`)
      : bad(`${path} returned ${r.status} or is missing its substance`);
  }

  // Legal pages are linked from the landing page, because Discord's app
  // listing asks for those URLs and reviewers follow them.
  /href="\/privacy"/.test(html) && /href="\/terms"/.test(html)
    ? ok("privacy and terms are reachable from the landing page")
    : bad("legal pages are not linked from /");
}

/*
 * The link in that reply has to actually open something. `/draw` is a route,
 * not a file on disk, so a plain static handler answers it with a 404 and the
 * whole game is a dead link — worth one assertion.
 */
{
  const res  = await fetch(`${BASE}/draw?t=${token}`);
  const html = await res.text();

  res.ok && /<canvas/.test(html)
    ? ok("the canvas link opens the real drawing page")
    : bad(`/draw?t=… returned ${res.status} with no canvas`);

  res.headers.get("cache-control") === "no-store"
    ? ok("the canvas page is never cached — the link is single-use")
    : bad("the canvas page is cacheable");

  /id="diag"|Diagnostics/.test(html)
    ? bad("the diagnostics panel is still being served to players")
    : ok("no diagnostics panel in the page players get");
}

let card;
{
  const res = await fetch(`${BASE}/api/session?t=${token}`);
  const body = await res.json();
  card = body.card;

  card?.length === 3 ? ok("the canvas can fetch its server-dealt card")
                     : bad("session did not return a card: " + JSON.stringify(body));

  body.userId === "tapps" ? ok("the session knows which Discord user it belongs to")
                          : bad("session user mismatch");
}

{
  const res = await fetch(`${BASE}/api/session?t=not-a-real-token`);
  res.status === 404 ? ok("an unknown token is refused")
                     : bad(`expected 404 for a bogus token, got ${res.status}`);
}

// ---------------------------------------------------------------- submit

const strokes = [{
  c: "#5865f2", w: 6, e: 0,
  p: Array.from({ length: 200 }, (_, i) => [i / 400, 0.3 + Math.sin(i / 20) / 8, 0.5, i * 15])
}];

{
  // Forging a word that wasn't dealt must fail — this is the whole reason
  // the card lives on the server.
  const res = await fetch(BASE + "/api/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, word: "traffic jam", strokes, durationMs: 3000, width: 1200, height: 900 })
  });
  const forged = card.every(c => c.word !== "traffic jam");
  if (forged) {
    res.status === 400 ? ok("a word that wasn't on the card is rejected")
                       : bad(`forged word accepted with status ${res.status}`);
  } else {
    ok("(skipped forged-word check — 'traffic jam' happened to be dealt)");
  }
}

let roundId;
{
  const chosen = card.find(c => c.tier === "medium");
  const res = await fetch(BASE + "/api/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token, word: chosen.word, strokes, durationMs: 45000, width: 1200, height: 900
    })
  });
  const body = await res.json();
  roundId = body.roundId;

  body.ok ? ok(`a drawing of "${chosen.word}" was accepted and stored`)
          : bad("submit failed: " + JSON.stringify(body));

  body.posted === false
    ? ok("with no bot token the drawing is saved but not posted — work is never lost")
    : bad("expected posted:false without DISCORD_BOT_TOKEN");
}

{
  const chosen = card.find(c => c.tier === "medium");
  const res = await fetch(BASE + "/api/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, word: chosen.word, strokes, durationMs: 1000, width: 1200, height: 900 })
  });
  res.status === 409 ? ok("a session cannot be reused to post twice")
                     : bad(`expected 409 on reuse, got ${res.status}`);
}

// ---------------------------------------------------------------- watch

{
  const res = await fetch(`${BASE}/api/watch/${roundId}`);
  const view = await res.json();
  const answer = card.find(c => c.tier === "medium").word;

  view.word === undefined ? ok("the watch endpoint withholds the answer")
                          : bad("the watch endpoint leaked the answer");

  JSON.stringify(view).includes(answer)
    ? bad("the answer appeared somewhere in the watch payload")
    : ok("the answer appears nowhere in the watch payload");

  view.mask?.length > 0 ? ok("the watch endpoint shares the letter mask")
                        : bad("no mask in watch payload");
}

{
  // The "Watch it draw" button on every channel post points here.
  const res  = await fetch(`${BASE}/watch/${roundId}`);
  const html = await res.text();

  res.ok && /<canvas/.test(html)
    ? ok("the Watch it draw link opens a real replay page")
    : bad(`/watch/… returned ${res.status} with no canvas`);

  // The page fetches the round itself, so the answer must not be in the HTML.
  const answer = card.find(c => c.tier === "medium").word;
  html.includes(answer)
    ? bad("the replay page has the answer baked into its markup")
    : ok("the replay page ships no answer in its markup");
}

// ---------------------------------------------------------------- guessing

{
  const res = await interact({
    type: 3, data: { custom_id: `guess:${roundId}` }, ...asUser("tapps")
  });
  const body = await res.json();
  /no guessing your own/i.test(body.data?.content ?? "")
    ? ok("the drawer is blocked from guessing their own drawing over HTTP")
    : bad("drawer was allowed to guess: " + JSON.stringify(body));
}

{
  const res = await interact({
    type: 3, data: { custom_id: `guess:${roundId}` }, ...asUser("sarah")
  });
  const body = await res.json();
  body.type === 9 ? ok("another player gets the guess modal")
                  : bad("expected a modal, got " + JSON.stringify(body));
}

{
  const res = await interact({
    type: 5,
    data: { custom_id: `guess:${roundId}`, components: [{ components: [{ value: "definitely wrong" }] }] },
    ...asUser("sarah")
  });
  const body = await res.json();
  body.data.flags === 64 && /nothing lost/i.test(body.data.content)
    ? ok("a wrong guess is private and costs nothing")
    : bad("wrong guess handled oddly: " + JSON.stringify(body));
}

{
  const answer = card.find(c => c.tier === "medium").word;
  const res = await interact({
    type: 5,
    data: { custom_id: `guess:${roundId}`, components: [{ components: [{ value: answer }] }] },
    ...asUser("sarah")
  });
  const body = await res.json();

  /Correct/.test(body.data.content) ? ok("the right answer is accepted and scored")
                                    : bad("correct guess rejected: " + JSON.stringify(body));
  body.data.flags === 0 ? ok("a correct answer is announced to the channel")
                        : bad("correct answer was kept private");
}

{
  const answer = card.find(c => c.tier === "medium").word;
  const res = await interact({
    type: 5,
    data: { custom_id: `guess:${roundId}`, components: [{ components: [{ value: answer }] }] },
    ...asUser("sarah")
  });
  const body = await res.json();
  /already got this one/i.test(body.data.content)
    ? ok("nobody can score the same round twice")
    : bad("double scoring allowed: " + JSON.stringify(body));
}

// ---------------------------------------------------------------- persistence

{
  const round = await store.getRound(roundId);
  round.solvers.length === 1 && round.solvers[0] === "sarah"
    ? ok("the solve was written to the database")
    : bad("solver not persisted: " + JSON.stringify(round.solvers));

  round.guesses.length === 2
    ? ok("both the wrong and right guesses were recorded")
    : bad(`expected 2 guesses, got ${round.guesses.length}`);

  round.drawing.strokes[0].p.length === 200
    ? ok("stroke data round-tripped through SQLite intact")
    : bad("stroke data was corrupted in storage");
}

{
  const res = await interact({ type: 2, data: { name: "scores" }, ...asUser("tapps") });
  const body = await res.json();
  /sarah/.test(body.data.content) ? ok("/scores shows the solver on the leaderboard")
                                  : bad("leaderboard missing solver: " + body.data.content);
  body.data.flags === 0 ? ok("the leaderboard is public")
                        : bad("leaderboard was ephemeral");
}

// ---------------------------------------------------------------- who's watching

/*
 * The replay page has to tell a solver from a stranger. A URL sitting in a
 * channel cannot do that — it is the same URL for everybody — so the button
 * is an interaction and the link it hands back is personal.
 */

const watchLink = async (who, id = roundId) => {
  const res = await interact({ type: 3, data: { custom_id: `watch:${id}` }, ...who });
  const body = await res.json();
  return body.data?.components?.[0]?.components?.[0]?.url ?? "";
};

const grantIn = link => link ? new URL(link).searchParams.get("g") : null;

/**
 * Opens a grant link the way a browser would, without following the redirect,
 * and hands back the cookie it was given.
 */
async function redeem(link) {
  const res = await fetch(link, { redirect: "manual" });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const value = /dt_viewer=([^;]+)/.exec(setCookie)?.[1] ?? null;
  return { res, setCookie, cookie: value ? `dt_viewer=${value}` : null };
}

const asViewer = cookie => cookie ? { headers: { cookie } } : {};

let sarahCookie, evanCookie;
const answer = card.find(c => c.tier === "medium").word;

{
  const link = await watchLink(asUser("sarah"));

  grantIn(link) ? ok("pressing Watch it draw hands back a personal replay link")
                : bad("no grant issued");

  const { res, setCookie, cookie } = await redeem(link);
  sarahCookie = cookie;

  // The redirect is the whole trick: the credential moves out of the URL and
  // into a cookie the page cannot read and nobody can paste.
  res.status === 302
    ? ok("opening the link redirects rather than rendering with a token in the URL")
    : bad(`expected a 302 exchange, got ${res.status}`);

  const location = res.headers.get("location") ?? "";
  !location.includes("g=") && location === `/watch/${roundId}`
    ? ok("it lands on a clean URL with nothing left in the query string")
    : bad("the redirect kept a credential: " + location);

  cookie ? ok("the exchange sets a viewer cookie")
         : bad("no cookie was set: " + setCookie);

  /HttpOnly/i.test(setCookie)
    ? ok("the cookie is HttpOnly — script cannot read it, so it cannot be pasted")
    : bad("the cookie is readable by script: " + setCookie);

  /SameSite=/i.test(setCookie)
    ? ok("the cookie declares a SameSite policy")
    : bad("no SameSite on the cookie: " + setCookie);
}

{
  /*
   * The bug this whole design exists to kill: someone pastes their own replay
   * link into the channel to show people the drawing, and everyone who clicks
   * it is treated as them.
   */
  const link = await watchLink(asUser("sarah"));
  await redeem(link);                       // sarah opens it herself

  const { res, cookie } = await redeem(link);   // somebody else opens the paste

  cookie === null
    ? ok("a link that has already been opened hands out nothing to the next person")
    : bad("a pasted link minted a second session — the original leak is still open");

  res.status === 302
    ? ok("the stale link still lands on the page, just without an identity")
    : bad(`a spent link should still render the page, got ${res.status}`);

  const anon = await (await fetch(`${BASE}/api/watch/${roundId}`)).json();
  anon.word === undefined && anon.you === undefined && anon.canStartDrawing === false
    ? ok("and that stranger gets the strictest possible view")
    : bad("an unidentified viewer was given more than they should have");
}

{
  const forged = await redeem(`${BASE}/watch/${roundId}?g=not-a-real-grant`);
  forged.cookie === null
    ? ok("an invented grant buys nothing")
    : bad("a forged grant was honoured");
}

{
  const link = await watchLink(asUser("evan"));
  evanCookie = (await redeem(link)).cookie;

  evanCookie && evanCookie !== sarahCookie
    ? ok("two people pressing the same button end up with two different cookies")
    : bad("viewer cookies are not per-person");
}

{
  // sarah solved it earlier; evan has not
  const solved = await (await fetch(`${BASE}/api/watch/${roundId}`, asViewer(sarahCookie))).json();

  solved.word === answer
    ? ok("a solver reopening the replay sees the answer they earned")
    : bad("the answer was withheld from someone who had solved it");

  solved.you?.solved === true && solved.you.awarded > 0
    ? ok("the replay reports what that viewer scored on this round")
    : bad("no personal result: " + JSON.stringify(solved.you));

  const stranger = await (await fetch(`${BASE}/api/watch/${roundId}`, asViewer(evanCookie))).json();
  stranger.word === undefined && !JSON.stringify(stranger).includes(answer)
    ? ok("someone else's cookie does not reveal the answer")
    : bad("the answer leaked to a non-solver holding a valid cookie");

  stranger.you?.attempts === 0
    ? ok("a viewer's summary describes only their own attempts")
    : bad("summary leaked other people's play: " + JSON.stringify(stranger.you));
}

let secondRoundId;
{
  /*
   * Identity is a person, not a drawing. Being recognised on one replay has
   * to carry to the next one, or a busy server means pressing the button
   * again for every single post.
   */
  const other = await interact({ type: 2, data: { name: "draw" }, ...asUser("jonah") });
  const otherToken = new URL(
    (await other.json()).data.components[0].components[0].url
  ).searchParams.get("t");

  const otherCard = (await (await fetch(`${BASE}/api/session?t=${otherToken}`)).json()).card;
  const pick = otherCard.find(c => c.tier === "hard");

  const submitted = await (await fetch(`${BASE}/api/submit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: otherToken, word: pick.word, strokes,
      durationMs: 1000, width: 1200, height: 900
    })
  })).json();
  secondRoundId = submitted.roundId;

  const view = await (await fetch(`${BASE}/api/watch/${secondRoundId}`, asViewer(sarahCookie))).json();

  view.canStartDrawing === true && view.you?.solved === false
    ? ok("one cookie identifies you on every round, without pressing again")
    : bad("identity did not carry across rounds: " + JSON.stringify(view.you));

  view.word === undefined
    ? ok("carrying across rounds does not carry the answers with it")
    : bad("a cookie unlocked a round its owner had not solved");
}

// ---------------------------------------------------------------- your turn

{
  /*
   * The CTA on the replay page. Someone who clicked back into the game gets
   * handed a canvas without having to go and find the slash command.
   */
  const res = await fetch(`${BASE}/api/draw-session`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sarahCookie },
    body: JSON.stringify({ roundId })
  });
  const body = await res.json();

  res.ok && /^\/draw\?t=/.test(body.url ?? "")
    ? ok("the viewer cookie can be traded for a fresh canvas")
    : bad("no canvas offered: " + JSON.stringify(body));

  const t = new URL(body.url, BASE).searchParams.get("t");
  const session = await (await fetch(`${BASE}/api/session?t=${t}`)).json();

  session.userId === "sarah"
    ? ok("the new canvas belongs to whoever holds the cookie")
    : bad("wrong user on the minted session: " + session.userId);

  session.card?.length === 3
    ? ok("the new canvas is dealt a full card, server-side as always")
    : bad("no card dealt");
}

{
  const res = await fetch(`${BASE}/api/draw-session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ roundId })
  });
  res.status === 401
    ? ok("no cookie, no canvas")
    : bad(`expected 401 without a cookie, got ${res.status}`);
}

{
  const res = await fetch(`${BASE}/api/draw-session`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "dt_viewer=not-a-real-session" },
    body: JSON.stringify({ roundId })
  });
  res.status === 401
    ? ok("a forged cookie cannot mint a drawing session")
    : bad(`expected 401 for a bogus cookie, got ${res.status}`);
}

// ---------------------------------------------------------------- moderation

{
  await interact({ type: 3, data: { custom_id: `flag:${roundId}` }, ...asUser("sarah") });
  const res = await interact({ type: 3, data: { custom_id: `flag:${roundId}` }, ...asUser("jonah") });
  const body = await res.json();

  /hidden while a moderator/i.test(body.data.content)
    ? ok("two reports hide the drawing pending review")
    : bad("flagging did not hide: " + body.data.content);

  const round = await store.getRound(roundId);
  round.status === "hidden" ? ok("the hidden status persisted")
                            : bad(`status is ${round.status}`);
}

{
  const res = await interact({ type: 3, data: { custom_id: `guess:${roundId}` }, ...asUser("evan") });
  const body = await res.json();
  /hidden/i.test(body.data.content) ? ok("a hidden drawing cannot be guessed")
                                    : bad("hidden drawing still guessable");
}

// ---------------------------------------------------------------- teardown

server.close();
store.close();
rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nFull round-trip works end to end");
process.exit(failures ? 1 : 0);
