/*
 * Runs lib/schema.sql against a real (in-memory) SQLite database and checks
 * that the constraints actually do what the comments claim.
 *
 * A schema that only exists as a file is a schema nobody has tested. The
 * unique indexes here are the last line of defence against double-scoring
 * and single-person flag hiding, so they are worth proving.
 *
 *   node tools/schema-check.js
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * Uses Node's built-in SQLite rather than better-sqlite3. The npm package
 * needs native compilation, which breaks on any machine without a working
 * node-gyp toolchain — not a dependency worth carrying just to verify a
 * schema file. Run with: node --experimental-sqlite tools/schema-check.js
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(root, "lib", "schema.sql"), "utf8");

let failures = 0;
const ok  = m => console.log("PASS  " + m);
const bad = m => { failures++; console.log("FAIL  " + m); };

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");

try {
  db.exec(sql);
  ok("schema.sql executes cleanly on SQLite");
} catch (e) {
  bad("schema.sql failed to execute: " + e.message);
  process.exit(1);
}

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all().map(r => r.name);

const expected = [
  "activity_intents", "draw_sessions", "flags", "guesses", "moderation_log",
  "rounds", "scores", "view_grants", "viewer_sessions"
];
JSON.stringify(tables) === JSON.stringify(expected)
  ? ok(`all ${tables.length} tables created: ${tables.join(", ")}`)
  : bad(`unexpected tables: ${tables.join(", ")}`);

// ---------------------------------------------------------------- fixtures

const now = Date.now();

const insertRound = db.prepare(`
  INSERT INTO rounds (id, guild_id, channel_id, drawer_id, word, tier, points, status, created_at, posted_at)
  VALUES (?, 'g1', 'c1', 'tapps', ?, ?, ?, ?, ?, ?)
`);
insertRound.run("r1", "lighthouse", "medium", 20, "open", now, now);
ok("a round can be inserted");

const insertGuess = db.prepare(`
  INSERT INTO guesses (id, round_id, user_id, guess, correct, awarded, guessed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// ---------------------------------------------------------------- constraints

// tier and status are constrained
try {
  insertRound.run("bad1", "cat", "impossible", 10, "open", now, now);
  bad("an invalid tier was accepted");
} catch { ok("invalid tier is rejected by CHECK constraint"); }

try {
  insertRound.run("bad2", "cat", "easy", 10, "banana", now, now);
  bad("an invalid status was accepted");
} catch { ok("invalid status is rejected by CHECK constraint"); }

// wrong guesses may repeat freely
insertGuess.run("g1", "r1", "sarah", "windmill", 0, 0, now);
insertGuess.run("g2", "r1", "sarah", "castle", 0, 0, now + 1);
insertGuess.run("g3", "r1", "sarah", "tower", 0, 0, now + 2);
ok("a player may guess wrong as many times as they like");

// but only one correct guess per player per round
insertGuess.run("g4", "r1", "sarah", "lighthouse", 1, 30, now + 3);
try {
  insertGuess.run("g5", "r1", "sarah", "lighthouse", 1, 30, now + 4);
  bad("the same player scored twice on one round");
} catch { ok("double-scoring is blocked at the database level, not just in code"); }

// a different player can still solve it
insertGuess.run("g6", "r1", "jonah", "lighthouse", 1, 12, now + 5);
ok("a second player can still solve the same round");

// one flag per person per round
const insertFlag = db.prepare(
  "INSERT INTO flags (round_id, user_id, reason, flagged_at) VALUES (?, ?, ?, ?)"
);
insertFlag.run("r1", "sarah", "inappropriate", now);
try {
  insertFlag.run("r1", "sarah", "inappropriate", now + 1);
  bad("one person flagged the same drawing twice");
} catch { ok("nobody can stack flags to hide a drawing single-handedly"); }

insertFlag.run("r1", "jonah", "other", now + 2);
const flagCount = db.prepare("SELECT COUNT(*) n FROM flags WHERE round_id = 'r1'").get().n;
flagCount === 2 ? ok("two distinct players produce two flags — the hide threshold")
                : bad(`expected 2 flags, got ${flagCount}`);

// message_id must be unique when present, but many rounds may have none
db.prepare("UPDATE rounds SET message_id = 'm1' WHERE id = 'r1'").run();
insertRound.run("r2", "cat", "easy", 10, "drafting", now, null);
insertRound.run("r3", "dog", "easy", 10, "drafting", now, null);
ok("several drafts can coexist with no message_id (partial unique index)");

try {
  db.prepare("UPDATE rounds SET message_id = 'm1' WHERE id = 'r2'").run();
  bad("two rounds share one Discord message id");
} catch { ok("a Discord message maps to exactly one round"); }

// cascade deletes
db.prepare("DELETE FROM rounds WHERE id = 'r1'").run();
const orphanGuesses = db.prepare("SELECT COUNT(*) n FROM guesses WHERE round_id='r1'").get().n;
const orphanFlags   = db.prepare("SELECT COUNT(*) n FROM flags  WHERE round_id='r1'").get().n;
orphanGuesses === 0 && orphanFlags === 0
  ? ok("deleting a round cascades to its guesses and flags — no orphans")
  : bad(`orphans left behind: ${orphanGuesses} guesses, ${orphanFlags} flags`);

// sessions
const CARD = JSON.stringify([
  { tier: "easy", word: "cat", points: 10 },
  { tier: "medium", word: "lighthouse", points: 20 },
  { tier: "hard", word: "traffic jam", points: 35 }
]);

db.prepare(`
  INSERT INTO draw_sessions (token, guild_id, channel_id, user_id, card, issued_at, expires_at)
  VALUES ('tok1', 'g1', 'c1', 'tapps', ?, ?, ?)
`).run(CARD, now, now + 900000);
ok("a draw session can be minted before any round exists");

const sess = db.prepare("SELECT * FROM draw_sessions WHERE token='tok1'").get();
JSON.parse(sess.card).length === 3
  ? ok("the dealt card is stored server-side, not trusted from the client")
  : bad("card did not round-trip");
sess.round_id === null
  ? ok("round_id stays null until the drawer picks a word")
  : bad("round_id was set too early");

try {
  db.prepare(`
    INSERT INTO draw_sessions (token, guild_id, channel_id, user_id, card, issued_at, expires_at)
    VALUES ('tok1', 'g1', 'c1', 'someone-else', ?, ?, ?)
  `).run(CARD, now, now + 900000);
  bad("a session token was reused");
} catch { ok("session tokens are unique — a leaked link cannot be re-minted"); }

// binding a session to its round once a word is chosen
db.prepare("UPDATE draw_sessions SET round_id = 'r2' WHERE token = 'tok1'").run();
ok("a session binds to its round once a word is picked");

try {
  db.prepare("UPDATE draw_sessions SET round_id = 'does-not-exist' WHERE token = 'tok1'").run();
  bad("a session was bound to a round that does not exist");
} catch { ok("sessions cannot point at a missing round (FK enforced)"); }

// view grants — the short-lived thing that travels in a URL
const insertGrant = db.prepare(`
  INSERT INTO view_grants
    (token, round_id, user_id, guild_id, channel_id, is_moderator, issued_at, expires_at)
  VALUES (?,?,?,?,?,?,?,?)
`);

insertGrant.run("g-1", "r2", "sarah", "g1", "c1", 0, now, now + 90000);
ok("a grant binds a Discord user to one round");

try {
  insertGrant.run("g-2", "r2", "sarah", "g1", "c1", 0, now, now + 90000);
  bad("one person accumulated two live grants to the same drawing");
} catch { ok("one live grant per person per round"); }

/*
 * The single-use property, which is the whole reason grants exist. Spending
 * one is a conditional UPDATE, so two requests racing on a pasted link cannot
 * both win — the loser sees zero rows changed.
 */
