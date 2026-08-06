import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { verifyRequest, publicKeyFromHex, isFresh } from "./verify.js";
import {
  TYPE, REPLY, customId, parseCustomId, handleInteraction, guessModal, drawingPost
} from "./interactions.js";
import {
  createRound, submitDrawing, recordGuess, flagRound, removeRound, STATUS
} from "./rounds.js";

const words = JSON.parse(readFileSync(new URL("../data/words.json", import.meta.url)));

// ---------------------------------------------------------------- signature

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_HEX = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const signFor = (ts, body) =>
  cryptoSign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString("hex");

test("a genuine Discord signature verifies", () => {
  const ts = "1700000000";
  const body = JSON.stringify({ type: 1 });
  assert.equal(
    verifyRequest({ rawBody: body, signature: signFor(ts, body), timestamp: ts, publicKey: PUB_HEX }),
    true
  );
});

test("a tampered body is rejected", () => {
  const ts = "1700000000";
  const body = JSON.stringify({ type: 1 });
  const sig = signFor(ts, body);

  const tampered = JSON.stringify({ type: 2, data: { name: "draw" } });
  assert.equal(
    verifyRequest({ rawBody: tampered, signature: sig, timestamp: ts, publicKey: PUB_HEX }),
    false
  );
});

test("a replayed signature with a different timestamp is rejected", () => {
  const body = JSON.stringify({ type: 1 });
  const sig = signFor("1700000000", body);
  assert.equal(
    verifyRequest({ rawBody: body, signature: sig, timestamp: "1700000001", publicKey: PUB_HEX }),
    false
  );
});

test("a signature from the wrong key is rejected", () => {
  const other = generateKeyPairSync("ed25519");
  const ts = "1700000000";
  const body = JSON.stringify({ type: 1 });
  const sig = cryptoSign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), other.privateKey)
    .toString("hex");

  assert.equal(verifyRequest({ rawBody: body, signature: sig, timestamp: ts, publicKey: PUB_HEX }), false);
});

test("malformed input is rejected rather than throwing", () => {
  const cases = [
    { rawBody: "", signature: "aa", timestamp: "1" },
    { rawBody: "{}", signature: "", timestamp: "1" },
    { rawBody: "{}", signature: "zz".repeat(64), timestamp: "1" },
    { rawBody: "{}", signature: "ab", timestamp: "1" },
    { rawBody: "{}", signature: null, timestamp: null }
  ];
  for (const c of cases) {
    assert.equal(verifyRequest({ ...c, publicKey: PUB_HEX }), false, JSON.stringify(c));
  }
});

test("a bad public key is a configuration error, not a silent pass", () => {
  assert.throws(() => publicKeyFromHex("nope"), /64 hex/);
  assert.throws(() => publicKeyFromHex(""), /64 hex/);
  // and verifyRequest degrades to false rather than crashing the server
  assert.equal(verifyRequest({ rawBody: "{}", signature: "a".repeat(128), timestamp: "1", publicKey: "bad" }), false);
});

test("stale timestamps are caught so captured requests cannot be replayed forever", () => {
  const now = 1_700_000_000_000;
  assert.equal(isFresh("1700000000", { now }), true);
  assert.equal(isFresh("1699999800", { now }), true);           // 200s ago
  assert.equal(isFresh("1699999000", { now }), false);          // 1000s ago
  assert.equal(isFresh("not-a-number", { now }), false);
});

// ---------------------------------------------------------------- store stub

