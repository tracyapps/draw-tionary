/*
 * SQLite-backed store.
 *
 * Uses Node's built-in node:sqlite, so there is no native module to compile
 * and nothing to install. Moving to Postgres later means reimplementing this
 * one file — nothing above it knows what database it is talking to.
 *
 * Run the server with --experimental-sqlite until Node marks it stable.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { STATUS } from "../lib/rounds.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function openStore(file = join(root, "draw-tionary.db")) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(readFileSync(join(root, "lib", "schema.sql"), "utf8"));

  const q = sql => db.prepare(sql);

  // ------------------------------------------------------------ rounds

  const insertRound = q(`
    INSERT INTO rounds (id, guild_id, channel_id, drawer_id, word, tier, points,
                        status, strokes, duration_ms, canvas_w, canvas_h,
                        created_at, posted_at, closed_at, removed_by, removed_reason, message_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      strokes = excluded.strokes,
      duration_ms = excluded.duration_ms,
      canvas_w = excluded.canvas_w,
      canvas_h = excluded.canvas_h,
      posted_at = excluded.posted_at,
      closed_at = excluded.closed_at,
      removed_by = excluded.removed_by,
      removed_reason = excluded.removed_reason,
      message_id = COALESCE(excluded.message_id, rounds.message_id)
  `);

  const selectRound  = q("SELECT * FROM rounds WHERE id = ?");
  const selectGuesses = q("SELECT * FROM guesses WHERE round_id = ? ORDER BY guessed_at");
  const selectFlags   = q("SELECT * FROM flags WHERE round_id = ?");

  const upsertGuess = q(`
    INSERT INTO guesses (id, round_id, user_id, guess, correct, awarded, guessed_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  const upsertFlag = q(`
    INSERT INTO flags (round_id, user_id, reason, flagged_at) VALUES (?,?,?,?)
    ON CONFLICT(round_id, user_id) DO NOTHING
  `);
  const clearFlags = q("DELETE FROM flags WHERE round_id = ?");

  function hydrate(row) {
    if (!row) return null;

    const guesses = selectGuesses.all(row.id).map(g => ({
      userId: g.user_id, guess: g.guess,
      correct: !!g.correct, awarded: g.awarded, at: g.guessed_at
    }));

    return Object.freeze({
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      drawerId: row.drawer_id,
      word: row.word,
      tier: row.tier,
      points: row.points,
      status: row.status,
      createdAt: row.created_at,
      postedAt: row.posted_at,
      closedAt: row.closed_at,
      drawing: row.strokes
        ? { strokes: JSON.parse(row.strokes), durationMs: row.duration_ms,
            width: row.canvas_w, height: row.canvas_h }
        : null,
      guesses,
      solvers: guesses.filter(g => g.correct).map(g => g.userId),
      flags: selectFlags.all(row.id).map(f => ({
        userId: f.user_id, reason: f.reason, at: f.flagged_at
      })),
      removedBy: row.removed_by,
      removedReason: row.removed_reason
    });
  }

  // ------------------------------------------------------------ api

  return {
    db,

    async getRound(id) {
      return id ? hydrate(selectRound.get(id)) : null;
    },

    /*
     * Writes the whole round. Guesses and flags are appended rather than
     * replaced, and the unique indexes in the schema are what actually stop
     * a double-tap from scoring twice — the check in rounds.js can be raced.
     */
    async saveRound(round, { guildId, channelId, messageId = null } = {}) {
      const existing = selectRound.get(round.id);
      const d = round.drawing;

      insertRound.run(
        round.id,
        guildId ?? existing?.guild_id ?? round.guildId ?? "",
        channelId ?? existing?.channel_id ?? round.channelId ?? "",
        round.drawerId, round.word, round.tier, round.points, round.status,
        d ? JSON.stringify(d.strokes) : null,
        d?.durationMs ?? null, d?.width ?? null, d?.height ?? null,
        round.createdAt, round.postedAt, round.closedAt,
        round.removedBy, round.removedReason,
        messageId ?? round.messageId ?? null
      );

      const known = new Set(selectGuesses.all(round.id).map(g => g.guessed_at + "|" + g.user_id));
      for (const g of round.guesses) {
        const key = g.at + "|" + g.userId;
        if (known.has(key)) continue;
        try {
          upsertGuess.run(randomUUID(), round.id, g.userId, g.guess,
                          g.correct ? 1 : 0, g.awarded ?? 0, g.at);
        } catch (e) {
          // the one-solve-per-user index fired: a genuine double submit
          if (!String(e.message).includes("UNIQUE")) throw e;
        }
      }

      if (round.flags.length === 0) clearFlags.run(round.id);
      for (const f of round.flags) upsertFlag.run(round.id, f.userId, f.reason, f.at);

      return round;
    },

    async setMessageId(roundId, messageId) {
      q("UPDATE rounds SET message_id = ? WHERE id = ?").run(messageId, roundId);
    },

    /** Words used recently in this server, so cards don't repeat. */
    async recentWords(guildId, limit = 40) {
      return q(`
        SELECT word FROM rounds
        WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?
      `).all(guildId, limit).map(r => r.word);
    },

    async openRounds(guildId, channelId, limit = 20) {
      return q(`
        SELECT id FROM rounds
        WHERE guild_id = ? AND channel_id = ? AND status = ?
        ORDER BY posted_at DESC LIMIT ?
      `).all(guildId, channelId, STATUS.OPEN, limit).map(r => this.getRound(r.id));
    },

    // ------------------------------------------------------------ sessions

    async createSession({ guildId, channelId, userId, card, issuedAt, expiresAt }) {
      const token = randomBytes(24).toString("base64url");
      q(`
        INSERT INTO draw_sessions (token, guild_id, channel_id, user_id, card, issued_at, expires_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(token, guildId, channelId, userId, JSON.stringify(card), issuedAt, expiresAt);
      return token;
    },

    async getSession(token, now = Date.now()) {
      const row = q("SELECT * FROM draw_sessions WHERE token = ?").get(token);
      if (!row) return null;
      if (row.expires_at < now) return null;
      return {
        token: row.token, guildId: row.guild_id, channelId: row.channel_id,
        userId: row.user_id, card: JSON.parse(row.card),
        roundId: row.round_id, consumedAt: row.consumed_at
      };
    },

    /** Binds a session to the round it produced. Single use. */
    async consumeSession(token, roundId, now = Date.now()) {
      const res = q(`
        UPDATE draw_sessions SET round_id = ?, consumed_at = ?
        WHERE token = ? AND consumed_at IS NULL AND expires_at >= ?
      `).run(roundId, now, token, now);
      return res.changes > 0;
    },

    // ------------------------------------------------------------ viewers

    /*
     * A grant is the thing that travels in a URL, so it is built to be worth
     * as little as possible: one use, about a minute, and good only for being
     * swapped for a cookie. Re-pressing the button rotates it, which quietly
     * kills any link already pasted somewhere.
     */
    async createViewGrant({ roundId, userId, guildId, channelId, isModerator = false, issuedAt, expiresAt }) {
      const token = randomBytes(24).toString("base64url");
      q(`
        INSERT INTO view_grants
          (token, round_id, user_id, guild_id, channel_id, is_moderator, issued_at, expires_at, consumed_at)
        VALUES (?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(round_id, user_id) DO UPDATE SET
          token = excluded.token,
          is_moderator = excluded.is_moderator,
          issued_at = excluded.issued_at,
          expires_at = excluded.expires_at,
          consumed_at = NULL
      `).run(token, roundId, userId, guildId, channelId, isModerator ? 1 : 0, issuedAt, expiresAt);
      return token;
    },

    /**
     * Spends a grant and hands back what it was carrying, or null.
     *
     * The UPDATE is the whole security property: `consumed_at IS NULL` in the
     * WHERE clause means two simultaneous requests cannot both win, so a
     * pasted link races and loses rather than being honoured twice.
     */
    async consumeViewGrant(token, now = Date.now()) {
      if (!token) return null;

      const claimed = q(`
        UPDATE view_grants SET consumed_at = ?
        WHERE token = ? AND consumed_at IS NULL AND expires_at >= ?
      `).run(now, token, now);

      if (claimed.changes === 0) return null;

      const row = q("SELECT * FROM view_grants WHERE token = ?").get(token);
      return {
        roundId: row.round_id,
        userId: row.user_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        isModerator: !!row.is_moderator
      };
    },

    /** The cookie. Identity only — what it may see is decided per round. */
    async createViewerSession({ userId, guildId, channelId, isModerator = false, issuedAt, expiresAt }) {
      const token = randomBytes(32).toString("base64url");
      q(`
        INSERT INTO viewer_sessions
          (token, user_id, guild_id, channel_id, is_moderator, issued_at, expires_at, last_seen_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(token, userId, guildId, channelId, isModerator ? 1 : 0, issuedAt, expiresAt, issuedAt);
      return token;
    },

    async getViewerSession(token, now = Date.now()) {
      if (!token) return null;
      const row = q("SELECT * FROM viewer_sessions WHERE token = ?").get(token);
      if (!row || row.expires_at < now) return null;

      // Cheap liveness signal; not written on every read to avoid a write
      // per page load. A minute's granularity is plenty.
      if (now - row.last_seen_at > 60_000) {
        q("UPDATE viewer_sessions SET last_seen_at = ? WHERE token = ?").run(now, token);
      }

      return {
        token: row.token,
        userId: row.user_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        isModerator: !!row.is_moderator
      };
    },

    /*
     * Pressing any button again refreshes the session in place rather than
     * minting a second one, and re-snapshots moderator status — otherwise
     * someone promoted this morning would keep yesterday's permissions until
     * their cookie ran out.
     */
    async refreshViewerSession(token, { guildId, channelId, isModerator, expiresAt }, now = Date.now()) {
      const res = q(`
        UPDATE viewer_sessions
        SET guild_id = ?, channel_id = ?, is_moderator = ?, expires_at = ?, last_seen_at = ?
        WHERE token = ?
      `).run(guildId, channelId, isModerator ? 1 : 0, expiresAt, now, token);
      return res.changes > 0;
    },

    // ------------------------------------------------------------ activity

    /*
     * Records why the Activity is about to open. Pressing a different button
     * replaces the previous intent, so the frame always reflects the last
     * thing the player actually pressed.
     */
    async setLaunchIntent({ userId, guildId, channelId, kind, roundId = null, at, expiresAt }) {
      q(`
        INSERT INTO activity_intents
          (user_id, guild_id, channel_id, kind, round_id, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(user_id, channel_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          kind = excluded.kind,
          round_id = excluded.round_id,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `).run(userId, guildId, channelId, kind, roundId, at, expiresAt);
    },

    /** Readable more than once — a reload should not lose your place. */
    async getLaunchIntent(userId, channelId, now = Date.now()) {
      const row = q(
        "SELECT * FROM activity_intents WHERE user_id = ? AND channel_id = ?"
      ).get(userId, channelId);

      if (!row || row.expires_at < now) return null;
      return {
        userId: row.user_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        kind: row.kind,
        roundId: row.round_id
      };
    },

    /** Called when the player moves on — "no thanks, deal me a word instead". */
    async clearLaunchIntent(userId, channelId) {
      return q(
        "DELETE FROM activity_intents WHERE user_id = ? AND channel_id = ?"
      ).run(userId, channelId).changes > 0;
    },

    async purgeExpiredSessions(now = Date.now()) {
      const drawn   = q("DELETE FROM draw_sessions WHERE expires_at < ?").run(now).changes;
      const grants  = q("DELETE FROM view_grants WHERE expires_at < ?").run(now).changes;
      const seen    = q("DELETE FROM viewer_sessions WHERE expires_at < ?").run(now).changes;
      const intents = q("DELETE FROM activity_intents WHERE expires_at < ?").run(now).changes;
      return drawn + grants + seen + intents;
    },

    // ------------------------------------------------------------ scores

    async applyScores(guildId, scoreMap, now = Date.now()) {
      const up = q(`
        INSERT INTO scores (guild_id, user_id, points, drawings, solves, updated_at)
        VALUES (?,?,?,0,0,?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          points = excluded.points, updated_at = excluded.updated_at
      `);
      for (const [userId, points] of scoreMap) up.run(guildId, userId, points, now);
    },

    /*
     * Recomputes every total from the rounds and guesses tables. The scores
     * table is a cache; this is the thing that makes it safe to be one.
     */
    async rebuildScores(guildId, now = Date.now()) {
      const rows = q("SELECT id FROM rounds WHERE guild_id = ?").all(guildId);
      const totals = new Map();

      const { roundScores } = await import("../lib/rounds.js");
      for (const { id } of rows) {
        for (const [u, p] of roundScores(hydrate(selectRound.get(id)))) {
          totals.set(u, (totals.get(u) || 0) + p);
        }
      }

      q("DELETE FROM scores WHERE guild_id = ?").run(guildId);
      const ins = q(`
        INSERT INTO scores (guild_id, user_id, points, drawings, solves, updated_at)
        VALUES (?,?,?,0,0,?)
      `);
      for (const [u, p] of totals) ins.run(guildId, u, p, now);
      return totals;
    },

    async scoreboard(guildId, limit = 10) {
      return q(`
        SELECT user_id AS userId, points FROM scores
        WHERE guild_id = ? AND points > 0
        ORDER BY points DESC, user_id ASC LIMIT ?
      `).all(guildId, limit);
    },

    close() { db.close(); }
  };
}
