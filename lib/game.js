/*
 * Draw-tionary — card dealing, guess matching, and scoring.
 *
 * Pure functions, no I/O, no Discord. That keeps the rules testable on their
 * own and means the same module can run in the bot, in the canvas app, or in
 * a test harness without change.
 */

// ---------------------------------------------------------------- tuning

export const RULES = {
  // Multiplier applied to the tier's base points for guessing mid-replay.
  // 0.5 means a guess at the very first frame is worth 1.5x; a guess on the
  // final frame is worth 1.0x. Guessing after the replay ends scores base.
  earlyBonusMax: 0.5,

  // The drawer earns this share of the first solver's score, plus a small
  // flat amount per additional solver. Rewards drawing something legible
  // rather than something impossible.
  drawerShareOfFirst: 0.5,
  drawerPerExtraSolver: 3,

  // Wrong guesses cost nothing. This is a church games channel, not a
  // quiz show — the failure mode we care about is people not trying.
  wrongGuessPenalty: 0,

  // How long a replay should take, in ms. Tuned by feel in the spike page —
  // 20s gives noticeably more people a shot at the early bonus than 10s did.
  replayTargetMs: 20000,
  replayMinMs: 6000,
  replayMaxMs: 30000,

  /*
   * The bonus window is deliberately NOT the replay length.
   *
   * Tying the bonus to the replay punishes whoever happens to receive a quick
   * three-stroke doodle: they get five seconds to think while someone else
   * gets thirty. Decoupling them means everyone gets the same fair shot at
   * the same word, and re-watching the drawing costs nothing.
   *
   * Harder words get longer, because they take longer to read.
   */
  bonusWindowMs: {
    easy:   30000,
    medium: 45000,
    hard:   60000
  }
};

/** How long the early-answer bonus stays available for a given tier. */
export function bonusWindowFor(tier) {
  return RULES.bonusWindowMs[tier] ?? RULES.bonusWindowMs.medium;
}

// ---------------------------------------------------------------- dealing

/**
 * Deal a card: one word from each tier, like Draw Something's three choices.
 *
 * `exclude` is a set of recently-used words so a small server doesn't see
 * "lighthouse" three times in a week.
 */
export function dealCard(words, { exclude = new Set(), random = Math.random } = {}) {
  const card = [];

  for (const tier of ["easy", "medium", "hard"]) {
    const pool = words.tiers[tier].words.filter(w => !exclude.has(w));
    // If exclusions have drained a tier, fall back to the full list rather
    // than dealing a short card.
    const from = pool.length ? pool : words.tiers[tier].words;
    card.push({
      tier,
      word: from[Math.floor(random() * from.length)],
      points: words.tiers[tier].points
    });
  }

  return card;
}

// ---------------------------------------------------------------- guessing

/**
 * Normalise a guess for comparison. Forgiving on purpose: punctuation,
 * casing, spacing, and a leading article shouldn't be the difference between
 * right and wrong when someone is typing on a phone.
 */
export function normalise(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // strip combining accents
    .replace(/[^a-z0-9\s]/g, " ")      // punctuation -> space
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(a|an|the) /, "");
}

/*
 * Damerau-Levenshtein (optimal string alignment), capped for speed.
 *
 * Plain Levenshtein charges 2 for a transposition, which is wrong for our
 * purposes: swapping two letters ("lighthosue") is the single most common
 * typo when someone is thumbing a guess on a phone, and it should cost the
 * same as any other single slip.
 */
function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let prev2 = null;
  let prev  = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      let d = Math.min(
        prev[j] + 1,          // deletion
        cur[j - 1] + 1,       // insertion
        prev[j - 1] + cost    // substitution
      );

      // transposition: "ab" -> "ba" counts as one edit
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }

      cur[j] = d;
      if (d < best) best = d;
    }

    if (best > cap) return cap + 1;
    prev2 = prev;
    prev  = cur;
  }

  return prev[b.length];
}

/**
 * Is this guess correct? Allows small typos, scaled to word length so that
 * "cat" needs to be exact but "archaeological dig" tolerates a slip.
 */
export function isCorrect(guess, answer) {
  const g = normalise(guess);
  const a = normalise(answer);
  if (!g) return false;
  if (g === a) return true;

  const tolerance = a.length >= 12 ? 2 : a.length >= 6 ? 1 : 0;
  if (tolerance === 0) return false;
  return editDistance(g, a, tolerance) <= tolerance;
}

// ---------------------------------------------------------------- mask

