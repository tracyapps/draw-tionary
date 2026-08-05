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
  PONG: 1, MESSAGE: 4, DEFER: 5, DEFER_UPDATE: 6, UPDATE: 7, MODAL: 9
};

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

export function drawingPost(round) {
  const s = channelSummary(round);

  return {
    embeds: [{
      title: "Someone drew something",
      description:
        `<@${s.drawerId}> drew a **${s.tier}** word — ${s.letters} letters, worth **${s.points}** points.\n` +
        (s.solverCount
          ? `${s.solverCount} ${s.solverCount === 1 ? "person has" : "people have"} got it so far.`
          : "Nobody has guessed it yet."),
      color: { easy: 0x23a55a, medium: 0xf0b232, hard: 0xf23f43 }[s.tier] ?? 0x5865f2
    }],
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
  const { store, words, drawUrl, now } = ctx;
  const userId = actorOf(i);
  if (!userId) return message("I couldn't tell who you are — try again.");

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

  if (action === "guess")  return componentGuess(round, userId);
  if (action === "watch")  return componentWatch(round, userId, i, ctx);
  if (action === "flag")   return componentFlag(round, userId, i, ctx);
  if (action === "delete") return componentDelete(round, userId, i, ctx);

  return message("I don't know what that button does.");
}

function componentGuess(round, userId) {
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
