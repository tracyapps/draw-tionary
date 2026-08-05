# Getting the bot running

Everything below assumes you're in the project folder. There is nothing to
`npm install` for the server — it uses only what ships with Node 22.

## 1. Create the app

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application** → name it Draw-tionary
2. **General Information** → copy the **Application ID** and **Public Key**
3. **Bot** → **Reset Token**, copy it. This is a password; treat it like one.
4. **Installation** → add scopes `bot` and `applications.commands`,
   bot permissions `Send Messages` and `Embed Links`, then use the generated
   link to add it to your test server.

Copy `.env.example` to `.env` and fill in what you collected.

## 2. Give Discord a URL it can reach

Discord POSTs interactions to your server, so `localhost` won't do. During
development, tunnel it:

```
cloudflared tunnel --url http://localhost:3000
```

That prints a public HTTPS URL. Put it in `PUBLIC_URL`.

## 3. Start the server

```
npm start
```

Then in the Developer Portal, **General Information → Interactions Endpoint
URL**, enter `<your tunnel URL>/interactions` and save.

Discord immediately sends a signed PING and refuses the URL if the signature
check doesn't work. If it saves, verification is working.

## 4. Register the commands

```
npm run register
```

With `DISCORD_GUILD_ID` set, `/draw` and `/scores` appear in that server
straight away. Without it they register globally and can take an hour.

## 5. Play a round

In your server: `/draw` → open the private link → pick a word → draw →
submit. The bot posts it to the channel with a **Guess** button.

---

## What runs where

| Piece | Where it lives | Notes |
|---|---|---|
| Rules | `lib/game.js`, `lib/rounds.js` | Pure functions, no I/O. 103 tests. |
| Interaction routing | `lib/interactions.js` | Store injected, so it tests without a database. |
| Signature check | `lib/verify.js` | Ed25519 via `node:crypto`. |
| Storage | `bot/store.js` | SQLite via `node:sqlite`. Swap this one file for Postgres. |
| HTTP | `bot/server.js` | `node:http`. No framework. |
| Canvas | `app/draw.html` | What players get. Served at `/draw?t=…`. |
| Replay player | `app/watch.html` | Served at `/watch/:id`. |
| Prototypes | `spike/` | Not served. Kept for device testing — see below. |

### app/ and spike/ are not the same thing

`spike/draw.html` still carries the diagnostics panel: live pointer type,
pressure, tilt, coalesced event counts, and a verdict on whether a given
stylus works. That is how the input questions got answered in the first
place, and it stays there for the next time a device behaves oddly. Open it
straight off the filesystem — no server needed.

`app/draw.html` is the same canvas with the diagnostics removed and the
server wiring added. Players never see a debug panel, and the spike never
needs a session.

Both are covered by `npm run smoke`, so the two cannot silently diverge.

## The round trip

1. `/draw` → the bot deals three words **server-side**, stores them on a
   session, and replies with a private, expiring link.
2. `app/draw.html` fetches `/api/session?t=…` for the card. It never picks
   its own words — if it did, anyone could edit the request and claim a hard
   word's 35 points for drawing a cat.
3. Submit POSTs the strokes to `/api/submit`. The server checks the word was
   actually on that card, saves the round, then posts to the channel.
4. The channel post's **Guess** button opens the letter modal. **Watch it
   draw** hands the presser a personal link to `app/watch.html`.
5. The replay page shows what that viewer did last time and offers **Your
   turn**, which mints them a canvas without a trip back to the slash command.

The answer never reaches a client that hasn't earned it — `publicView` in
`lib/rounds.js` decides that, and both the endpoint and the page markup are
asserted against leaks in `tools/e2e.js`.

### How the replay page knows who you are

A link button in a channel post is one URL for everybody who clicks it, so
the replay page could never tell a solver from a stranger — and showing
someone the masked word they already beat reads as the game having forgotten
them. So "Watch it draw" is a real interaction: Discord tells us who pressed.

Getting that identity into a browser happens in two steps, and the second one
is the important one.

**The grant.** The ephemeral reply contains `/watch/:id?g=GRANT`. A grant is
single use and lives about 90 seconds. It is good for nothing except being
swapped.

**The swap.** Opening that URL spends the grant, sets an `HttpOnly` cookie,
and 302s to a bare `/watch/:id`. Everything after that — reloads, the back
button, other rounds — runs on the cookie, which lasts a week.

Why bother: a token in a query string is a bearer credential sitting in the
address bar. It lands in browser history, in referer headers, in screenshots,
and — the one that actually happens — in a message, when somebody pastes
their own replay link into the channel to show people the drawing. Anyone
clicking that paste would be treated as them, see answers they hadn't earned,
and be able to start a round in their name.

With the swap, a pasted link is already spent by the time anyone else opens
it. They still get the page; they just get it as nobody. The credential that
replaced it can't be read by script or copied out of the URL bar.

