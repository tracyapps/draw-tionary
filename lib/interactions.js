/*
 * Draw-tionary — Discord interaction router.
 *
 * Handles the HTTP interactions webhook: slash commands, button presses, and
 * modal submissions. Discord POSTs here and we reply in the response body,
 * so no gateway websocket and no always-on process are required.
 *
 * The store is injected rather than imported, which keeps this file free of
 * database and network code and means every path below is testable with a
 * plain object.
 */

import { dealCard, buildMask, letterCount } from "./game.js";
import {
  STATUS, createRound, submitDrawing, recordGuess, flagRound,
  removeRound, publicView, channelSummary, roundScores
} from "./rounds.js";

// ---------------------------------------------------------------- protocol

export const TYPE = {
  PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5
};

export const REPLY = {
  PONG: 1, MESSAGE: 4, DEFER: 5, DEFER_UPDATE: 6, UPDATE: 7, MODAL: 9,
  /*
   * Opens the app in an iframe instead of replying with text. Discord handles
   * the frame; all we do is choose this callback type. The Activity then has
   * to work out for itself why it was opened — see activity_intents.
   */
  LAUNCH_ACTIVITY: 12
};

/** How long the Activity has to ask what it was opened for. */
export const INTENT_TTL_MS = 10 * 60 * 1000;

const launchActivity = () => ({ type: REPLY.LAUNCH_ACTIVITY });

const EPHEMERAL = 64;

/** Custom ids are `action:roundId` — Discord caps them at 100 characters. */
export const customId = (action, roundId) => `${action}:${roundId}`;
export const parseCustomId = id => {
  const i = String(id).indexOf(":");
  return i < 0 ? { action: id, roundId: null } : { action: id.slice(0, i), roundId: id.slice(i + 1) };
};

const message = (content, { ephemeral = true, components = [], embeds = [] } = {}) => ({
  type: REPLY.MESSAGE,
  data: { content, components, embeds, flags: ephemeral ? EPHEMERAL : 0 }
});

// ---------------------------------------------------------------- session

export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Who sent this interaction — Discord puts it in different places. */
const actorOf = i => i.member?.user?.id ?? i.user?.id ?? null;

const isModerator = i => {
  // MANAGE_MESSAGES (0x2000). Discord sends permissions as a decimal string.
  const perms = BigInt(i.member?.permissions ?? "0");
  return (perms & 0x2000n) !== 0n;
};

// ---------------------------------------------------------------- channel post

/*
 * Branded art for the channel post.
 *
 * Deliberately NOT the drawing. The whole pleasure of this game is watching
 * the strokes appear while you guess, and a still of the finished picture in
 * the channel hands that away for free to anyone scrolling past. So the post
 * gets a fixed graphic that says "a round is happening" and nothing about
 * what was drawn.
 *
 * Sizes are what Discord renders, not what it accepts — it accepts far more
 * and scales down, which is how banners end up soft. Author icon is a hard
 * 24×24 circle. The banner displays about 400px wide, so the file wants to be
 * 800×300 for a 2x screen and will be letterboxed if it is much taller than
 * 4:3. Keep it under ~500KB; the 8MB ceiling is not a target.
 */
/*
 * Small grammar helpers. "1 points" and "a easy word" are the sort of thing
 * that makes a game feel unfinished, and both are one line to avoid.
 */
const count = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const article = word => (/^[aeiou]/i.test(word) ? "an" : "a");

const ART = {
  icon:   "/app/icon/icon-64.png",       // 24×24 rendered
  banner: "/app/img/post-banner.png"     // ~400px wide rendered; author at 800×300
};