/*
 * Letter boxes, Draw Something style.
 *
 * The answer becomes a row of slots: one empty box per letter, with spaces,
 * hyphens and apostrophes pre-filled and locked. That gives away word count
 * and length — which is the point, it is a hint — but it also means the
 * guesser physically cannot get the punctuation or spacing wrong. Typos stop
 * being a scoring problem and become an input-design problem.
 */

/** Build the slot layout for an answer. */
export function buildMask(answer) {
  return [...String(answer).trim()].map(ch =>
    /[a-z0-9]/i.test(ch)
      ? { type: "letter" }
      : { type: "fixed", char: ch }
  );
}

/** How many letters the guesser actually has to type. */
export function letterCount(mask) {
  return mask.reduce((n, s) => n + (s.type === "letter" ? 1 : 0), 0);
}

/** Keep only characters that can occupy a letter slot. */
export function sanitiseLetters(input, mask) {
  return String(input)
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, letterCount(mask))
    .toLowerCase();
}

/**
 * Merge typed letters into the mask, producing the full guess with all
 * separators in place. `blank` fills slots not yet typed.
 */
export function assembleGuess(mask, letters, blank = "") {
  const chars = [...String(letters)];
  let i = 0;
  return mask
    .map(s => (s.type === "fixed" ? s.char : (chars[i++] ?? blank)))
    .join("");
}

export function isMaskComplete(mask, letters) {
  return sanitiseLetters(letters, mask).length === letterCount(mask);
}

/**
 * A spoken description of the shape of the answer, for screen reader users
 * who cannot see the boxes. "Three words: 3, 3 and 7 letters."
 */
export function describeMask(mask) {
  const groups = [];
  let run = 0;

  for (const s of mask) {
    if (s.type === "letter") { run++; continue; }
    if (s.char === " ") { if (run) groups.push(run); run = 0; }
    // hyphens and apostrophes sit inside a word, so they don't split the count
  }
  if (run) groups.push(run);

  if (groups.length === 0) return "No letters.";

  // Applies to every shape, including single words like "jack-in-the-box"
  // where the hyphens are the only thing a sighted user can see.
  const marks = mask.some(s => s.type === "fixed" && s.char !== " ")
    ? " Punctuation is filled in for you."
    : "";

  if (groups.length === 1) return `One word, ${groups[0]} letters.${marks}`;

  const list = groups.length === 2
    ? `${groups[0]} and ${groups[1]}`
    : groups.slice(0, -1).join(", ") + " and " + groups.at(-1);

  return `${groups.length} words: ${list} letters.${marks}`;
}

// ---------------------------------------------------------------- scoring

/**
 * Score a correct guess.
 *
 * @param points         base points for the word's tier
 * @param guessedAtMs    ms since the drawing was opened, NOT ms into a replay
 * @param bonusWindowMs  how long the bonus stays available (see RULES)
 * @param solverIndex    0 for the first person to get it, 1 for the next, ...
 */
export function scoreGuess({ points, guessedAtMs, bonusWindowMs, solverIndex = 0 }) {
  let fractionRemaining = 0;

  if (Number.isFinite(guessedAtMs) && bonusWindowMs > 0 && guessedAtMs < bonusWindowMs) {
    fractionRemaining = 1 - Math.max(0, guessedAtMs) / bonusWindowMs;
  }

  const bonus = Math.round(points * RULES.earlyBonusMax * fractionRemaining);

  // Later solvers still score — the goal is participation, not a race — but
  // the early bonus is the first solver's to win.
  const lateTax = solverIndex === 0 ? 1 : 0.6;

  return {
    base: points,
    bonus: solverIndex === 0 ? bonus : 0,
    total: Math.round(points * lateTax) + (solverIndex === 0 ? bonus : 0),
    earlyFraction: fractionRemaining
  };
}

/** Points awarded to whoever made the drawing. */
export function scoreDrawer({ firstSolverTotal = 0, solverCount = 0 }) {
  if (solverCount === 0) return 0;
  return Math.round(firstSolverTotal * RULES.drawerShareOfFirst)
       + Math.max(0, solverCount - 1) * RULES.drawerPerExtraSolver;
}

// ---------------------------------------------------------------- replay

/**
 * How fast to play a recording back. Long, elaborate drawings get compressed
 * more than quick doodles, but everything lands inside a window that leaves
 * room to guess early.
 */
export function replayPlan(recordedMs, target = RULES.replayTargetMs) {
  if (!(recordedMs > 0)) return { durationMs: target, speed: 1 };

  const durationMs = Math.min(
    RULES.replayMaxMs,
    Math.max(RULES.replayMinMs, Math.min(recordedMs, target))
  );

  return {
    durationMs,
    speed: Math.max(1, recordedMs / durationMs)   // never slower than real time
  };
}
