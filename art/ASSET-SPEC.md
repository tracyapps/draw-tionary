# Draw-tionary — art asset spec

Templates with safe-area guides live in `art/templates/`. Open them in Affinity,
put artwork below the `guides` group, hide that group to export.

Regenerate with `node tools/build-art-templates.js`.

Sizes marked **[Discord]** come from Discord's official Activity docs. Sizes
marked **[ours]** are project decisions we can change freely.

---

## 1. Discord platform assets

These are what people see *before* they open the game — in the Activity Shelf,
the app's detail view, and next to the bot's messages.

| Asset | Size | Format | Where it appears |
|---|---|---|---|
| App icon | 1024 × 1024 **[Discord]** | PNG | Activity Shelf, search, app detail. Masked to a circle. |
| Bot avatar | 1024 × 1024 **[Discord]** | PNG | Beside every message the bot posts. Also circular. |
| Cover art | 2048 × 1732 (13:11) **[Discord]** | PNG/JPG | The main Shelf image. Should carry the title. |
| Embedded background | 1920 × 1080 (16:9) **[Discord]** | PNG/JPG | Background overlay in Grid view. |
| Video preview | 640 × 360, < 10s, < 1 MB **[Discord]** | MP4 | Plays on hover over the cover art. |

### App icon — the constraint that matters

It renders as small as **20px**. Whatever you design has to survive that.
One shape, high contrast, no fine linework, no text. The template marks a
500px central square that stands in for "still legible when tiny" — if the
idea doesn't read inside that box at thumbnail scale, it won't read in Discord.

Discord's own games are a useful reference: Sudoku Together is a grid with one
checkmark, Letter League is a single letter tile. One idea each.

### Cover art — the 13:11 vs 16:9 trap

Discord crops the same file to **both** ratios depending on whether it's shown
as a 1-up featured tile or a 2-up regular tile. The artboard is the taller
13:11; the magenta band marks the 16:9 crop.

**Anything essential — the title especially — has to sit inside that band.**
The top and bottom 290px will be cut off in some views. Background scenery
can bleed into them.

### Embedded background — keep the middle empty

Discord draws its own UI over the centre of this one. The template shades the
centre 60% in pink to show where not to put anything. Think of it as a border
illustration: characters, doodles, and props clustered around the edges.

Given the game, an obvious move is filling the margins with drawings people
have actually made — which means this asset gets better after launch.

### Video preview — nearly free for us

Under 1 MB for 10 seconds is a tight budget for video, but a drawing replay
is flat colour on a white background, which compresses extremely well. Record
a sped-up replay of one good drawing and it will come in well under budget.

---

## 2. What gets posted in the channel

The bot's message is the game's real front page — it's what people scroll
past in `#games`. Based on how Sudoku Together and Wordle appear in your
server, the pattern is: small bot avatar, one line of text, one image, one
button.

| Asset | Size | Format | Notes |
|---|---|---|---|
| Drawing replay | 1200 × 900 **[ours]** | GIF or WebP | Discord shows embedded images ~550px wide, so 1200 gives a crisp 2x. |
| Drawing still | 1200 × 900 **[ours]** | PNG | Fallback and the "save my art" export. |
| Tier badges | 200 × 109 **[ours]** | SVG | Gauge dials. Read down to ~24px tall; see below. |

### Tier badges — what the gauges can and can't do

`easy.svg`, `medium.svg`, `hard.svg` are half-round gauge dials: green needle
left, amber needle up, red needle right.

**They encode tier twice** — by needle angle and by color. That is the reason
to keep this design rather than a colored pill: red/green colorblindness does
not break them, because the needle carries the meaning on its own. Anything
that replaces these should hold that property.

**The floor is about 24px tall, not 16.** An earlier version of this spec said
16px, which was wrong for a dial — the tick marks turn to fuzz well before
that. Verified by rendering: crisp at 40px, fine at 32px, still readable at
24px, gone at 16px. If something ever needs 16px, it wants a separate
simplified variant with the ticks dropped, not a scaled-down version of these.

**All three share `viewBox="0 45 200 109"`**, so they stay aligned with each
other when set at a common height. Keep that in step if the artwork moves.

**The white dial face behaves differently per theme.** On a light background
it disappears and the mark reads as an arc; on dark it reads as a filled white
semicircle. Both are legible, but Discord ships Light, Dark and Midnight, so
this is worth a deliberate decision rather than an accident.

### The canvas aspect ratio is a design decision, not a technical one

I've specced the canvas at a fixed **4:3 (1200 × 900)**, letterboxed inside
whatever space the Activity actually gets.

The alternative is letting the canvas fill the available space, which means a
phone drawing is portrait and a desktop drawing is landscape. In a channel
feed that looks ragged — every post a different shape. A fixed ratio means
every drawing posts as the same tidy rectangle regardless of who drew it, and
the stroke data already normalises correctly across sizes.

Worth pushing back on if you disagree — it does cost some drawing room on a
phone in landscape.

### File size

Keep replays **under 8 MB**. Discord's free upload limit gives headroom above
that, but people on slow connections are loading these inline in a busy
channel.

---

## 3. In-app UI

The spike currently uses text buttons, which is honest but plain. If you want
icons:

| Asset | Size | Notes |
|---|---|---|
| Tool icons | 24 × 24 SVG | Brush, eraser, undo, replay, more. Stroke-based, single colour. |
| Empty state | ~400 × 300 SVG | Shown on the blank canvas before the first stroke. |

Anything interactive needs a **44 × 44** touch target even if the icon inside
is 24px — that's the accessibility floor, and it's the difference between
usable and infuriating on a phone.

---

## 4. Mobile safe areas

Discord's docs call this out separately: on iOS and Android the Activity
iframe runs under notches and home indicators. The spike already handles it
with `env(safe-area-inset-*)`, but if you design any full-bleed screens,
assume roughly **60px unusable at the top and 40px at the bottom** on a
modern phone.

---

## Priority order

If you want to start somewhere, this is roughly the order they're needed:

1. **App icon** — needed the moment the app is registered, and hardest to get right
2. **Bot avatar** — can be a variant of the icon
3. **Tier badges** — small, and they unblock the in-channel message design
4. **Cover art** — needed before anyone else can find the game
5. **Embedded background** — nice to have; a flat colour works until it exists
6. **Video preview** — genuinely last, since it wants real drawings to show off

---

## Sources

- [Discord — Activity assets and metadata](https://docs.discord.com/developers/activities/development-guides/assets-and-metadata)
- [Discord — Activity development guides](https://docs.discord.com/developers/activities/development-guides)