The cookie is identity only, deliberately not scoped to a round — `publicView`
decides per round what that person may see. Scoping it per drawing would mean
pressing the button again for every post in the channel.

`tools/e2e.js` asserts all of this against the real server, including the
paste case.

### Running as a Discord Activity

Inside an Activity the pages run in a third-party iframe, where a `SameSite=Lax`
cookie is simply not sent. Set `EMBEDDED_ACTIVITY=1` and serve over HTTPS and
the cookie switches to `SameSite=None; Secure; Partitioned`, which is what
works there. Over plain `http` locally it stays `Lax`, because a browser drops
a `None` cookie without `Secure` and nothing would work at all.

## Checks

```
npm run check
```

Runs the page bundles, 122 unit tests, 103 DOM smoke checks across the spike
and app pages, 32 schema checks against a live database, and a 57-step
end-to-end round over real HTTP with real Ed25519 signatures.

## Deploying

This is a long-running Node process that owns a SQLite file on disk. That
rules out serverless hosts — Vercel, Netlify Functions, Cloudflare Workers.
Not because of a setting, but because there is no always-on process to hold
the webhook and no persistent disk for the database. A SQLite file on an
ephemeral filesystem looks like it works and then silently loses every drawing
at the next deploy.

What it needs is boring: one container, one small volume. `Dockerfile`,
`fly.toml` and `railway.json` are in the repo and cover it.

### Railway

1. **New Project → Deploy from GitHub repo.** It reads `railway.json` and
   builds the Dockerfile.
2. **Add a volume**, mount path `/data`. This is the step that matters — see
   the warning below.
3. **Variables:**

   | Variable | Value |
   |---|---|
   | `DISCORD_PUBLIC_KEY` | from the Developer Portal |
   | `DISCORD_BOT_TOKEN` | from the Bot tab |
   | `DISCORD_APP_ID` | from General Information |
   | `DB_FILE` | `/data/draw-tionary.db` |
   | `PUBLIC_URL` | your real https URL, no trailing slash |

   `PORT` is injected by Railway; don't set it.
4. **Generate a domain** (or attach your own), then set `PUBLIC_URL` to it and
   redeploy. `PUBLIC_URL` is what the bot writes into every link, so a stale
   value produces buttons that go nowhere.

### Fly

```
fly launch --no-deploy            # say no when it offers a database
fly volumes create data --size 1 --region <region>
fly secrets set DISCORD_PUBLIC_KEY=... DISCORD_BOT_TOKEN=... DISCORD_APP_ID=...
fly deploy
```

Edit `app` and `PUBLIC_URL` in `fly.toml` first — Fly app names are global.

### Then point Discord at it

Developer Portal → General Information → **Interactions Endpoint URL** =
`https://your-domain/interactions`. Discord sends a signed PING and refuses
the URL if verification fails, so a successful save means it's working. Then
run `npm run register` with `DISCORD_GUILD_ID` set.

### Keep it to one instance

SQLite has a single writer. Two replicas means two containers with two
different databases and no error anywhere to tell you — scores and drawings
would appear and disappear depending on which one served the request.
`railway.json` pins `numReplicas: 1` and `fly.toml` uses a single mounted
machine. Don't raise either until the store moves to Postgres.

### Don't let it scale to zero

Discord retries an interaction that doesn't respond within 3 seconds. A cold
start blows that budget, and to players it looks like the bot ignoring them.
`fly.toml` sets `min_machines_running = 1` for this reason. It's the main
thing you're paying for — roughly a couple of dollars a month.

### The volume mistake worth knowing about

If `DB_FILE` points somewhere the volume isn't mounted, SQLite cheerfully
creates the file on the container's own disk. Everything looks healthy until
the next deploy wipes it.

`bot/server.js` checks the directory is writable at startup and refuses to
boot if it isn't, so a genuinely unmounted volume fails the deploy loudly. But
it cannot tell a mounted `/data` from an unmounted one that happens to be
writable — so confirm the mount path and `DB_FILE` agree. Deploy twice and
check your scores survived; that's the real test.

### Later, when you outgrow this

- **Postgres instead of SQLite** once you want more than one instance.
  `bot/store.js` is the only file that changes.
- **Object storage for rendered images.** The schema has `still_key` and
  `replay_key` columns waiting; nothing writes them yet.

## Not built yet

- Rendering the replay to a GIF or PNG for the channel post — the embed is
  currently text and a button, with no picture in it
- A moderator view for reviewing hidden drawings. Two reports auto-hide a
  drawing and the status persists, but there's no UI to act on it
- Deleting your own drawing from the channel post. `componentDelete` handles
  it; no button is wired to it yet
- Updating the channel post after a solve. The embed still says "nobody has
  guessed it yet" until someone reposts; `setMessageId` stores what's needed
  to edit it