function makeStore() {
  const rounds = new Map();
  const sessions = new Map();
  const intents = new Map();
  const views = new Map();
  const scores = new Map();
  let seq = 0;

  return {
    rounds, sessions, views, intents, scores,
    async recentWords() { return []; },
    async createSession(s) {
      const token = "tok" + (++seq);
      sessions.set(token, { ...s, token });
      return token;
    },
    async getSession(t) { return sessions.get(t) ?? null; },

    async setLaunchIntent(s) {
      intents.set(s.userId + "|" + s.channelId, { ...s });
    },
    async getLaunchIntent(userId, channelId) {
      return intents.get(userId + "|" + channelId) ?? null;
    },
    async clearLaunchIntent(userId, channelId) {
      return intents.delete(userId + "|" + channelId);
    },

    async createViewGrant(s) {
      // Mirrors the real store's one-grant-per-viewer-per-round rule.
      for (const [t, v] of views) {
        if (v.roundId === s.roundId && v.userId === s.userId) views.delete(t);
      }
      const token = "grant" + (++seq);
      views.set(token, { ...s, token });
      return token;
    },
    async consumeViewGrant(t) {
      const g = views.get(t);
      if (!g) return null;
      views.delete(t);            // single use
      return g;
    },
    /** Read without spending, for tests that just want to inspect a grant. */
    async peekViewGrant(t) { return views.get(t) ?? null; },
    async getRound(id) { return rounds.get(id) ?? null; },
    async saveRound(r) { rounds.set(r.id, r); return r; },
    async applyScores(guildId, map) {
      for (const [u, p] of map) scores.set(u, p);
    },
    async scoreboard() {
      return [...scores.entries()].map(([userId, points]) => ({ userId, points }))
        .sort((a, b) => b.points - a.points);
    }
  };
}

const ctxFor = (store, over = {}) => ({
  store, words, drawUrl: "https://example.test", now: () => 1_700_000_000_000, ...over
});

/** The same context with Activities switched on. */
const asActivity = store => ctxFor(store, { activityEnabled: true });

const asUser = (id, extra = {}) => ({
  guild_id: "g1", channel_id: "c1",
  member: { user: { id }, permissions: "0" },
  ...extra
});

const asMod = id => ({
  guild_id: "g1", channel_id: "c1",
  member: { user: { id }, permissions: "8192" }   // MANAGE_MESSAGES
});

async function seededRound(store, over = {}) {
  let r = createRound({
    id: "r1", drawerId: "tapps", word: "lighthouse",
    tier: "medium", points: 20, at: 1_699_999_000_000, ...over
  });
  r = submitDrawing(r, {
    strokes: [{ color: "#000", size: 6, erase: false, pts: [{ x: .1, y: .1, p: .5, t: 0 }] }],
    durationMs: 60000, at: 1_699_999_990_000
  }).round;
  await store.saveRound(r);
  return r;
}

// ---------------------------------------------------------------- routing

test("PING is answered with PONG", async () => {
  const res = await handleInteraction({ type: TYPE.PING }, ctxFor(makeStore()));
  assert.deepEqual(res, { type: REPLY.PONG });
});

test("custom ids round-trip, including ids containing a colon", () => {
  assert.equal(customId("guess", "r1"), "guess:r1");
  assert.deepEqual(parseCustomId("guess:r1"), { action: "guess", roundId: "r1" });
  assert.deepEqual(parseCustomId("guess:a:b:c"), { action: "guess", roundId: "a:b:c" });
  assert.ok(customId("guess", "r".repeat(60)).length <= 100, "custom_id exceeds Discord's limit");
});

// ---------------------------------------------------------------- /draw

test("/draw mints a private session and links to the canvas", async () => {
  const store = makeStore();
  const res = await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("tapps") },
    ctxFor(store)
  );

  assert.equal(res.type, REPLY.MESSAGE);
  assert.equal(res.data.flags, 64, "the canvas link must be ephemeral");

  const url = res.data.components[0].components[0].url;
  assert.match(url, /\/draw\?t=tok1$/);
  assert.equal(store.sessions.size, 1);
});

test("the card is dealt server-side so points cannot be forged", async () => {
  const store = makeStore();
  await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("tapps") },
    ctxFor(store)
  );

  const session = [...store.sessions.values()][0];
  assert.equal(session.card.length, 3);
  assert.deepEqual(session.card.map(c => c.tier), ["easy", "medium", "hard"]);

  // every option really came from the word list at the right points value
  for (const c of session.card) {
    assert.ok(words.tiers[c.tier].words.includes(c.word), `${c.word} is not in ${c.tier}`);
    assert.equal(c.points, words.tiers[c.tier].points);
  }
});

test("a session is bound to one user and expires", async () => {
  const store = makeStore();
  await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("tapps") },
    ctxFor(store)
  );
  const s = [...store.sessions.values()][0];
  assert.equal(s.userId, "tapps");
  assert.ok(s.expiresAt > s.issuedAt);
  assert.equal(s.expiresAt - s.issuedAt, 30 * 60 * 1000);
});

// ---------------------------------------------------------------- guessing