const spend = db.prepare(
  "UPDATE view_grants SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL AND expires_at >= ?"
);

spend.run(now, "g-1", now).changes === 1
  ? ok("a fresh grant can be spent exactly once")
  : bad("a fresh grant could not be spent");

spend.run(now, "g-1", now).changes === 0
  ? ok("spending it again gets nothing — a pasted link is already dead")
  : bad("a grant was honoured twice");

insertGrant.run("g-old", "r2", "evan", "g1", "c1", 0, now - 120000, now - 60000);
spend.run(now, "g-old", now).changes === 0
  ? ok("an expired grant cannot be spent")
  : bad("an expired grant was honoured");

// Pressing the button again must replace the old grant and un-spend it.
db.prepare(`
  INSERT INTO view_grants
    (token, round_id, user_id, guild_id, channel_id, is_moderator, issued_at, expires_at, consumed_at)
  VALUES ('g-3','r2','sarah','g1','c1',0,?,?,NULL)
  ON CONFLICT(round_id, user_id) DO UPDATE SET
    token = excluded.token, expires_at = excluded.expires_at, consumed_at = NULL
`).run(now + 1, now + 90000);

const rotated = db.prepare("SELECT token FROM view_grants WHERE round_id='r2' AND user_id='sarah'").all();
rotated.length === 1 && rotated[0].token === "g-3"
  ? ok("re-pressing the button rotates the grant instead of stacking them")
  : bad("grant rotation left " + JSON.stringify(rotated));

try {
  insertGrant.run("g-9", "no-such-round", "sarah", "g1", "c1", 0, now, now + 1);
  bad("a grant was minted for a round that does not exist");
} catch { ok("grants cannot point at a missing round (FK enforced)"); }

