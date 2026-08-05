-- Draw-tionary schema
--
-- Written to run unchanged on SQLite (local development) and Postgres
-- (production). That means:
--   * TEXT for ids rather than SERIAL/AUTOINCREMENT
--   * INTEGER millisecond timestamps rather than a date type
--   * TEXT for JSON rather than JSONB
--
-- On Postgres, three optional upgrades are worth making once things settle:
-- change the JSON columns to JSONB, timestamps to TIMESTAMPTZ, and add a
-- GIN index if you ever query inside the stroke data. None of that changes
-- the application code.

-- ---------------------------------------------------------------- rounds

CREATE TABLE IF NOT EXISTS rounds (
  id            TEXT PRIMARY KEY,

  -- Discord identifiers. guild_id lets one deployment serve several servers
  -- without their scoreboards or drawings ever mixing.
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  message_id    TEXT,                    -- set once the bot posts it
  drawer_id     TEXT NOT NULL,

  -- The answer. Never send this column to a client; go through publicView().
  word          TEXT NOT NULL,
  tier          TEXT NOT NULL CHECK (tier IN ('easy', 'medium', 'hard')),
  points        INTEGER NOT NULL,

  status        TEXT NOT NULL DEFAULT 'drafting'
                CHECK (status IN ('drafting', 'open', 'hidden', 'removed')),

  -- Stroke data as JSON: [{c, w, e, p: [[x, y, pressure, t], ...]}, ...]
  -- Coordinates are normalised against canvas WIDTH for both axes, so a
  -- drawing replays without skew at any size. ~75 KB gzipped for an
  -- elaborate 12,000-point scene.
  strokes       TEXT,
  duration_ms   INTEGER,
  canvas_w      INTEGER,
  canvas_h      INTEGER,

  -- Rendered artefacts live in object storage; these are just keys.
  still_key     TEXT,
  replay_key    TEXT,

  created_at    INTEGER NOT NULL,
  posted_at     INTEGER,
  closed_at     INTEGER,

  removed_by    TEXT,
  removed_reason TEXT
);

CREATE INDEX IF NOT EXISTS rounds_channel_open
  ON rounds (guild_id, channel_id, status, posted_at DESC);

CREATE INDEX IF NOT EXISTS rounds_by_drawer
  ON rounds (drawer_id, created_at DESC);

-- Finding a round from the Discord message someone clicked on.
CREATE UNIQUE INDEX IF NOT EXISTS rounds_by_message
  ON rounds (message_id) WHERE message_id IS NOT NULL;

-- ---------------------------------------------------------------- guesses