test("the Guess button opens a modal telling you the letter count", async () => {
  const store = makeStore();
  const round = await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("sarah") },
    ctxFor(store)
  );

  assert.equal(res.type, REPLY.MODAL);
  assert.equal(res.data.components[0].components[0].label, "10 letters");
  assert.equal(JSON.stringify(res).includes("lighthouse"), false, "the modal leaked the answer");
});

test("the modal placeholder shows the shape without the letters", () => {
  const round = createRound({
    id: "r", drawerId: "d", word: "hot air balloon", tier: "medium", points: 20, at: 0
  });
  const m = guessModal(round);
  const ph = m.data.components[0].components[0].placeholder;

  assert.equal(ph, "••• ••• •••••••");
  assert.equal(ph.includes("h"), false);
});

test("the drawer cannot open the guess modal for their own drawing", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("tapps") },
    ctxFor(store)
  );

  assert.equal(res.type, REPLY.MESSAGE);
  assert.match(res.data.content, /no guessing your own/i);
});

test("a correct guess scores, announces publicly, and records the solver", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction({
    type: TYPE.MODAL_SUBMIT,
    data: { custom_id: "guess:r1", components: [{ components: [{ value: "lighthouse" }] }] },
    ...asUser("sarah")
  }, ctxFor(store));

  assert.match(res.data.content, /Correct/);
  assert.match(res.data.content, /lighthouse/);
  assert.equal(res.data.flags, 0, "a correct answer should be visible to the channel");
  assert.deepEqual(store.rounds.get("r1").solvers, ["sarah"]);
  assert.ok(store.scores.get("sarah") > 0);
});

test("a wrong guess is private, kind, and costs nothing", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction({
    type: TYPE.MODAL_SUBMIT,
    data: { custom_id: "guess:r1", components: [{ components: [{ value: "windmill" }] }] },
    ...asUser("sarah")
  }, ctxFor(store));

  assert.equal(res.data.flags, 64, "a wrong guess should not be broadcast");
  assert.match(res.data.content, /nothing lost/i);
  assert.equal(store.rounds.get("r1").solvers.length, 0);
  assert.equal(store.scores.size, 0);
});

test("typos still count through the modal", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction({
    type: TYPE.MODAL_SUBMIT,
    data: { custom_id: "guess:r1", components: [{ components: [{ value: "  LightHosue " }] }] },
    ...asUser("sarah")
  }, ctxFor(store));

  assert.match(res.data.content, /Correct/);
});

test("guessing a round that no longer exists fails gracefully", async () => {
  const res = await handleInteraction({
    type: TYPE.MODAL_SUBMIT,
    data: { custom_id: "guess:nope", components: [{ components: [{ value: "cat" }] }] },
    ...asUser("sarah")
  }, ctxFor(makeStore()));

  assert.match(res.data.content, /no longer around/i);
});

// ---------------------------------------------------------------- flagging

test("any player can flag, and one flag does not hide anything", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "flag:r1" }, ...asUser("sarah") },
    ctxFor(store)
  );

  assert.match(res.data.content, /moderator will take a look/i);
  assert.equal(store.rounds.get("r1").status, STATUS.OPEN);
});

test("two flags hide the drawing and stop further guesses", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  await handleInteraction({ type: TYPE.COMPONENT, data: { custom_id: "flag:r1" }, ...asUser("sarah") }, ctx);
  const res = await handleInteraction({ type: TYPE.COMPONENT, data: { custom_id: "flag:r1" }, ...asUser("jonah") }, ctx);

  assert.match(res.data.content, /hidden while a moderator/i);
  assert.equal(store.rounds.get("r1").status, STATUS.HIDDEN);

  const blocked = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("evan") }, ctx
  );
  assert.equal(blocked.type, REPLY.MESSAGE);
  assert.match(blocked.data.content, /hidden/i);
});

test("flagging never reveals who reported it", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  await handleInteraction({ type: TYPE.COMPONENT, data: { custom_id: "flag:r1" }, ...asUser("sarah") }, ctx);
  const res = await handleInteraction({ type: TYPE.COMPONENT, data: { custom_id: "flag:r1" }, ...asUser("jonah") }, ctx);

  assert.equal(res.data.content.includes("sarah"), false);
  assert.equal(res.data.content.includes("jonah"), false);
});