// viewer sessions — the cookie, which is identity and nothing else
const insertViewer = db.prepare(`
  INSERT INTO viewer_sessions
    (token, user_id, guild_id, channel_id, is_moderator, issued_at, expires_at, last_seen_at)
  VALUES (?,?,?,?,?,?,?,?)
`);

const WEEK = 7 * 24 * 60 * 60 * 1000;
insertViewer.run("s1", "sarah", "g1", "c1", 0, now, now + WEEK, now);
insertViewer.run("s2", "sarah", "g1", "c1", 0, now, now + WEEK, now);
db.prepare("SELECT COUNT(*) n FROM viewer_sessions WHERE user_id='sarah'").get().n === 2
  ? ok("one person can be signed in on a phone and a laptop at once")
  : bad("viewer sessions are wrongly capped per user");

db.prepare("SELECT COUNT(*) n FROM pragma_table_info('viewer_sessions') WHERE name='round_id'").get().n === 0
  ? ok("the cookie is not scoped to a round — identity is a person, not a drawing")
  : bad("viewer_sessions is round-scoped, which would mean re-pressing per replay");

// A deleted round revokes grants to it, but must not sign anybody out.
db.prepare("DELETE FROM rounds WHERE id = 'r2'").run();
db.prepare("SELECT COUNT(*) n FROM view_grants WHERE round_id='r2'").get().n === 0
  ? ok("deleting a round revokes every grant to it")
  : bad("grants outlived their round");

db.prepare("SELECT COUNT(*) n FROM viewer_sessions WHERE user_id='sarah'").get().n === 2
  ? ok("deleting a round does not sign its viewers out of everything else")
  : bad("a deleted round cascaded into viewer sessions");

// activity intents — why the iframe opened
const insertIntent = db.prepare(`
  INSERT INTO activity_intents
    (user_id, guild_id, channel_id, kind, round_id, created_at, expires_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(user_id, channel_id) DO UPDATE SET
    kind = excluded.kind, round_id = excluded.round_id, expires_at = excluded.expires_at
`);

insertRound.run("r4", "windmill", "hard", 35, "open", now, now);

insertIntent.run("sarah", "g1", "c1", "guess", "r4", now, now + 300000);
db.prepare("SELECT kind FROM activity_intents WHERE user_id='sarah' AND channel_id='c1'").get().kind === "guess"
  ? ok("pressing Guess records that the Activity should open on that drawing")
  : bad("intent was not recorded");

// Pressing a different button replaces rather than queues.
insertIntent.run("sarah", "g1", "c1", "draw", null, now + 1, now + 300000);
const intents = db.prepare("SELECT * FROM activity_intents WHERE user_id='sarah' AND channel_id='c1'").all();
intents.length === 1 && intents[0].kind === "draw" && intents[0].round_id === null
  ? ok("a newer intent replaces the older one — the frame reflects the last press")
  : bad("intents stacked instead of replacing: " + JSON.stringify(intents));

// Same person, different channel, is a separate intent.
insertIntent.run("sarah", "g1", "c2", "guess", "r4", now, now + 300000);
db.prepare("SELECT COUNT(*) n FROM activity_intents WHERE user_id='sarah'").get().n === 2
  ? ok("intents are per channel, so two channels don't fight over one player")
  : bad("intents are not scoped per channel");

try {
  insertIntent.run("evan", "g1", "c1", "sideways", null, now, now + 1);
  bad("an unknown intent kind was accepted");
} catch { ok("intent kind is constrained to draw or guess"); }

// A deleted drawing must not leave an intent pointing at it.
db.prepare("DELETE FROM rounds WHERE id = 'r4'").run();
db.prepare("SELECT COUNT(*) n FROM activity_intents WHERE round_id='r4'").get().n === 0
  ? ok("deleting a drawing clears any intent to open it")
  : bad("an intent outlived the drawing it pointed at");

// leaderboard shape
const insertScore = db.prepare(`
  INSERT INTO scores (guild_id, user_id, points, drawings, solves, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
insertScore.run("g1", "sarah", 120, 3, 9, now);
insertScore.run("g1", "jonah", 80, 2, 6, now);
insertScore.run("g2", "sarah", 40, 1, 2, now);

const board = db.prepare(
  "SELECT user_id, points FROM scores WHERE guild_id='g1' ORDER BY points DESC"
).all();
board.length === 2 && board[0].user_id === "sarah"
  ? ok("leaderboard is scoped per guild and sorted by points")
  : bad("leaderboard query returned " + JSON.stringify(board));

try {
  insertScore.run("g1", "sarah", 999, 0, 0, now);
  bad("a user has two score rows in one guild");
} catch { ok("one score row per user per guild"); }

console.log(failures ? `\n${failures} check(s) failed` : "\nSchema verified against a live database");
process.exit(failures ? 1 : 0);
