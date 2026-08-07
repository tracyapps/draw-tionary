/*
 * Draw-tionary — the round lifecycle.
 *
 * A "round" is one drawing: who drew it, what word, who has guessed, who has
 * flagged it, and what everyone earned. Every function here is pure — it takes
 * a round and returns a *new* round plus a result. Nothing touches a database,
 * Discord, or the clock; callers pass `at` explicitly.
 *
 * Keeping it pure is what makes the adversarial cases testable: someone
 * guessing their own drawing, solving twice, or reading the answer out of a
 * payload they shouldn't have.
 */

import { RULES, bonusWindowFor, scoreGuess, scoreDrawer, isCorrect, buildMask } from "./game.js";

// ---------------------------------------------------------------- states

export const STATUS = {
  /** Word chosen, still being drawn. Not visible to anyone else. */
  DRAFTING: "drafting",
  /** Posted to the channel. Open for guesses. */
  OPEN: "open",
  /** Auto-hidden by flags, awaiting a moderator. Guessing is closed. */
  HIDDEN: "hidden",
  /** Deleted by the drawer or removed by a moderator. Terminal. */
  REMOVED: "removed"
};

export const MOD = {
  /** How many distinct players must flag before a drawing auto-hides. */
  flagsToHide: 2,
  /**
   * Points already earned by *guessers* survive a removal — they did nothing
   * wrong, and clawing back their score would punish the wrong people. The
   * drawer's points for that round do not survive.
   */
  revokeDrawerPointsOnRemoval: true
};

export const REASONS = ["inappropriate", "spoiler", "not a real attempt", "other"];

// ---------------------------------------------------------------- create

export function createRound({ id, drawerId, word, tier, points, at }) {
  if (!id) throw new Error("round needs an id");
  if (!drawerId) throw new Error("round needs a drawerId");
  if (!word) throw new Error("round needs a word");

  return Object.freeze({
    id,
    drawerId,
    word,
    tier,
    points,
    status: STATUS.DRAFTING,

    createdAt: at,
    postedAt: null,
    closedAt: null,

    drawing: null,          // { strokes, durationMs, width, height }
    guesses: [],            // { userId, guess, correct, at, awarded }
    solvers: [],            // userIds in solve order
    flags: [],              // { userId, reason, at }

    removedBy: null,
    removedReason: null
  });
}

const next = (round, patch) => Object.freeze({ ...round, ...patch });

// ---------------------------------------------------------------- submit

export function submitDrawing(round, { strokes, durationMs, width, height, at }) {
  if (round.status !== STATUS.DRAFTING) {
    return { round, ok: false, error: "This drawing has already been posted." };
  }
  if (!Array.isArray(strokes) || strokes.length === 0) {
    return { round, ok: false, error: "Draw something first." };
  }

  return {
    ok: true,
    round: next(round, {
      status: STATUS.OPEN,
      postedAt: at,
      drawing: Object.freeze({ strokes, durationMs, width, height })
    })
  };
}

// ---------------------------------------------------------------- guessing

/** Can this user submit a guess right now, and if not, why not? */
export function canGuess(round, userId) {
  /*
   * No identity, no guess. Scoring has to land on somebody, and the replay
   * page is public — a stranger who was sent the link should be shown a
   * drawing, not a field that fails the moment they use it.
   */
  if (!userId)                          return { ok: false, reason: "unknown_who" };
  if (round.status === STATUS.DRAFTING) return { ok: false, reason: "not_posted" };
  if (round.status === STATUS.REMOVED)  return { ok: false, reason: "removed" };
  if (round.status === STATUS.HIDDEN)   return { ok: false, reason: "hidden" };
  if (userId === round.drawerId)        return { ok: false, reason: "own_drawing" };
  if (round.solvers.includes(userId))   return { ok: false, reason: "already_solved" };
  return { ok: true };
}