test("the drawer is pointed at delete rather than report", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "flag:r1" }, ...asUser("tapps") },
    ctxFor(store)
  );
  assert.match(res.data.content, /delete it/i);
});

// ---------------------------------------------------------------- deleting

test("the drawer can delete their own drawing", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "delete:r1" }, ...asUser("tapps") },
    ctxFor(store)
  );
  assert.match(res.data.content, /removed/i);
  assert.equal(store.rounds.get("r1").status, STATUS.REMOVED);
});

test("an ordinary player cannot delete someone else's drawing", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "delete:r1" }, ...asUser("sarah") },
    ctxFor(store)
  );
  assert.match(res.data.content, /Only the person who drew this/i);
  assert.equal(store.rounds.get("r1").status, STATUS.OPEN);
});

test("a moderator is recognised by their MANAGE_MESSAGES permission", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "delete:r1" }, ...asMod("mod") },
    ctxFor(store)
  );
  assert.match(res.data.content, /removed/i);
  assert.equal(store.rounds.get("r1").status, STATUS.REMOVED);
});

// ---------------------------------------------------------------- posts

test("the channel post never contains the answer", async () => {
  const store = makeStore();
  const round = await seededRound(store);

  const post = drawingPost(round);
  assert.equal(JSON.stringify(post).includes("lighthouse"), false);
  assert.match(post.embeds[0].description, /10 letters/);
});

test("the channel post offers guess, watch and report to everyone", async () => {
  const store = makeStore();
  const round = await seededRound(store);

  const post = drawingPost(round);
  const labels = post.components[0].components.map(c => c.label);
  assert.deepEqual(labels, ["Guess", "Watch it draw", "⚑"]);
});

test("no button in the channel post is a plain link", async () => {
  const store = makeStore();
  const round = await seededRound(store);

  /*
   * A link button is one URL for the whole channel, which is exactly what
   * makes it useless here — the replay could never tell who clicked, so a
   * solver would be shown the masked word they already beat.
   */
  const buttons = drawingPost(round).components[0].components;
  assert.equal(buttons.some(b => b.style === 5), false);
  assert.ok(buttons.every(b => b.custom_id));
});

test("buttons obey Discord's link-vs-action rules", async () => {
  const store = makeStore();
  const round = await seededRound(store);
  const buttons = drawingPost(round).components[0].components;

  for (const b of buttons) {
    assert.equal(b.type, 2);
    if (b.style === 5) {
      assert.ok(b.url, "a link button needs a url");
      assert.equal(b.custom_id, undefined, "a link button must not carry a custom_id");
    } else {
      assert.ok(b.custom_id, "an action button needs a custom_id");
      assert.equal(b.url, undefined, "an action button must not carry a url");
    }
  }
  assert.ok(buttons.length <= 5, "Discord allows at most 5 buttons per row");
});

// ---------------------------------------------------------------- /scores

test("/scores says something friendly when nobody has played", async () => {
  const res = await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "scores" }, ...asUser("tapps") },
    ctxFor(makeStore())
  );
  assert.match(res.data.content, /Nobody has scored yet/);
});

test("/scores posts publicly and ranks players", async () => {
  const store = makeStore();
  store.scores.set("sarah", 120);
  store.scores.set("jonah", 80);

  const res = await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "scores" }, ...asUser("tapps") },
    ctxFor(store)
  );

  assert.equal(res.data.flags, 0, "the leaderboard should be visible to everyone");
  assert.match(res.data.content, /🥇 <@sarah> — \*\*120\*\*/);
  assert.ok(res.data.content.indexOf("sarah") < res.data.content.indexOf("jonah"));
});

// ---------------------------------------------------------------- robustness

test("unknown commands and buttons do not crash the bot", async () => {
  const ctx = ctxFor(makeStore());

  for (const i of [
    { type: TYPE.COMMAND, data: { name: "nonsense" }, ...asUser("a") },
    { type: TYPE.COMPONENT, data: { custom_id: "nonsense:r1" }, ...asUser("a") },
    { type: 99, ...asUser("a") }
  ]) {
    const res = await handleInteraction(i, ctx);
    assert.equal(res.type, REPLY.MESSAGE);
    assert.ok(res.data.content.length > 0);
  }
});

