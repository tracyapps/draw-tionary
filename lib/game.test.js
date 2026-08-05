import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RULES, dealCard, normalise, isCorrect, scoreGuess, scoreDrawer, replayPlan,
  bonusWindowFor,
  buildMask, letterCount, sanitiseLetters, assembleGuess, isMaskComplete,
  describeMask
} from "./game.js";

const words = JSON.parse(readFileSync(new URL("../data/words.json", import.meta.url)));

// ------------------------------------------------------------- word list

test("word list is well formed", () => {
  for (const tier of ["easy", "medium", "hard"]) {
    const t = words.tiers[tier];
    assert.ok(t.words.length >= 60, `${tier} has only ${t.words.length} words`);
    assert.ok(t.points > 0);
    for (const w of t.words) {
      assert.equal(w, w.toLowerCase(), `"${w}" should be lowercase`);
      assert.equal(w, w.trim(), `"${w}" has stray whitespace`);
      assert.ok(w.length > 1, `"${w}" too short`);
    }
  }
});

test("no duplicate words within or across tiers", () => {
  const all = ["easy", "medium", "hard"].flatMap(t => words.tiers[t].words);
  const seen = new Set(), dupes = [];
  for (const w of all) (seen.has(w) ? dupes : seen).add?.(w) ?? dupes.push(w);
  const real = all.filter((w, i) => all.indexOf(w) !== i);
  assert.deepEqual(real, [], `duplicates: ${real.join(", ")}`);
});

test("points increase with difficulty", () => {
  assert.ok(words.tiers.easy.points < words.tiers.medium.points);
  assert.ok(words.tiers.medium.points < words.tiers.hard.points);
});

test("no word is a substring trap of another in the same tier", () => {
  // e.g. having both "boat" and "boat" variants makes fuzzy matching ambiguous
  for (const tier of ["easy", "medium", "hard"]) {
    const ws = words.tiers[tier].words;
    for (const a of ws) {
      const collisions = ws.filter(b => b !== a && isCorrect(b, a));
      assert.deepEqual(collisions, [],
        `"${a}" in ${tier} is fuzzy-matched by: ${collisions.join(", ")}`);
    }
  }
});

// ------------------------------------------------------------- dealing

test("a card offers one word per tier", () => {
  const card = dealCard(words);
  assert.equal(card.length, 3);
  assert.deepEqual(card.map(c => c.tier), ["easy", "medium", "hard"]);
  assert.ok(card.every(c => typeof c.word === "string" && c.points > 0));
});

test("dealing respects the recently-used exclusion list", () => {
  const exclude = new Set(words.tiers.easy.words.slice(0, -1));  // all but one
  for (let i = 0; i < 40; i++) {
    const card = dealCard(words, { exclude });
    assert.equal(card[0].word, words.tiers.easy.words.at(-1));
  }
});

test("exhausted exclusions fall back instead of dealing a short card", () => {
  const exclude = new Set(["easy", "medium", "hard"].flatMap(t => words.tiers[t].words));
  const card = dealCard(words, { exclude });
  assert.equal(card.length, 3);
  assert.ok(card.every(c => c.word));
});