const GUESS_ERRORS = {
  unknown_who:    "I don't know who you are — press Guess in Discord to start again.",
  not_posted:     "This drawing isn't finished yet.",
  removed:        "This drawing has been removed.",
  hidden:         "This drawing is hidden while a moderator takes a look.",
  own_drawing:    "You drew this one — no guessing your own.",
  already_solved: "You already got this one."
};

/**
 * Record a guess. Wrong guesses are kept (they're part of the fun) but cost
 * nothing. Only the first solver can earn the early bonus.
 */
export function recordGuess(round, { userId, guess, at }) {
  const gate = canGuess(round, userId);
  if (!gate.ok) {
    return { round, ok: false, correct: false, error: GUESS_ERRORS[gate.reason], reason: gate.reason };
  }

  const correct = isCorrect(guess, round.word);
  const entry = { userId, guess: String(guess), correct, at, awarded: 0 };

  if (!correct) {
    return {
      ok: true,
      correct: false,
      awarded: 0,
      round: next(round, { guesses: [...round.guesses, entry] })
    };
  }

  const solverIndex = round.solvers.length;
  const score = scoreGuess({
    points: round.points,
    guessedAtMs: at - round.postedAt,
    bonusWindowMs: bonusWindowFor(round.tier),
    solverIndex
  });

  entry.awarded = score.total;

  return {
    ok: true,
    correct: true,
    awarded: score.total,
    score,
    solverIndex,
    round: next(round, {
      guesses: [...round.guesses, entry],
      solvers: [...round.solvers, userId]
    })
  };
}

// ---------------------------------------------------------------- moderation

/*
 * Flagging is available to every player, not just moderators. In a small
 * community the person who spots a problem is almost never the one holding
 * the mod role, and making them go find someone adds friction at exactly the
 * wrong moment.
 */
export function flagRound(round, { userId, reason = "other", at }) {
  if (round.status === STATUS.REMOVED) {
    return { round, ok: false, error: "This drawing has already been removed." };
  }
  if (round.flags.some(f => f.userId === userId)) {
    // Idempotent rather than an error — re-flagging is usually an anxious
    // double-tap, not an attempt to game the threshold.
    return { round, ok: true, alreadyFlagged: true, hidden: round.status === STATUS.HIDDEN };
  }

  const flags = [...round.flags, { userId, reason, at }];
  const hide = flags.length >= MOD.flagsToHide && round.status === STATUS.OPEN;

  return {
    ok: true,
    alreadyFlagged: false,
    hidden: hide || round.status === STATUS.HIDDEN,
    flagCount: flags.length,
    round: next(round, { flags, status: hide ? STATUS.HIDDEN : round.status })
  };
}

/** A moderator clearing a false alarm. */
export function restoreRound(round, { moderatorId, at }) {
  if (round.status !== STATUS.HIDDEN) {
    return { round, ok: false, error: "That drawing isn't hidden." };
  }
  return {
    ok: true,
    round: next(round, { status: STATUS.OPEN, flags: [], restoredBy: moderatorId, restoredAt: at })
  };
}

/** Removal by a moderator, or by the drawer deleting their own work. */
export function removeRound(round, { userId, isModerator = false, reason = null, at }) {
  if (round.status === STATUS.REMOVED) {
    return { round, ok: false, error: "Already removed." };
  }
  if (!isModerator && userId !== round.drawerId) {
    return { round, ok: false, error: "Only the person who drew this can delete it." };
  }

  return {
    ok: true,
    round: next(round, {
      status: STATUS.REMOVED,
      closedAt: at,
      removedBy: userId,
      removedReason: reason
    })
  };
}

// ---------------------------------------------------------------- scoring

/**
 * What each user earned from one round.
 *
 * Guessers keep what they earned even if the drawing is later removed. The
 * drawer does not — otherwise posting something rule-breaking that people
 * guess before it's taken down would still pay.
 */