test("an interaction with no identifiable user is handled", async () => {
  const res = await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, guild_id: "g1", channel_id: "c1" },
    ctxFor(makeStore())
  );
  assert.match(res.data.content, /couldn't tell who you are/i);
});

// ---------------------------------------------------------------- activity

test("with Activities off, nothing about the tested flow changes", async () => {
  const store = makeStore();
  const res = await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("tapps") },
    ctxFor(store)
  );

  // The link flow is the one that is proven end to end. It stays the default
  // until the Activity has been seen working inside a real Discord client.
  assert.equal(res.type, REPLY.MESSAGE);
  assert.match(res.data.components[0].components[0].url, /\/draw\?t=/);
  assert.equal(store.intents.size, 0, "no intent should be recorded when Activities are off");
});

test("/draw opens the Activity and records that a card is wanted", async () => {
  const store = makeStore();
  const res = await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("tapps") },
    asActivity(store)
  );

  assert.equal(res.type, REPLY.LAUNCH_ACTIVITY);
  assert.equal(res.type, 12, "Discord's callback type for opening an Activity");

  const intent = await store.getLaunchIntent("tapps", "c1");
  assert.equal(intent.kind, "draw");
  assert.equal(intent.roundId, undefined);
});

test("/draw as an Activity mints no session token — the frame deals its own", async () => {
  const store = makeStore();
  await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("tapps") },
    asActivity(store)
  );
  assert.equal(store.sessions.size, 0, "a link token would be pointless and leakable here");
});

test("pressing Guess opens the Activity on that drawing", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("nora") },
    asActivity(store)
  );

  assert.equal(res.type, REPLY.LAUNCH_ACTIVITY);

  const intent = await store.getLaunchIntent("nora", "c1");
  assert.equal(intent.kind, "guess");
  assert.equal(intent.roundId, "r1");
});

test("the intent is per person — two players don't collide in one channel", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = asActivity(store);

  await handleInteraction({ type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("nora") }, ctx);
  await handleInteraction({ type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("sam") }, ctx);

  assert.equal((await store.getLaunchIntent("nora", "c1")).kind, "guess");
  assert.equal((await store.getLaunchIntent("sam", "c1")).kind, "draw");
});

test("the last button pressed wins", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = asActivity(store);

  await handleInteraction({ type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("nora") }, ctx);
  await handleInteraction({ type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("nora") }, ctx);

  const intent = await store.getLaunchIntent("nora", "c1");
  assert.equal(intent.kind, "draw", "opening a fresh card should not land you on the old drawing");
});

test("the guards still apply before the Activity is opened", async () => {
  const store = makeStore();
  const round = await seededRound(store);
  const ctx = asActivity(store);

  // The drawer cannot guess their own word, Activity or not.
  const own = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("tapps") }, ctx
  );
  assert.equal(own.type, REPLY.MESSAGE);
  assert.match(own.data.content, /no guessing your own/i);
  assert.equal(await store.getLaunchIntent("tapps", "c1"), null);

  // Nor can anyone open a hidden drawing.
  await store.saveRound(flagRound(flagRound(round,
    { userId: "a", reason: "other", at: 1 }).round,
    { userId: "b", reason: "other", at: 2 }).round);

  const hidden = await handleInteraction(
    { type: TYPE.COMPONENT, data: { custom_id: "guess:r1" }, ...asUser("nora") }, ctx
  );
  assert.equal(hidden.type, REPLY.MESSAGE);
  assert.match(hidden.data.content, /moderator/i);
});

test("an intent expires rather than lingering forever", async () => {
  const store = makeStore();
  await handleInteraction(
    { type: TYPE.COMMAND, data: { name: "draw" }, ...asUser("tapps") },
    asActivity(store)
  );

  const intent = await store.getLaunchIntent("tapps", "c1");
  const life = intent.expiresAt - intent.at;
  assert.ok(life > 0 && life <= 15 * 60 * 1000,
    `intent should live minutes, not hours — got ${life}ms`);
});

// ---------------------------------------------------------------- watching

const pressWatch = (ctx, who = asUser("nora")) => handleInteraction(
  { type: TYPE.COMPONENT, data: { custom_id: "watch:r1" }, ...who }, ctx
);

const linkIn = res => res.data.components?.[0]?.components?.[0]?.url ?? "";

const grantIn = res => {
  const url = linkIn(res);
  return url ? new URL(url).searchParams.get("g") : null;
};

