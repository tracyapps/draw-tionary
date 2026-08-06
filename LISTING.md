# App Directory copy

Paste-ready text for the Discord Developer Portal → **App Directory / Store**.

Voice: playful, but the jokes are always aimed at the drawings, never at the
reader. The people you most want playing are the ones who think they can't
draw, and a listing that promises to laugh at them is a listing they close.

> **Check the limits in the portal before pasting.** Discord's published field
> limits weren't reachable when this was written, so everything below is
> written short on purpose. Where a field is tighter than expected, use the
> shorter variant rather than truncating mid-sentence.

---

## App name

```
Draw-tionary
```

---

## Short description

The one line on the directory card. Written to fit ~80 characters.

**Use this one:**

```
Pictionary for friends who are never online at the same time.
```
*(60 characters)*

Alternatives, if you want a different angle:

| Angle | Text | Chars |
|---|---|---|
| The async hook | `Pictionary for friends who are never online at the same time.` | 60 |
| The promise | `Draw a word. Come back later. Find out who guessed it.` | 53 |
| The joke | `Draw a word badly. Watch your friends guess worse.` | 49 |
| The reassurance | `Pictionary with no timer, no pressure, and 124 colors.` | 53 |

If a shorter field turns up somewhere, `Pictionary, but nobody has to be
online.` is 40 characters and still lands.

---

## Detailed description

Markdown is supported. Keep the first two lines strong — they're what shows
before "read more".

```markdown
**Pictionary, except nobody has to be online at the same time.**

Somebody draws a word. It lands in your channel. You guess it whenever you
next open Discord — on the bus, in a meeting you shouldn't be in, at 2am.
Nobody is waiting on you, and nobody is watching you draw.

### How a round goes

1. Run `/draw`. You get three words — an easy one, a medium one, and a hard
   one, worth more the harder they get.
2. Draw it. Pencil, finger, or mouse, all welcome. There's no timer, so take
   four seconds or take an hour.
3. Post it. Your drawing shows up in the channel with the word hidden behind
   a row of empty boxes.
4. Everyone else guesses. They can watch the whole thing being drawn, stroke
   by stroke, which is usually funnier than the finished picture.
5. Points go to whoever guesses it — and to you, for drawing something people
   could actually work out.

### Things we decided on purpose

**Wrong guesses cost nothing.** Guess as many times as you like. The failure
mode we care about is people not joining in, not people guessing badly.

**No timer, anywhere.** Not on drawing, not on guessing. The rush is the part
of Pictionary that keeps quiet people quiet.

**Everyone gets all 124 colors.** No unlocking, no points to spend, no
premium palette. They're just there.

**Being fast is a small bonus, not the whole game.** Guess early and you'll
earn a bit extra, but the window is generous and re-watching a drawing costs
nothing.

**Your drawings stay.** The thing you spent an hour on doesn't expire. Go
back and find it whenever you want.

### Keeping it friendly

Draw-tionary was built for a small community, so the moderation came first
rather than after something went wrong:

- Anyone can report a drawing, and reports stay anonymous
- Two reports hide a drawing automatically, pending a moderator
- Moderators can remove anything
- You can always delete your own work

### Commands

- `/draw` — get a word and a canvas
- `/scores` — see who's winning in this server
```

**Short version**, if the field is tighter than expected — the first three
paragraphs plus the command list, dropping "Things we decided on purpose"
and "Keeping it friendly". Those two sections are the ones that convince a
moderator, so keep them if you have the room.

---

## Bot permissions

The invite link on the landing page asks for permissions integer **`19456`**:

| Permission | Why |
|---|---|
| View Channel | You cannot post into a channel you cannot see |
| Send Messages | Posting the drawing |
| Embed Links | The post is an embed |

Nothing else, and **no privileged gateway intents** — this is an HTTP
interactions bot with no gateway connection, so Message Content, Server
Members and Presence are all unnecessary. Worth saying in the listing: it's
the most reassuring fact about the app.

Add **Attach Files** later, when Track B starts posting rendered drawings
(that would make it `52224`). Not before.

## Categories / tags

Pick from whatever the portal offers. Best fits, in order of how well they
describe the game:

1. **Games**
2. **Social**
3. **Fun**
4. **Creative** / **Art**, if it exists
5. **Utilities** — only if you need a fifth; it isn't one

Keywords worth working into the description if the portal indexes it:
*pictionary, drawing game, guessing game, party game, async, turn-based,
casual, art, doodle*.

---

## Command descriptions

These live in `bot/register-commands.js` and appear in Discord's autocomplete
as people type. Current text is good; these are slightly warmer:

| Command | Current | Suggested |
|---|---|---|
| `/draw` | Get a word and a canvas — draw it for everyone to guess | Get a word and a canvas. No timer, no pressure. |
| `/scores` | Show the Draw-tionary leaderboard for this server | See who's ahead in this server |

Discord caps command descriptions at 100 characters; both fit comfortably.

---

## Bot profile "About Me"

Around 190 characters, the same limit as a user bio.

```
Pictionary that waits for you. Somebody draws, everybody guesses, nobody has
to be online at the same time. /draw to start.
```
*(122 characters)*

---

## Notes on the icon

The current icon — a chunky pencil with a rainbow scribble under it — reads
well at thumbnail size, which is the hard part. Two things worth checking
before it ships:

- **The 20px test.** Discord renders app icons as small as 20px. Squint at it
  at that size: the pencil should still read as a pencil, and the scribble
  should read as color rather than mud.
- **The circular mask.** Discord crops app icons and bot avatars to a circle.
  The scribble currently runs close to the bottom-right corner, which is
  exactly where a circular mask cuts hardest — worth confirming nothing
  important is lost.

The rainbow scribble is doing real work here: it's the one element that says
"this is about color" at a glance, and it backs up the "all 124 colors,
free" line in the description.