export function roundScores(round) {
  const out = new Map();

  for (const g of round.guesses) {
    if (g.correct && g.awarded) out.set(g.userId, (out.get(g.userId) || 0) + g.awarded);
  }

  const drawerRevoked = round.status === STATUS.REMOVED && MOD.revokeDrawerPointsOnRemoval;

  if (!drawerRevoked && round.solvers.length) {
    const first = round.guesses.find(g => g.correct);
    const drawerPoints = scoreDrawer({
      firstSolverTotal: first?.awarded ?? 0,
      solverCount: round.solvers.length
    });
    if (drawerPoints) out.set(round.drawerId, (out.get(round.drawerId) || 0) + drawerPoints);
  }

  return out;
}

/** Totals across many rounds, highest first. */
export function scoreboard(rounds) {
  const totals = new Map();

  for (const round of rounds) {
    for (const [userId, pts] of roundScores(round)) {
      totals.set(userId, (totals.get(userId) || 0) + pts);
    }
  }

  return [...totals.entries()]
    .map(([userId, points]) => ({ userId, points }))
    .sort((a, b) => b.points - a.points || a.userId.localeCompare(b.userId));
}

// ---------------------------------------------------------------- views

/**
 * What a given user is allowed to see.
 *
 * The answer is the one thing that must never leak: this returns the letter
 * mask instead of the word for anyone who hasn't earned it. Everything the
 * bot sends to a channel should go through here rather than serialising a
 * round directly.
 */
export function publicView(round, userId, { isModerator = false } = {}) {
  const isDrawer  = userId === round.drawerId;
  const hasSolved = round.solvers.includes(userId);
  const isOver    = round.status === STATUS.REMOVED;

  // The drawer knows the word, solvers have earned it, and once a round is
  // over there is nothing left to protect.
  const maySeeWord = isDrawer || hasSolved || isOver;

  const view = {
    id: round.id,
    drawerId: round.drawerId,
    status: round.status,
    tier: round.tier,
    points: round.points,
    postedAt: round.postedAt,
    mask: buildMask(round.word),
    solverCount: round.solvers.length,
    guessCount: round.guesses.length,
    canGuess: canGuess(round, userId).ok,
    canDelete: isDrawer || isModerator,
    canFlag: !isDrawer && round.status !== STATUS.REMOVED,
    bonusWindowMs: bonusWindowFor(round.tier)
  };

  if (maySeeWord) view.word = round.word;

  /*
   * What this particular person did on this round. The replay page uses it to
   * greet someone coming back to a drawing they already solved — showing them
   * empty letter boxes and no score reads as the game having forgotten.
   *
   * Only ever describes the viewer's own attempts. Nobody learns what anyone
   * else guessed, which matters when the wrong answers are the funny part.
   */
  if (userId) {
    const mine = round.guesses.filter(g => g.userId === userId);

    view.you = {
      isDrawer,
      solved: hasSolved,
      attempts: mine.length,
      // Points for guessing it. The drawer's share is separate — see below.
      awarded: mine.reduce((n, g) => n + (g.awarded || 0), 0),
      // Where they came in. Null rather than -1, so "first" is unambiguous.
      solverIndex: hasSolved ? round.solvers.indexOf(userId) : null
    };

    if (isDrawer) view.you.awarded = roundScores(round).get(userId) ?? 0;
  }

  // Flag details are moderator-only; who reported what is not public.
  if (isModerator) {
    view.flags = round.flags;
    view.flagCount = round.flags.length;
  }

  // A hidden or removed drawing must not ship its strokes to the client.
  if (round.status === STATUS.OPEN || isDrawer || isModerator) {
    view.drawing = round.drawing;
  }

  return view;
}

/** Everything a channel message needs, with no secrets in it at all. */
export function channelSummary(round) {
  return {
    id: round.id,
    drawerId: round.drawerId,
    status: round.status,
    tier: round.tier,
    points: round.points,
    letters: buildMask(round.word).filter(s => s.type === "letter").length,
    solverCount: round.solvers.length,
    firstSolver: round.solvers[0] ?? null,
    postedAt: round.postedAt
  };
}

export { RULES };
