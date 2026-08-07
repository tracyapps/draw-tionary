# Getting the bot running

Everything below assumes you're in the project folder. There is nothing to
`npm install` for the server — it uses only what ships with Node 22.

## 1. Create the app

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application** → name it Draw-tionary
2. **General Information** → copy the **Application ID** and **Public Key**
3. **Bot** → **Reset Token**, copy it. This is a password; treat it like one.
4. **Installation** → add scopes `bot` and `applications.commands`, and bot
   permissions **`View Channel`**, `Send Messages`, `Embed Links` — permissions
   integer `19456`. Use the generated link to add it to your test server.

   `View Channel` looks unnecessary, since the bot only ever posts and never
   reads anything. Leave it out and every post fails with:

   ```
   403 {"message": "Missing Access", "code": 50001}
   ```

   Note that is **50001 Missing Access**, not 50013 Missing Permissions. 50013
   means "can see the channel, can't do that here"; 50001 means "can't see the
   channel at all", which reads like the bot was never added to the server and
   sends you hunting through channel overrides. You cannot post into a channel
   you cannot see.

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
npm run dev
```

`dev` reads `.env`; `start` does not, and that difference is deliberate —
Railway and Fly inject real environment variables and have no `.env` file, so
a `--env-file` flag in `start` would crash the container on boot.

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

The script reads the existing commands first and carries any **Entry Point**
command through untouched. That is the "Launch" item Discord creates when you
enable Activities, and it belongs to the Activity rather than to us. Without
that step the bulk replace would delete it, and Discord rightly refuses:

```
400 {"code": 50240, "message": "You cannot remove this app's Entry Point
command in a bulk update operation."}
```

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

## Running as a Discord Activity

An Activity is the game running in an iframe inside Discord, launched from the
App Launcher or from a button, rather than opened as a link in a browser. It is
**not** voice-only — text channels and DMs both work, which is how Wordle does
async play.

This is built but **not proven**. See the honest caveat at the end.

### How it hangs together

**Entry point.** Discord loads the root of the mapped domain, and the root
mapping's prefix is fixed at `/`. So `/` serves two things: the landing page to
an ordinary browser, and `app/activity.html` when Discord frames it. They are
told apart by the `frame_id` query parameter Discord adds.

**Identity.** There is no `?t=` token — nobody ran a slash command. The frame
asks Discord to authorize it, gets a short code, and posts it to `/api/token`.
The server trades that for an access token using `DISCORD_CLIENT_SECRET`, reads
the user, and sets the same viewer cookie the replay pages use.

**Why it opened.** Discord tells the frame which channel it is in, but not
which button was pressed — `/draw` and Guess look identical from inside. So the
interaction handler writes an `activity_intents` row, and the frame asks
`/api/activity/context` once it knows who it is. Guess lands you on that
drawing; anything else deals a card. There is always a way out into your own
card, which clears the intent so a reload doesn't drag you back.

**The proxy.** An Activity is sandboxed and cannot reach external origins. Every
request from the frame goes through `/.proxy/…`, which is why the page prefixes
its own fetches. It also means the Embedded App SDK is **vendored** into
`app/vendor/` by `npm run build` rather than loaded from a CDN — a CDN would
need a URL mapping for somebody else's domain.

### Turning it on

| Variable | Value |
|---|---|
| `DISCORD_CLIENT_SECRET` | OAuth2 → Client Secret. Treat like the bot token. |
| `ACTIVITY_ENABLED` | `1` to make `/draw` and Guess open the Activity |
| `EMBEDDED_ACTIVITY` | `1` so the cookie works in a third-party frame |

`EMBEDDED_ACTIVITY` switches the viewer cookie to
`SameSite=None; Secure; Partitioned`, which is the only thing a browser sends
inside an iframe. It needs HTTPS; over plain `http` locally the cookie stays
`Lax`, because a browser drops a `None` cookie without `Secure` and nothing
would work at all.

`ACTIVITY_ENABLED` is off by default on purpose. The link-out flow is tested end
to end and known good; leaving the flag off means the Activity can be developed
without anybody's game breaking.

### In the Developer Portal

**OAuth2 → Redirects → add `https://127.0.0.1` → Save.**

Do this first. It is a placeholder that nothing ever redirects to — the SDK
handles returning the user to the Activity itself — but OAuth2 refuses to issue
a code for an app with no redirect configured at all. Skip it and `authorize()`
fails with:

```
OAuth2 Error: invalid_request: Missing "redirect_uri" in request.
```

which reads like a bug in the Activity rather than an empty field in a
settings page three tabs away.

**Installation → Default Install Settings.** This is the one that decides
whether people who find the app in the App Directory get a working game.

The "Add App" button there is a *Discord Provided Link* — it carries no scopes
in the URL and uses whatever these settings say. Under **Guild Install**:

| Field | Value |
|---|---|
| Scopes | `applications.commands`, **`bot`** |
| Permissions | View Channel, Send Messages, Embed Links |

Omit `bot` and every discovery install produces an app with no bot in the
server: the Activity opens, drawings save, and nothing ever posts. The player
sees "saved but couldn't post" and there is nothing they can do about it.

Run `npm run app:urls` to read the current settings back and have the missing
pieces named.

**On User Install:** a user install never carries a bot. Someone who installs
that way can open the Activity but cannot post a drawing, which is a broken
game. Prefer Guild Install for this app, and only enable User Install if you
have decided what a bot-less player should see.

**Activities → Settings**: tick **Enable Activities**, and tick the platforms
(web, iOS, Android) you want it to appear on. It will not show in the App
Launcher on a platform you haven't ticked.

Activities → **URL Mappings**. You need exactly one:

| Prefix | Target |
|---|---|
| `/` | your domain |

**Delete any proxy path mappings pointing at your own domain.** Those are an
allowlist for *external* hosts you want to reach from the sandbox. A mapping
like `/draw → your-domain` actively misroutes, because targets resolve to a
directory — it sends `/draw` to your homepage.

Then Activities → **Settings** → tick the platforms you want it to appear on,
or it won't show in the shelf on that platform.

### What has not been verified

Everything reachable from outside Discord is tested: the framed-versus-public
routing, the client id substitution, the SDK serving as JavaScript with its
whole 69-module import graph resolving, the token endpoint's failure modes, and
the intent lifecycle.

**The handshake itself has never run.** `sdk.ready()`, `authorize()`,
`authenticate()` and the `/.proxy` prefix can only be exercised inside a real
Discord client, which no test here can do. Expect iteration.

The likeliest thing to need changing: after authenticating, the frame
**navigates** to the canvas or replay page. That reuses one implementation of
drawing and guessing instead of maintaining two, but Discord documents
Activities as single-page apps, and a navigation tears down the SDK connection.
Nothing after that point needs the SDK, so it should be fine — but if the frame
goes blank or reloads oddly, that navigation is the first thing to suspect, and
the fix is to render those views in-page instead.

## Checks

```
npm run check
```

Runs the page bundles, 130 unit tests, 103 DOM smoke checks across the spike
and app pages, 37 schema checks against a live database, and a 79-step
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
3. **Variables** — service → Variables tab. Not `.env`, which is gitignored
   and never reaches the server.

   | Variable | Value | Secret? |
   |---|---|---|
   | `DISCORD_APP_ID` | General Information → Application ID | no |
   | `DISCORD_PUBLIC_KEY` | General Information → Public Key | no |
   | `DISCORD_BOT_TOKEN` | Bot → Reset Token | **yes** |
   | `DB_FILE` | `/data/draw-tionary.db` | no |
   | `PUBLIC_URL` | your https URL, no trailing slash | no |
   | `PORT` | `3000` | no |

   Set `PORT` explicitly rather than relying on auto-detection. Railway asks
   for a **target port** when you attach a domain, and that number has to match
   the port the process is actually listening on. Pinning it to 3000 means the
   Dockerfile, the variable and the domain all agree, instead of three places
   that can quietly drift apart.

   `DISCORD_GUILD_ID` is not a server variable. It only matters to
   `npm run register`, which you run from your own machine.

   `EMBEDDED_ACTIVITY` stays unset until the pages run inside an Activity
   iframe.
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

### Pointing a domain at it (Namecheap)

Service → **Settings → Networking → Public Networking → + Custom Domain**.
It asks for a **target port**: enter `3000`.

Railway then gives you a CNAME target and a TXT record. **Both are required.**
Skipping the TXT is the classic mistake, and the symptom is misleading —
requests return **404 even after the CNAME resolves**, so it reads like a
broken app rather than an unverified domain.

Namecheap → Domain List → Manage → **Advanced DNS**:

| Type | Host | Value |
|---|---|---|
| ALIAS Record | `@` | the target Railway shows you |
| TXT Record | as shown | as shown |

Certificates issue within about an hour of DNS updating.

Namecheap's BasicDNS supports ALIAS at the apex, which is what makes a bare
domain work — Railway has no static IP, so a plain A record isn't an option.
Cloudflare's CNAME flattening does the same job if you'd rather keep DNS
there; if you do, set the record to DNS-only (grey cloud) until the
certificate issues, because proxying can stall it.

A subdomain like `play.example.app` is a plain CNAME and avoids the question
entirely. Nobody types this URL — it lives behind a Discord button.

**On `.app` domains:** the whole TLD is HSTS-preloaded, so browsers refuse
plain http with no click-through. Until DNS resolves and the certificate
issues, the domain won't load at all — that's expected, not a broken deploy.

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

The symptom in Discord is a button on an older drawing replying "That drawing
is no longer around" — which reads like the round was deleted rather than like
the database was.

**Setting `DB_FILE` is only half of it.** The variable says where to write; it
cannot attach a volume. And because the Dockerfile creates `/data` so the very
first boot has somewhere to go, the directory exists and accepts writes
whether or not a volume was ever attached. Permissions cannot tell the two
apart — which is exactly how a database ends up inside a container layer.

Three things guard against it, in order of how early they catch it:

**1. No `DB_FILE` in production is a refusal.** Unset means the database is
written beside the source, which in a container is inside the image and gone
on the next deploy. There is no safe default, so the server stops and says so
rather than guessing.

**2. An unwritable `DB_FILE` directory is a refusal.** A volume mounted with
the wrong ownership fails the deploy loudly.

**3. The boot log answers the rest directly.** `/proc/mounts` knows whether
`/data` is a real mount, so the server just asks:

```
  database: /data/draw-tionary.db
  volume: /data is a mounted volume
  this database: 24 days old, boot 37
  contents: 4 posted drawings, 11 guesses, 3 players
```

If the volume line says **is NOT a mount — it is part of the container image**,
that is the whole bug, printed on the first boot. And a database being
recreated every deploy can only ever say **boot 1**, so either line catches it
without having to remember yesterday's numbers.

### Attaching the volume on Railway

**Volumes are not in service settings.** They are not in project settings or
workspace settings either. You create one from the **project canvas** — the
board with the service tiles on it:

- press `⌘K` and choose **Volume**, or
- right-click the empty canvas → **Volume**

Railway then asks which service to attach it to, and *then* asks for the mount
path. Set it to exactly `/data`.

Three things have to be true, all on the same service:

1. A volume exists and is attached to **this** service
2. Its mount path is exactly `/data` — not `/app/data`, not `/data/`
3. `DB_FILE` = `/data/draw-tionary.db`

**And one more, or the deploy will fail:**

```
RAILWAY_RUN_UID=0
```

Railway mounts volumes as `root`. This image deliberately runs as the `node`
user, so a freshly attached volume is a directory the app cannot write to —
and the server will refuse to boot rather than carry on. `RAILWAY_RUN_UID=0`
is Railway's documented answer, and there isn't another one: you cannot chown
a directory you have no write access to.

It does mean running as root inside the container, which is a real trade
against the `USER node` line in the Dockerfile. It is a single-tenant
container running one Node process with no shell exposed, so the exposure is
small — but it is not nothing, and it is worth knowing you made the choice.

The boot log distinguishes the two failures, so you will not have to guess
which one you are looking at.

### Two Railway caveats worth knowing

- **A service with a volume cannot use replicas.** `railway.json` already pins
  `numReplicas: 1`, so nothing to do — but don't raise it later.
- **Deploys with a volume attached have a moment of downtime**, healthcheck or
  not. Railway will not run two deployments against one volume, so the old one
  stops before the new one starts. Seconds, and it protects the database.

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