export function drawingPost(round, { baseUrl = "" } = {}) {
  const s = channelSummary(round);

  const embed = {
    author: baseUrl ? { name: "Draw-tionary", icon_url: baseUrl + ART.icon } : undefined,
    title: "Someone drew something",
    /*
     * Deliberately NOT linked. An embed title can carry a url, and it was
     * tried — but the only url available here is a token-less one, because the
     * embed is a single message that every member reads. A per-user grant
     * cannot exist in it: whoever the token belonged to, everyone else who
     * clicked would inherit their identity.
     *
     * That leaves a link that silently behaves worse than the button beside
     * it — no answer for solvers who have earned it, no idea who is watching.
     * Two routes to the same screen that quietly differ is the kind of thing
     * people blame themselves for. One button, one behaviour.
     */
    /*
     * The call to action lives here as well as in the banner art, because the
     * art cannot carry it. Discord gives an embed image no alt text, so for
     * anyone using a screen reader the arrow and the words on the graphic
     * simply do not exist. Text is the only version of this instruction that
     * reaches everybody.
     *
     * "Use the Guess button" rather than tap or click: someone on a keyboard
     * does neither, and naming the wrong gesture is a small way of telling
     * them the game was not built for them.
     */
    description:
      `<@${s.drawerId}> drew ${article(s.tier)} **${s.tier}** word — ` +
      `${count(s.letters, "letter")}, worth ${count(s.points, "point")}.\n` +
      (s.solverCount
        ? `${count(s.solverCount, "person", "people")} ` +
          `${s.solverCount === 1 ? "has" : "have"} already solved it. ` +
          `Later guesses still score.\n`
        : `Nobody has solved it yet — the first correct guess earns a bonus.\n`) +
      `Use the **Guess** button below.`,
    color: { easy: 0x23a55a, medium: 0xf0b232, hard: 0xf23f43 }[s.tier] ?? 0x5865f2
  };

  /*
   * Only attach art when we know our own public URL. Discord silently drops an
   * embed whose image URL it cannot fetch, and a relative path is never
   * fetchable — better to post a plain embed than a broken-looking one.
   */
  if (baseUrl) embed.image = { url: baseUrl + ART.banner };

  return {
    embeds: [embed],
    components: [{
      type: 1,
      components: [
        // style 1 = primary, 2 = secondary, 5 = link. Link buttons carry a
        // url and must NOT carry a custom_id; the others are the reverse.
        //
        // "Watch it draw" is deliberately NOT a link button. One URL in a
        // channel is the same URL for everyone who clicks it, so the replay
        // page could never tell a solver from a stranger — and a solver who
        // has earned the answer should not be shown empty boxes. Making it an
        // interaction means Discord tells us who pressed, and we hand them a
        // link that is theirs.
        { type: 2, style: 1, label: "Guess", custom_id: customId("guess", round.id) },
        { type: 2, style: 2, label: "Watch it draw", custom_id: customId("watch", round.id) },
        { type: 2, style: 2, label: "⚑", custom_id: customId("flag", round.id) }
      ]
    }]
  };
}

/** The letter-box modal. */
export function guessModal(round) {
  const mask = buildMask(round.word);
  const n = letterCount(mask);

  // Discord modals are plain text inputs — no custom letter boxes. The mask
  // still does its job: we tell them the shape, accept letters only, and
  // reassemble the separators ourselves so they cannot get punctuation wrong.
  const shape = mask.map(s => (s.type === "letter" ? "•" : s.char)).join("");

  return {
    type: REPLY.MODAL,
    data: {
      custom_id: customId("guess", round.id),
      title: "What is it?",
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: "answer",
          label: `${n} letters`,
          style: 1,
          min_length: 1,
          max_length: Math.max(n + 8, 12),   // room for typed spaces we strip
          placeholder: shape.slice(0, 100),
          required: true
        }]
      }]
    }
  };
}

// ---------------------------------------------------------------- router

/**
 * @param interaction  the parsed interaction body from Discord
 * @param ctx          { store, words, drawUrl, now }
 */
export async function handleInteraction(interaction, ctx) {
  switch (interaction.type) {
    case TYPE.PING:         return { type: REPLY.PONG };
    case TYPE.COMMAND:      return handleCommand(interaction, ctx);
    case TYPE.COMPONENT:    return handleComponent(interaction, ctx);
    case TYPE.MODAL_SUBMIT: return handleModal(interaction, ctx);
    default:
      return message("I don't know how to handle that yet.");
  }
}