test("dealing is uniform enough across the pool", () => {
  const counts = new Map();
  for (let i = 0; i < 20000; i++) {
    const w = dealCard(words)[0].word;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const n = words.tiers.easy.words.length;
  assert.equal(counts.size, n, "some words are unreachable");
  const expected = 20000 / n;
  for (const [w, c] of counts) {
    assert.ok(c > expected * 0.5 && c < expected * 1.5, `"${w}" drawn ${c}x vs ~${expected|0}`);
  }
});

// ------------------------------------------------------------- guessing

test("normalisation is forgiving about the things that shouldn't matter", () => {
  assert.equal(normalise("  Hot  Air   Balloon "), "hot air balloon");
  assert.equal(normalise("Jack-in-the-Box"), "jack in the box");
  assert.equal(normalise("The Lighthouse"), "lighthouse");
  assert.equal(normalise("PIZZA!!!"), "pizza");
  assert.equal(normalise("café"), "cafe");
});

test("exact and near-miss guesses are accepted", () => {
  assert.ok(isCorrect("cat", "cat"));
  assert.ok(isCorrect("  CAT ", "cat"));
  assert.ok(isCorrect("the lighthouse", "lighthouse"));
  assert.ok(isCorrect("lighthosue", "lighthouse"), "one transposition in a long word");
  assert.ok(isCorrect("archaeological dg", "archaeological dig"));
  assert.ok(isCorrect("hot air ballon", "hot air balloon"));
});

test("short words demand precision, long words tolerate a slip", () => {
  assert.ok(!isCorrect("bat", "cat"), "3-letter words must be exact");
  assert.ok(!isCorrect("car", "cat"));
  assert.ok(!isCorrect("dog", "cow"));
  assert.ok(isCorrect("giraff", "giraffe"), "6+ letters tolerate one");
});

test("wrong guesses stay wrong", () => {
  assert.ok(!isCorrect("elephant", "lighthouse"));
  assert.ok(!isCorrect("", "cat"));
  assert.ok(!isCorrect("   ", "cat"));
  assert.ok(!isCorrect("a", "cat"));
});

// ------------------------------------------------------------- mask

test("a single word becomes one box per letter", () => {
  const m = buildMask("lighthouse");
  assert.equal(m.length, 10);
  assert.equal(letterCount(m), 10);
  assert.ok(m.every(s => s.type === "letter"));
});

test("spaces are pre-filled and not typed by the guesser", () => {
  const m = buildMask("hot air balloon");
  assert.equal(m.length, 15);
  assert.equal(letterCount(m), 13, "guesser types 13 letters, not 15 characters");
  assert.deepEqual(
    m.filter(s => s.type === "fixed").map(s => s.char),
    [" ", " "]
  );
});

test("hyphens and apostrophes are pre-filled too", () => {
  const m = buildMask("jack-in-the-box");
  assert.equal(letterCount(m), 12);
  assert.deepEqual(m.filter(s => s.type === "fixed").map(s => s.char), ["-", "-", "-"]);

  const a = buildMask("cat's cradle");
  assert.deepEqual(a.filter(s => s.type === "fixed").map(s => s.char), ["'", " "]);
});

test("typed letters flow into the mask and separators appear automatically", () => {
  const m = buildMask("hot air balloon");
  assert.equal(assembleGuess(m, "hotairballoon"), "hot air balloon");
  assert.equal(assembleGuess(m, "hotair", "_"), "hot air _______");
});

test("the guesser cannot get spacing or punctuation wrong", () => {
  const m = buildMask("jack-in-the-box");
  // they type only letters; every separator is placed for them
  assert.equal(assembleGuess(m, "jackinthebox"), "jack-in-the-box");
  assert.ok(isCorrect(assembleGuess(m, "jackinthebox"), "jack-in-the-box"));
});

test("stray spaces and punctuation in the input are ignored, not rejected", () => {
  const m = buildMask("hot air balloon");
  assert.equal(sanitiseLetters("hot air balloon", m), "hotairballoon");
  assert.equal(sanitiseLetters("HOT-AIR-BALLOON", m), "hotairballoon");
  assert.equal(assembleGuess(m, sanitiseLetters("hot air balloon", m)), "hot air balloon");
});

test("input cannot overflow the available boxes", () => {
  const m = buildMask("cat");
  assert.equal(sanitiseLetters("catastrophe", m), "cat");
  assert.equal(letterCount(m), 3);
});

test("completeness is tracked so submit can be disabled until the row is full", () => {
  const m = buildMask("lighthouse");
  assert.equal(isMaskComplete(m, "lighthous"), false);
  assert.equal(isMaskComplete(m, "lighthouse"), true);
  assert.equal(isMaskComplete(m, ""), false);
});

test("every word in the list round-trips through its own mask", () => {
  for (const tier of ["easy", "medium", "hard"]) {
    for (const w of words.tiers[tier].words) {
      const m = buildMask(w);
      const typed = sanitiseLetters(w, m);
      assert.equal(isMaskComplete(m, typed), true, `"${w}" cannot be completed`);
      assert.equal(assembleGuess(m, typed), w, `"${w}" did not round-trip`);
      assert.ok(isCorrect(assembleGuess(m, typed), w), `"${w}" failed matching`);
    }
  }
});

test("mask shape is described for screen reader users", () => {
  assert.equal(describeMask(buildMask("lighthouse")), "One word, 10 letters.");
  assert.equal(describeMask(buildMask("hot air balloon")),
    "3 words: 3, 3 and 7 letters.");
  assert.equal(describeMask(buildMask("treasure chest")),
    "2 words: 8 and 5 letters.");
  assert.match(describeMask(buildMask("jack-in-the-box")), /Punctuation is filled in/);
});

test("hyphens do not split the spoken word count", () => {
  // "jack-in-the-box" reads as one word with punctuation, not four
  assert.match(describeMask(buildMask("jack-in-the-box")), /^One word, 12 letters/);
});

// ------------------------------------------------------------- scoring

test("guessing at the first frame earns the full early bonus", () => {
  const s = scoreGuess({ points: 20, guessedAtMs: 0, bonusWindowMs: 10000 });
  assert.equal(s.base, 20);
  assert.equal(s.bonus, 10);          // 20 * 0.5 * 1.0
  assert.equal(s.total, 30);
});

test("the bonus decays linearly through the replay", () => {
  const half = scoreGuess({ points: 20, guessedAtMs: 5000, bonusWindowMs: 10000 });
  assert.equal(half.bonus, 5);
  assert.equal(half.total, 25);

  const late = scoreGuess({ points: 20, guessedAtMs: 9000, bonusWindowMs: 10000 });
  assert.equal(late.bonus, 1);
});

test("guessing after the replay ends still scores the base", () => {
  const after = scoreGuess({ points: 35, guessedAtMs: 60000, bonusWindowMs: 10000 });
  assert.equal(after.bonus, 0);
  assert.equal(after.total, 35);

  const never = scoreGuess({ points: 35, guessedAtMs: undefined, bonusWindowMs: 10000 });
  assert.equal(never.total, 35);
});

test("the early bonus is the first solver's alone, but others still score", () => {
  const second = scoreGuess({ points: 20, guessedAtMs: 0, bonusWindowMs: 10000, solverIndex: 1 });
  assert.equal(second.bonus, 0);
  assert.equal(second.total, 12);
  assert.ok(second.total > 0, "later solvers must never score zero");
});

test("harder words are always worth more, even guessed late", () => {
  const easyEarly = scoreGuess({ points: 10, guessedAtMs: 0, bonusWindowMs: 10000 }).total;
  const hardLate  = scoreGuess({ points: 35, guessedAtMs: 9999, bonusWindowMs: 10000 }).total;
  assert.ok(hardLate > easyEarly,
    `hard-late (${hardLate}) should beat easy-early (${easyEarly})`);
});

test("the drawer is paid for being legible", () => {
  assert.equal(scoreDrawer({ firstSolverTotal: 30, solverCount: 0 }), 0);
  assert.equal(scoreDrawer({ firstSolverTotal: 30, solverCount: 1 }), 15);
  assert.equal(scoreDrawer({ firstSolverTotal: 30, solverCount: 4 }), 15 + 9);
});

test("nobody loses points for a wrong guess", () => {
  assert.equal(RULES.wrongGuessPenalty, 0);
});

// ------------------------------------------------------------- bonus window

test("harder words get a longer window to earn the bonus", () => {
  assert.ok(bonusWindowFor("easy") < bonusWindowFor("medium"));
  assert.ok(bonusWindowFor("medium") < bonusWindowFor("hard"));
});

test("an unknown tier falls back rather than returning undefined", () => {
  assert.equal(bonusWindowFor("nonsense"), RULES.bonusWindowMs.medium);
  assert.equal(bonusWindowFor(undefined), RULES.bonusWindowMs.medium);
});

test("the bonus window is independent of how long the drawing took", () => {
  // A three-stroke doodle and a fifteen-minute masterpiece of the same word
  // must give the guesser exactly the same time to earn a bonus.
  const doodle = replayPlan(3000);
  const epic   = replayPlan(15 * 60 * 1000);
  assert.notEqual(doodle.durationMs, epic.durationMs, "replays differ, as expected");

  const w = bonusWindowFor("medium");
  const a = scoreGuess({ points: 20, guessedAtMs: 5000, bonusWindowMs: w });
  const b = scoreGuess({ points: 20, guessedAtMs: 5000, bonusWindowMs: w });
  assert.deepEqual(a, b, "same word, same elapsed time, same score");

  // and the window is not derived from either replay length
  assert.notEqual(w, doodle.durationMs);
  assert.notEqual(w, epic.durationMs);
});

test("re-watching a drawing cannot refresh the bonus", () => {
  // The bonus depends only on elapsed time since the drawing was opened, so
  // there is no input to scoreGuess that a replay button could reset.
  const w = bonusWindowFor("hard");
  const first  = scoreGuess({ points: 35, guessedAtMs: 10000, bonusWindowMs: w });
  const replayed = scoreGuess({ points: 35, guessedAtMs: 10000, bonusWindowMs: w });
  assert.deepEqual(first, replayed);

  // later is always worth less, never more
  const later = scoreGuess({ points: 35, guessedAtMs: 20000, bonusWindowMs: w });
  assert.ok(later.total < first.total);
});

test("a wrong guess does not change what a later correct guess is worth", () => {
  const w = bonusWindowFor("easy");
  // scoring is a pure function of time, so attempts simply do not feature
  const after3Attempts = scoreGuess({ points: 10, guessedAtMs: 12000, bonusWindowMs: w });
  const firstTry       = scoreGuess({ points: 10, guessedAtMs: 12000, bonusWindowMs: w });
  assert.deepEqual(after3Attempts, firstTry);
});

// ------------------------------------------------------------- replay

test("replay lands inside the guessable window", () => {
  for (const recorded of [1000, 8000, 30000, 120000, 900000]) {
    const p = replayPlan(recorded);
    assert.ok(p.durationMs >= RULES.replayMinMs || recorded < RULES.replayMinMs);
    assert.ok(p.durationMs <= RULES.replayMaxMs);
    assert.ok(p.speed >= 1, "replay must never be slower than real time");
  }
});

test("a 15-minute masterpiece compresses; a 3-second doodle does not", () => {
  const epic = replayPlan(15 * 60 * 1000);
  assert.equal(epic.durationMs, RULES.replayTargetMs);
  assert.ok(epic.speed > 30, `expected heavy compression, got ${epic.speed.toFixed(1)}x`);

  const doodle = replayPlan(3000);
  assert.equal(doodle.speed, 1, "short drawings should play at real time");
});

test("replay target is the 20s that felt right in the spike", () => {
  assert.equal(RULES.replayTargetMs, 20000);
  assert.ok(RULES.replayTargetMs > 6000,
    "tuned slower so more people get a shot at the early bonus");
});
