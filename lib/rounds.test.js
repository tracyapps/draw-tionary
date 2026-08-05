import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS, MOD, createRound, submitDrawing, canGuess, recordGuess,
  flagRound, restoreRound, removeRound, roundScores, scoreboard,
  publicView, channelSummary
} from "./rounds.js";

const T0 = 1_000_000;
const strokes = [{ color: "#000", size: 6, erase: false, pts: [{ x: .1, y: .1, p: .5, t: 0 }] }];

function openRound(over = {}) {
  const r = createRound({
    id: "r1", drawerId: "tapps", word: "lighthouse",
    tier: "medium", points: 20, at: T0, ...over
  });
  return submitDrawing(r, { strokes, durationMs: 60000, width: 1200, height: 900, at: T0 }).round;
}

// ---------------------------------------------------------------- lifecycle

test("a new round starts as a private draft", () => {
  const r = createRound({ id: "r1", drawerId: "tapps", word: "cat", tier: "easy", points: 10, at: T0 });
  assert.equal(r.status, STATUS.DRAFTING);
  assert.equal(r.postedAt, null);
  assert.equal(canGuess(r, "sarah").ok, false);
});

test("a round needs an id, a drawer and a word", () => {
  assert.throws(() => createRound({ drawerId: "a", word: "cat" }), /id/);
  assert.throws(() => createRound({ id: "r", word: "cat" }), /drawerId/);
  assert.throws(() => createRound({ id: "r", drawerId: "a" }), /word/);
});

test("submitting opens the round for guesses", () => {
  const r = openRound();
  assert.equal(r.status, STATUS.OPEN);
  assert.equal(r.postedAt, T0);
  assert.equal(canGuess(r, "sarah").ok, true);
});

test("you cannot post an empty drawing", () => {
  const r = createRound({ id: "r1", drawerId: "tapps", word: "cat", tier: "easy", points: 10, at: T0 });
  const res = submitDrawing(r, { strokes: [], at: T0 });
  assert.equal(res.ok, false);
  assert.equal(res.round.status, STATUS.DRAFTING);
});

test("you cannot post the same drawing twice", () => {
  const r = openRound();
  const res = submitDrawing(r, { strokes, at: T0 + 5 });
  assert.equal(res.ok, false);
});

test("rounds are immutable — functions return new objects", () => {
  const r = openRound();
  const after = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;
  assert.equal(r.guesses.length, 0, "original round was mutated");
  assert.equal(after.guesses.length, 1);
  assert.notEqual(r, after);
});

// ---------------------------------------------------------------- guessing

test("the drawer cannot guess their own drawing", () => {
  const r = openRound();
  const res = recordGuess(r, { userId: "tapps", guess: "lighthouse", at: T0 + 100 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "own_drawing");
  assert.equal(res.round.solvers.length, 0);
});

test("nobody can solve the same round twice", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;

  const again = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 2000 });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "already_solved");
  assert.equal(again.round.solvers.length, 1, "solver was counted twice");
});

test("wrong guesses are recorded, cost nothing, and can be retried", () => {
  let r = openRound();
  for (const bad of ["elephant", "windmill", "castle"]) {
    const res = recordGuess(r, { userId: "sarah", guess: bad, at: T0 + 500 });
    assert.equal(res.correct, false);
    assert.equal(res.awarded, 0);
    r = res.round;
  }
  assert.equal(r.guesses.length, 3);
  assert.equal(r.solvers.length, 0);

  const good = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 600 });
  assert.equal(good.correct, true, "a wrong guess must not lock you out");
  assert.ok(good.awarded > 0);
});

test("only the first solver earns the early bonus", () => {
  let r = openRound();

  const first = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 });
  r = first.round;
  const second = recordGuess(r, { userId: "jonah", guess: "lighthouse", at: T0 + 1000 });

  assert.ok(first.score.bonus > 0);
  assert.equal(second.score.bonus, 0);
  assert.ok(second.awarded > 0, "later solvers must still score");
  assert.ok(first.awarded > second.awarded);
});

test("guessing later in the window is worth less", () => {
  const r = openRound();
  const early = recordGuess(r, { userId: "a", guess: "lighthouse", at: T0 + 1000 }).awarded;
  const late  = recordGuess(r, { userId: "b", guess: "lighthouse", at: T0 + 40000 }).awarded;
  assert.ok(early > late);
});

test("typos are forgiven, wrong words are not", () => {
  const r = openRound();
  assert.equal(recordGuess(r, { userId: "a", guess: "lighthosue", at: T0 + 1 }).correct, true);
  assert.equal(recordGuess(r, { userId: "b", guess: "The Lighthouse", at: T0 + 1 }).correct, true);
  assert.equal(recordGuess(r, { userId: "c", guess: "windmill", at: T0 + 1 }).correct, false);
});