// ---------------------------------------------------------------- commands

async function handleCommand(i, ctx) {
  const name = i.data?.name;
  if (name === "draw")   return cmdDraw(i, ctx);
  if (name === "scores") return cmdScores(i, ctx);
  return message("Unknown command.");
}

async function cmdDraw(i, ctx) {
  const { store, words, drawUrl, now, activityEnabled } = ctx;
  const userId = actorOf(i);
  if (!userId) return message("I couldn't tell who you are — try again.");

  /*
   * As an Activity, the canvas opens in a frame and deals its own card once
   * it knows who is looking at it — there is no link and no session token to
   * mint here. All this has to do is record that a fresh card is wanted.
   */
  if (activityEnabled) {
    await store.setLaunchIntent({
      userId,
      guildId: i.guild_id,
      channelId: i.channel_id,
      kind: "draw",
      at: now(),
      expiresAt: now() + INTENT_TTL_MS
    });
    return launchActivity();
  }

  /*
   * The card is dealt HERE, on the server, and stored on the session.
   *
   * If the browser dealt its own card, nothing would stop someone editing
   * the request to claim a hard word's 35 points for drawing "cat". The
   * client is told which three words it may choose from; it does not get to
   * invent them.
   */
  const recent = await store.recentWords(i.guild_id, 40);
  const card = dealCard(words, { exclude: new Set(recent) });

  const token = await store.createSession({
    guildId: i.guild_id,
    channelId: i.channel_id,
    userId,
    card,
    issuedAt: now(),
    expiresAt: now() + SESSION_TTL_MS
  });

  return message(
    `Your canvas is ready — you have three words to choose from.\n` +
    `This link is just for you and expires in 30 minutes.`,
    {
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: "Open the canvas", url: `${drawUrl}/draw?t=${token}` }
        ]
      }]
    }
  );
}

async function cmdScores(i, ctx) {
  const board = await ctx.store.scoreboard(i.guild_id, 10);

  if (!board.length) {
    return message("Nobody has scored yet. Be the first — try `/draw`.");
  }

  const lines = board.map((e, n) =>
    `${["🥇", "🥈", "🥉"][n] ?? `${n + 1}.`} <@${e.userId}> — **${e.points}**`
  );

  return message(lines.join("\n"), { ephemeral: false });
}

// ---------------------------------------------------------------- components

async function handleComponent(i, ctx) {
  const { action, roundId } = parseCustomId(i.data?.custom_id);
  const round = await ctx.store.getRound(roundId);
  if (!round) return message("That drawing is no longer around.");

  const userId = actorOf(i);

  if (action === "guess")  return componentGuess(round, userId, i, ctx);
  if (action === "watch")  return componentWatch(round, userId, i, ctx);
  if (action === "flag")   return componentFlag(round, userId, i, ctx);
  if (action === "delete") return componentDelete(round, userId, i, ctx);

  return message("I don't know what that button does.");
}

async function componentGuess(round, userId, i, ctx) {
  if (userId === round.drawerId) {
    return message("You drew this one — no guessing your own. Nice try though.");
  }
  if (round.solvers.includes(userId)) {
    return message(`You already got this one: **${round.word}**`);
  }
  if (round.status !== STATUS.OPEN) {
    return message(
      round.status === STATUS.HIDDEN
        ? "This drawing is hidden while a moderator takes a look."
        : "This drawing has been removed."
    );
  }

  /*
   * As an Activity, guessing happens in the frame — where you can watch the
   * drawing replay while you think, and walk away into your own card if it
   * beats you. A modal can do neither.
   */
  if (ctx.activityEnabled) {
    await ctx.store.setLaunchIntent({
      userId,
      guildId: i.guild_id,
      channelId: i.channel_id,
      kind: "guess",
      roundId: round.id,
      at: ctx.now(),
      expiresAt: ctx.now() + INTENT_TTL_MS
    });
    return launchActivity();
  }

  return guessModal(round);
}