test("pressing Watch it draw hands back a private link", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  const res = await pressWatch(ctx);

  assert.equal(res.data.flags, 64, "the link must be ephemeral — it is one person's");
  assert.match(linkIn(res), /\/watch\/r1\?g=/);
});

test("the link carries a grant, not a durable credential", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  const token = grantIn(await pressWatch(ctx));

  /*
   * The thing in the URL has to be worth as little as possible, because it
   * ends up in browser history and — the case that actually happens — in a
   * message when someone pastes their own link back into the channel.
   */
  const grant = await store.peekViewGrant(token);
  assert.ok(grant.expiresAt - grant.issuedAt <= 2 * 60 * 1000,
    "a URL credential should last a minute or two, not a day");

  assert.ok(await store.consumeViewGrant(token), "the first use should work");
  assert.equal(await store.consumeViewGrant(token), null,
    "a second use — someone opening a pasted link — must get nothing");
});

test("the replay link is bound to whoever pressed the button", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  const view = await store.consumeViewGrant(grantIn(await pressWatch(ctx)));

  assert.equal(view.userId, "nora");
  assert.equal(view.roundId, "r1");
  assert.equal(view.isModerator, false);
});

test("two people pressing the same button get different links", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  const a = linkIn(await pressWatch(ctx, asUser("nora")));
  const b = linkIn(await pressWatch(ctx, asUser("sam")));

  assert.notEqual(a, b);
});

test("pressing it twice replaces your link rather than piling them up", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  const first  = grantIn(await pressWatch(ctx));
  const second = grantIn(await pressWatch(ctx));

  assert.notEqual(first, second);
  assert.equal(await store.peekViewGrant(first), null, "the old link should stop working");
  assert.ok(await store.peekViewGrant(second));
});

test("a moderator's link records the permission they had at press time", async () => {
  const store = makeStore();
  await seededRound(store);
  const ctx = ctxFor(store);

  const grant = await store.consumeViewGrant(grantIn(await pressWatch(ctx, asMod("mod"))));
  assert.equal(grant.isModerator, true);
});

test("a solver is told the answer will be on the replay", async () => {
  const store = makeStore();
  const round = await seededRound(store);
  const ctx = ctxFor(store);

  await store.saveRound(recordGuess(round, {
    userId: "nora", guess: "lighthouse", at: 1_700_000_000_000
  }).round);

  const res = await pressWatch(ctx);
  assert.match(res.data.content, /already know this one/i);
});

test("someone who hasn't solved it is promised no spoilers", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await pressWatch(ctxFor(store));
  assert.match(res.data.content, /no spoilers/i);
  assert.equal(res.data.content.includes("lighthouse"), false);
});

test("the drawer gets the answer on their own replay", async () => {
  const store = makeStore();
  await seededRound(store);

  const res = await pressWatch(ctxFor(store), asUser("tapps"));
  assert.match(res.data.content, /already know this one/i);
});

test("a hidden drawing hands out no replay link to ordinary players", async () => {
  const store = makeStore();
  const round = await seededRound(store);
  await store.saveRound(flagRound(flagRound(round,
    { userId: "a", reason: "other", at: 1 }).round,
    { userId: "b", reason: "other", at: 2 }).round);

  const res = await pressWatch(ctxFor(store));
  assert.equal(linkIn(res), "", "a hidden drawing must not be handed out");
  assert.match(res.data.content, /moderator/i);
});

test("a moderator can still open a hidden drawing to review it", async () => {
  const store = makeStore();
  const round = await seededRound(store);
  await store.saveRound(flagRound(flagRound(round,
    { userId: "a", reason: "other", at: 1 }).round,
    { userId: "b", reason: "other", at: 2 }).round);

  const res = await pressWatch(ctxFor(store), asMod("mod"));
  assert.match(linkIn(res), /\/watch\/r1\?g=/);
});

test("a removed drawing hands out no replay link at all", async () => {
  const store = makeStore();
  const round = await seededRound(store);
  await store.saveRound(removeRound(round,
    { userId: "tapps", isModerator: false, at: 3 }).round);

  const res = await pressWatch(ctxFor(store), asMod("mod"));
  assert.equal(linkIn(res), "");
  assert.match(res.data.content, /removed/i);
});