CREATE TABLE IF NOT EXISTS guesses (
  id            TEXT PRIMARY KEY,
  round_id      TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,

  guess         TEXT NOT NULL,
  correct       INTEGER NOT NULL DEFAULT 0,   -- 0/1, portable boolean
  awarded       INTEGER NOT NULL DEFAULT 0,
  guessed_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS guesses_by_round
  ON guesses (round_id, guessed_at);

-- One correct guess per person per round. Enforced in the database as well
-- as in rounds.js, because two taps on a slow connection can otherwise race
-- through the application check and score twice.
CREATE UNIQUE INDEX IF NOT EXISTS guesses_one_solve_per_user
  ON guesses (round_id, user_id) WHERE correct = 1;

CREATE INDEX IF NOT EXISTS guesses_by_user
  ON guesses (user_id, correct);

-- ---------------------------------------------------------------- flags

CREATE TABLE IF NOT EXISTS flags (
  round_id      TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT 'other',
  flagged_at    INTEGER NOT NULL,

  -- One flag per person per round, so nobody can hide a drawing alone.
  PRIMARY KEY (round_id, user_id)
);

CREATE INDEX IF NOT EXISTS flags_by_round ON flags (round_id);

-- Moderator decisions, kept separately so clearing flags doesn't erase the
-- record that a review happened.
CREATE TABLE IF NOT EXISTS moderation_log (
  id            TEXT PRIMARY KEY,
  round_id      TEXT NOT NULL,
  moderator_id  TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('restore', 'remove', 'dismiss')),
  reason        TEXT,
  acted_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS modlog_by_round ON moderation_log (round_id, acted_at);

-- ---------------------------------------------------------------- sessions

-- Links a Discord user to a browser tab.
--
-- The flow: /draw mints a token, deals a card, and sends the drawer a private
-- link. The canvas app trades the token for the card. The token is bound to
-- one user, expires quickly, and is consumed on first use — so a link pasted
-- into a public channel by accident is worth nothing to whoever finds it.
--
-- The dealt card is stored HERE, server-side, and the client may only choose
-- from it. If the browser dealt its own card, nothing would stop someone
-- editing the request to claim a hard word's 35 points for drawing "cat".
CREATE TABLE IF NOT EXISTS draw_sessions (
  token         TEXT PRIMARY KEY,

  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,

  -- JSON: [{tier, word, points} x3] — the only words this session may pick.
  card          TEXT NOT NULL,

  -- Null until the drawer chooses a word; set when the round is created.
  round_id      TEXT REFERENCES rounds(id) ON DELETE CASCADE,

  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS sessions_expiry ON draw_sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_by_user ON draw_sessions (user_id, issued_at DESC);

-- Identifying whoever is watching a replay.
--
-- The "Watch it draw" button in a channel post is pressed by many different
-- people, and the replay has to know which one — a solver should see the
-- answer they earned, everyone else should not. A plain URL in the message
-- cannot carry that, because it is the same URL for the whole channel. So the
-- button is a real interaction: Discord tells us who pressed it.
--
-- That identity then has to survive the trip into a browser, and this is
-- where it gets done in two steps rather than one.
--
-- A token in the query string is a bearer credential sitting in the address
-- bar. It ends up in browser history, in referer headers, in screenshots, and
-- — the one that actually happens — in a message when somebody pastes their
-- own link back into the channel to show people the drawing. Whoever clicks
-- it is then treated as them.
--
-- So the URL carries a GRANT: single use, about a minute long, good for
-- nothing but being swapped. The swap sets an httpOnly cookie and redirects
-- to a clean URL. A pasted link is already spent by the time anyone else
-- opens it, and the credential that replaced it cannot be read by script or
-- copied out of the address bar.

CREATE TABLE IF NOT EXISTS view_grants (
  token         TEXT PRIMARY KEY,

  round_id      TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,

  -- Carried through so the session it creates knows where it came from.
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,

  -- Snapshot of the permission at press time. A moderator sees hidden
  -- drawings; re-checking later would need a Discord round trip per load.
  is_moderator  INTEGER NOT NULL DEFAULT 0,

  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS view_grants_expiry ON view_grants (expires_at);

-- One live grant per person per round. Pressing the button again rotates it,
-- which also means the link you pasted five minutes ago stops working.
CREATE UNIQUE INDEX IF NOT EXISTS view_grants_one_per_viewer
  ON view_grants (round_id, user_id);

-- The cookie behind the replay pages.
--
-- Deliberately NOT scoped to a round. Identity is a Discord user; what they
-- are allowed to see is worked out per round by publicView(). Scoping the
-- cookie to one drawing would mean pressing the button again for every
-- replay, which on a busy server is most of them.
--
-- Several rows per user is normal and correct — a phone and a laptop are two
-- sessions, and signing out of one should not sign out of the other.
CREATE TABLE IF NOT EXISTS viewer_sessions (
  token         TEXT PRIMARY KEY,

  user_id       TEXT NOT NULL,

  -- Where they were last seen pressing a button. Only used as a fallback;
  -- the "your turn" button deals into the channel of the round being watched,
  -- so this does not decide where a drawing lands.
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,

  is_moderator  INTEGER NOT NULL DEFAULT 0,

  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS viewer_sessions_expiry ON viewer_sessions (expires_at);
CREATE INDEX IF NOT EXISTS viewer_sessions_by_user
  ON viewer_sessions (user_id, last_seen_at DESC);

-- ---------------------------------------------------------------- scores

-- Denormalised running totals. The source of truth is always guesses +
-- rounds; this exists so the leaderboard doesn't recompute the world on
-- every request. Rebuildable from scratch at any time.
CREATE TABLE IF NOT EXISTS scores (
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  points        INTEGER NOT NULL DEFAULT 0,
  drawings      INTEGER NOT NULL DEFAULT 0,
  solves        INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,

  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS scores_leaderboard
  ON scores (guild_id, points DESC);

-- ---------------------------------------------------------------- retention

-- Nothing here deletes itself. Two jobs are worth running:
--
--   1. Expired sessions -- DELETE FROM draw_sessions WHERE expires_at < ?
--      Safe to run often; they are worthless once expired.
--
--   2. Old removed rounds. A drawing removed by a moderator should keep its
--      row (so the moderation log makes sense) but its strokes and storage
--      keys can be nulled out after a cooling-off period:
--
--        UPDATE rounds SET strokes = NULL, still_key = NULL, replay_key = NULL
--        WHERE status = 'removed' AND closed_at < ?
--
-- Drawings people are proud of should NOT expire. The whole point is that
-- someone can go back and find the thing they spent an hour on.
