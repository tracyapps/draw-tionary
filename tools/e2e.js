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
  /*
   * 19456 = View Channel (1024) + Send Messages (2048) + Embed Links (16384).
   *
   * View Channel is the one that gets forgotten, because the bot only posts
   * and never reads. But a channel you cannot see is a channel you cannot post
   * to, and Discord reports that as 50001 "Missing Access" — which reads like
   * the bot is missing from the server rather than missing one checkbox.
   */
  /permissions=19456/.test(invite) && /scope=bot(%20|\+)applications\.commands/.test(invite)
    ? ok("the invite asks for View Channel + Send Messages + Embed Links, and nothing else")
    : bad("invite link has the wrong scopes or permissions: " + invite);

  !/permissions=18432/.test(invite)
    ? ok("the invite is not missing View Channel — the 50001 trap")
    : bad("invite omits View Channel; posting will fail with Missing Access");

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

let secondRoundId, secondAnswer;
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
  secondAnswer  = pick.word;

  const view = await (await fetch(`${BASE}/api/watch/${secondRoundId}`, asViewer(sarahCookie))).json();

  view.canStartDrawing === true && view.you?.solved === false
    ? ok("one cookie identifies you on every round, without pressing again")
    : bad("identity did not carry across rounds: " + JSON.stringify(view.you));

  view.word === undefined
    ? ok("carrying across rounds does not carry the answers with it")
    : bad("a cookie unlocked a round its owner had not solved");
}

// ---------------------------------------------------------------- guessing from the page

/*
 * The same act as the Discord modal, through the other door. Both end in
 * recordGuess, so what matters here is the door: who the server thinks you
 * are, what it refuses, and that nothing on the way in reveals the answer.
 */
{
  const nap = ms => new Promise(r => setTimeout(r, ms));

  const guess = (cookie, guessText, roundId = secondRoundId) =>
    fetch(`${BASE}/api/guess`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ roundId, guess: guessText })
    });

  {
    const res = await guess(null, secondAnswer);
    res.status === 401
      ? ok("a guess without a cookie is refused, however right it is")
      : bad(`an anonymous guess was accepted: ${res.status}`);
  }

  {
    const res  = await guess(sarahCookie, "definitely not the word");
    const body = await res.json();

    res.ok && body.correct === false
      ? ok("a wrong guess from the page comes back as a wrong guess, not an error")
      : bad("wrong guess mishandled: " + JSON.stringify(body));

    !JSON.stringify(body).includes(secondAnswer)
      ? ok("and the response says nothing about what the answer actually is")
      : bad("the answer leaked in a wrong-guess response");
  }

  {
    // Free to guess, but not free to be scripted: the word list is finite and
    // isCorrect forgives typos, so a machine with no floor would walk it.
    const res = await guess(sarahCookie, "another wrong one");
    res.status === 429
      ? ok("guesses fired back to back are throttled, so the list cannot be walked")
      : bad(`expected a 429 on an instant retry, got ${res.status}`);
  }

  await nap(800);

  {
    const res  = await guess(sarahCookie, secondAnswer);
    const body = await res.json();

    res.ok && body.correct === true && body.word === secondAnswer
      ? ok("the right answer from the page is accepted and the word revealed")
      : bad("correct guess not accepted: " + JSON.stringify(body));

    body.awarded > 0 && body.solverIndex === 0
      ? ok("it scores, and knows they were first")
      : bad("no score on a correct guess: " + JSON.stringify(body));
  }

  {
    const view = await (await fetch(`${BASE}/api/watch/${secondRoundId}`, asViewer(sarahCookie))).json();
    view.you?.solved === true && view.word === secondAnswer
      ? ok("the solve is attributed to the cookie holder, not to anything the body claimed")
      : bad("solve landed on the wrong person: " + JSON.stringify(view.you));
  }

  await nap(800);

  {
    const res  = await guess(sarahCookie, secondAnswer);
    const body = await res.json();

    res.status === 409 && /already/i.test(body.error ?? "")
      ? ok("guessing a round you have already solved is refused, so it cannot be farmed")
      : bad(`a second solve was allowed: ${res.status} ${JSON.stringify(body)}`);
  }

  {
    // jonah drew this one. The drawer knows the word by definition.
    const link = await watchLink(asUser("jonah"), secondRoundId);
    const jonahCookie = (await redeem(link)).cookie;

    const res  = await guess(jonahCookie, secondAnswer);
    const body = await res.json();

    res.status === 409
      ? ok("the drawer cannot guess their own drawing from the page either")
      : bad(`the drawer scored on their own round: ${res.status} ${JSON.stringify(body)}`);
  }

  await nap(800);

  {
    const res = await guess(sarahCookie, "   ", secondRoundId);
    res.status === 400
      ? ok("an empty guess is rejected before it becomes an attempt")
      : bad(`whitespace was accepted as a guess: ${res.status}`);
  }

  {
    const res = await guess(sarahCookie, "anything", "no-such-round");
    res.status === 404
      ? ok("a guess at a round that does not exist is a 404, not a crash")
      : bad(`expected 404 for an unknown round, got ${res.status}`);
  }
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