// ---------------------------------------------------------------- flagging

test("any player can flag, not just moderators", () => {
  const r = openRound();
  const res = flagRound(r, { userId: "anyone", reason: "inappropriate", at: T0 + 10 });
  assert.equal(res.ok, true);
  assert.equal(res.flagCount, 1);
});

test("one flag does not hide a drawing", () => {
  const r = openRound();
  const res = flagRound(r, { userId: "sarah", at: T0 + 10 });
  assert.equal(res.round.status, STATUS.OPEN);
  assert.equal(res.hidden, false);
});

test("reaching the threshold auto-hides pending review", () => {
  let r = openRound();
  r = flagRound(r, { userId: "sarah", at: T0 + 10 }).round;
  const res = flagRound(r, { userId: "jonah", at: T0 + 20 });

  assert.equal(MOD.flagsToHide, 2);
  assert.equal(res.round.status, STATUS.HIDDEN);
  assert.equal(res.hidden, true);
});

test("re-flagging is idempotent, not a way to trip the threshold alone", () => {
  let r = openRound();
  r = flagRound(r, { userId: "sarah", at: T0 + 10 }).round;
  const again = flagRound(r, { userId: "sarah", at: T0 + 20 });

  assert.equal(again.alreadyFlagged, true);
  assert.equal(again.round.flags.length, 1);
  assert.equal(again.round.status, STATUS.OPEN, "one person hid a drawing by themselves");
});

test("a hidden drawing cannot be guessed", () => {
  let r = openRound();
  r = flagRound(r, { userId: "a", at: T0 + 10 }).round;
  r = flagRound(r, { userId: "b", at: T0 + 20 }).round;

  const res = recordGuess(r, { userId: "c", guess: "lighthouse", at: T0 + 30 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "hidden");
});

test("a moderator can clear a false alarm and reopen", () => {
  let r = openRound();
  r = flagRound(r, { userId: "a", at: T0 + 10 }).round;
  r = flagRound(r, { userId: "b", at: T0 + 20 }).round;

  const res = restoreRound(r, { moderatorId: "mod", at: T0 + 30 });
  assert.equal(res.round.status, STATUS.OPEN);
  assert.equal(res.round.flags.length, 0, "old flags should not re-trip immediately");
  assert.equal(canGuess(res.round, "c").ok, true);
});

// ---------------------------------------------------------------- removal

test("the drawer can delete their own drawing", () => {
  const r = openRound();
  const res = removeRound(r, { userId: "tapps", at: T0 + 100 });
  assert.equal(res.ok, true);
  assert.equal(res.round.status, STATUS.REMOVED);
});

test("someone else cannot delete a drawing that isn't theirs", () => {
  const r = openRound();
  const res = removeRound(r, { userId: "sarah", at: T0 + 100 });
  assert.equal(res.ok, false);
  assert.equal(res.round.status, STATUS.OPEN);
});

test("a moderator can remove anyone's drawing", () => {
  const r = openRound();
  const res = removeRound(r, { userId: "mod", isModerator: true, reason: "inappropriate", at: T0 + 100 });
  assert.equal(res.ok, true);
  assert.equal(res.round.removedReason, "inappropriate");
});

test("a removed drawing cannot be guessed", () => {
  const r = removeRound(openRound(), { userId: "tapps", at: T0 + 10 }).round;
  const res = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 20 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "removed");
});

// ---------------------------------------------------------------- scoring

test("guessers keep their points, the drawer loses theirs, when a drawing is removed", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;
  r = recordGuess(r, { userId: "jonah", guess: "lighthouse", at: T0 + 2000 }).round;

  const before = roundScores(r);
  assert.ok(before.get("tapps") > 0, "drawer earns while the round stands");
  const sarahBefore = before.get("sarah");

  const removed = removeRound(r, { userId: "mod", isModerator: true, at: T0 + 3000 }).round;
  const after = roundScores(removed);

  assert.equal(after.get("tapps"), undefined, "drawer kept points after removal");
  assert.equal(after.get("sarah"), sarahBefore, "guesser was punished for someone else's drawing");
  assert.ok(after.get("jonah") > 0);
});

test("the drawer earns nothing if nobody solves it", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "windmill", at: T0 + 1000 }).round;
  assert.equal(roundScores(r).get("tapps"), undefined);
});

test("the scoreboard totals across rounds and sorts by points", () => {
  let a = openRound();
  a = recordGuess(a, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;

  let b = openRound({ id: "r2", drawerId: "sarah", word: "cat", tier: "easy", points: 10 });
  b = recordGuess(b, { userId: "jonah", guess: "cat", at: T0 + 500 }).round;

  const board = scoreboard([a, b]);
  assert.ok(board.length >= 3);
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i - 1].points >= board[i].points, "scoreboard is not sorted");
  }
  assert.ok(board.every(e => e.points > 0));
});