/*
 * How long the link in the ephemeral reply stays good for.
 *
 * Short on purpose. It is a bearer credential in a URL, and the only thing it
 * has to survive is the gap between Discord rendering the button and the
 * browser opening it. A minute is generous for that and useless to anyone who
 * finds it later.
 */
export const VIEW_GRANT_TTL_MS = 90 * 1000;

async function componentWatch(round, userId, i, ctx) {
  if (!userId) return message("I couldn't tell who you are — try again.");

  const moderator = isModerator(i);

  if (round.status === STATUS.HIDDEN && !moderator) {
    return message("This drawing is hidden while a moderator takes a look.");
  }
  if (round.status === STATUS.REMOVED) {
    return message("This drawing has been removed.");
  }

  const grant = await ctx.store.createViewGrant({
    roundId: round.id,
    userId,
    guildId: i.guild_id,
    channelId: i.channel_id,
    isModerator: moderator,
    issuedAt: ctx.now(),
    expiresAt: ctx.now() + VIEW_GRANT_TTL_MS
  });

  /*
   * Solvers get told they'll see the answer, because otherwise opening it
   * again looks like the game forgot they won.
   */
  const solved = round.solvers.includes(userId) || userId === round.drawerId;

  return message(
    solved
      ? "Here's the replay — you already know this one, so the answer's on it."
      : "Here's the replay. No spoilers, and watching it again costs nothing.",
    {
      components: [{
        type: 1,
        components: [
          { type: 2, style: 5, label: "Watch it draw",
            url: `${ctx.drawUrl}/watch/${round.id}?g=${grant}` }
        ]
      }]
    }
  );
}

async function componentFlag(round, userId, i, ctx) {
  if (userId === round.drawerId) {
    return message("This is your drawing — you can delete it instead of reporting it.");
  }

  const res = flagRound(round, { userId, reason: "other", at: ctx.now() });
  if (!res.ok) return message(res.error);

  await ctx.store.saveRound(res.round);

  if (res.alreadyFlagged) {
    return message("You've already reported this one. A moderator will take a look.");
  }
  if (res.hidden) {
    // Deliberately does not name who reported it.
    await ctx.store.notifyModerators?.(res.round, i.guild_id);
    return message("Thanks — this drawing is now hidden while a moderator reviews it.");
  }
  return message("Thanks for letting us know. A moderator will take a look.");
}

async function componentDelete(round, userId, i, ctx) {
  const res = removeRound(round, {
    userId,
    isModerator: isModerator(i),
    at: ctx.now()
  });

  if (!res.ok) return message(res.error);
  await ctx.store.saveRound(res.round);
  return message("Removed.");
}

// ---------------------------------------------------------------- modal

async function handleModal(i, ctx) {
  const { action, roundId } = parseCustomId(i.data?.custom_id);
  if (action !== "guess") return message("Unknown form.");

  const round = await ctx.store.getRound(roundId);
  if (!round) return message("That drawing is no longer around.");

  const userId = actorOf(i);
  const typed = i.data.components?.[0]?.components?.[0]?.value ?? "";

  const res = recordGuess(round, { userId, guess: typed, at: ctx.now() });
  if (!res.ok) return message(res.error);

  await ctx.store.saveRound(res.round);

  if (!res.correct) {
    return message(
      `**${typed.trim()}** isn't it — but nothing lost, guess as many times as you like.`
    );
  }

  await ctx.store.applyScores(i.guild_id, roundScores(res.round));

  const bonus = res.score.bonus
    ? `\n${res.score.base} + **${res.score.bonus} early bonus**`
    : "";

  return message(
    `Correct — it's **${round.word}**! You earned **${res.awarded}** points.${bonus}\n` +
    (res.solverIndex === 0
      ? "You were first."
      : `You were number ${res.solverIndex + 1} to get it.`),
    { ephemeral: false }
  );
}

export { publicView, createRound, submitDrawing };