// ---------------------------------------------------------------- views

test("the answer never leaks to someone who hasn't earned it", () => {
  const r = openRound();
  const v = publicView(r, "sarah");
  assert.equal(v.word, undefined, "the word leaked to a guesser");
  assert.equal(JSON.stringify(v).includes("lighthouse"), false, "the word leaked somewhere in the payload");
});

test("the mask is shared so guessers see the shape, not the answer", () => {
  const v = publicView(openRound(), "sarah");
  assert.equal(v.mask.length, 10);
  assert.ok(v.mask.every(s => s.type === "letter"));
  assert.equal(v.mask.some(s => s.char), false, "mask carried letters");
});

test("the drawer and anyone who solved it can see the word", () => {
  let r = openRound();
  assert.equal(publicView(r, "tapps").word, "lighthouse");

  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;
  assert.equal(publicView(r, "sarah").word, "lighthouse");
  assert.equal(publicView(r, "jonah").word, undefined, "a non-solver saw the answer");
});

test("an anonymous viewer gets no personal summary at all", () => {
  const v = publicView(openRound(), null);
  assert.equal(v.you, undefined);
});

test("a viewer coming back is told they solved it, and for how much", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;

  const v = publicView(r, "sarah");
  assert.equal(v.you.solved, true);
  assert.equal(v.you.solverIndex, 0, "sarah was first");
  assert.ok(v.you.awarded > 0);
  assert.equal(v.you.isDrawer, false);
});

test("solverIndex places you in the queue, not just in it", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;
  r = recordGuess(r, { userId: "jonah", guess: "lighthouse", at: T0 + 2000 }).round;

  assert.equal(publicView(r, "jonah").you.solverIndex, 1);
});

test("wrong guesses are counted for you and invisible to everyone else", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "candle", at: T0 + 500 }).round;
  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;

  assert.equal(publicView(r, "sarah").you.attempts, 2);

  const theirs = publicView(r, "jonah");
  assert.equal(theirs.you.attempts, 0, "jonah was shown sarah's attempts");
  assert.equal(JSON.stringify(theirs).includes("candle"), false, "a wrong guess leaked");
});

test("the drawer's summary reports their share, not a guesser's score", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;

  const v = publicView(r, "tapps");
  assert.equal(v.you.isDrawer, true);
  assert.equal(v.you.solved, false, "the drawer did not solve their own round");
  assert.equal(v.you.awarded, roundScores(r).get("tapps"));
  assert.ok(v.you.awarded > 0);
});

test("a drawer whose round nobody has solved is not promised points", () => {
  const v = publicView(openRound(), "tapps");
  assert.equal(v.you.awarded, 0);
});

test("who flagged what is moderator-only", () => {
  const r = flagRound(openRound(), { userId: "sarah", reason: "inappropriate", at: T0 + 1 }).round;

  assert.equal(publicView(r, "jonah").flags, undefined);
  assert.equal(JSON.stringify(publicView(r, "jonah")).includes("sarah"), false);
  assert.equal(publicView(r, "mod", { isModerator: true }).flags.length, 1);
});

test("a hidden drawing's strokes are not sent to ordinary players", () => {
  let r = openRound();
  r = flagRound(r, { userId: "a", at: T0 + 1 }).round;
  r = flagRound(r, { userId: "b", at: T0 + 2 }).round;

  assert.equal(publicView(r, "c").drawing, undefined, "hidden artwork was still served");
  assert.ok(publicView(r, "tapps").drawing, "the drawer should still see their own work");
  assert.ok(publicView(r, "mod", { isModerator: true }).drawing, "moderators need to see it to judge it");
});

test("the view tells the client exactly which controls to show", () => {
  const r = openRound();

  const drawer = publicView(r, "tapps");
  assert.equal(drawer.canGuess, false);
  assert.equal(drawer.canDelete, true);
  assert.equal(drawer.canFlag, false, "you should not flag your own drawing — delete it");

  const player = publicView(r, "sarah");
  assert.equal(player.canGuess, true);
  assert.equal(player.canDelete, false);
  assert.equal(player.canFlag, true, "every player must be able to flag");
});

test("the channel summary carries no secrets at all", () => {
  let r = openRound();
  r = recordGuess(r, { userId: "sarah", guess: "lighthouse", at: T0 + 1000 }).round;

  const s = channelSummary(r);
  assert.equal(JSON.stringify(s).includes("lighthouse"), false);
  assert.equal(s.letters, 10, "letter count is a fair hint");
  assert.equal(s.solverCount, 1);
  assert.equal(s.firstSolver, "sarah");
});
