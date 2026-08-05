# Draw-tionary — roadmap

## Done

**The loop closes.** `/draw` → private link → server-dealt card → draw →
post to the channel → guess → score, over real HTTP with real signatures.
`npm run check` drives the whole thing.

- **Prototypes** (`spike/`) — input spike with the diagnostics panel, iframe
  harness, guessing mock. Kept for device testing; not served to anyone
- **Canvas** (`app/draw.html`) — the spike with diagnostics removed and the
  server wiring added. Fetches its card, posts its strokes, handles expired
  and spent links without losing anyone's work
- **Replay player** (`app/watch.html`) — replays strokes at a fixed rate,
  knows who's watching, shows solvers the answer and what they scored, and
  hands anyone a fresh canvas without going back for the slash command.
  Honours `prefers-reduced-motion`
- **Listing copy** (`LISTING.md`) — App Directory text, ready to paste
- **Game rules** (`lib/game.js`, `lib/rounds.js`) — dealing, mask, fuzzy
  matching, scoring, flags, removal. Pure functions, no Discord dependency
- **The bot** (`bot/`, `lib/interactions.js`) — slash commands, buttons,
  modals, Ed25519 verification, SQLite storage
- **Word list** (`data/words.json`) — 295 words across three tiers
- **Art spec** (`art/ASSET-SPEC.md`) — sizes and templates

Cards are dealt server-side and the word is checked against the session on
submit, so the browser cannot claim points it didn't earn. The answer is
withheld by `publicView` and both the endpoint and the page markup are
asserted against leaks.

## Next

### Track A — artwork (you)

See `art/ASSET-SPEC.md`. Priority order is at the bottom of that file.
Nothing is blocked on this except launch.

### Track B — make the channel post worth looking at

Right now the post is an embed with text and buttons. It should have the
drawing in it. Needs server-side rendering of the strokes — a still first,
motion later. The schema has `still_key` and `replay_key` waiting.

### Track C — moderation UI

The rules are done and tested; there's nothing to press. Two reports hide a
drawing, but no moderator can see the queue, and the drawer has no delete
button even though `componentDelete` handles it.

### Track D — keep the channel post current

The embed is written once and never updated, so a drawing five people have
solved still says nobody has guessed it. `message_id` is stored; it just
needs an edit call after each solve.

## Open decisions

| Decision | Options | Leaning |
|---|---|---|
| Activity vs external web app | iframe inside Discord / link out | Currently links out — an ephemeral link with a session token. Works today; Activity is still the destination |
| Canvas aspect ratio | fixed 4:3 / fill available space | Fixed, so channel posts are uniform |
| Replay format in channel | animated GIF / WebP / link to player | Settled: link to the player page. It exists and works. A still in the embed is Track B |
| Hosting | Railway or Fly / Cloudflare Workers | Whichever is less fuss; both are ~$0–5/mo |

## Deliberately not doing yet

- Leaderboards and streaks — get one drawing round-tripping first
- Earning colour palettes with points — everyone gets all 124
- Real-time / same-time play — the whole point is asynchronous
- Publishing beyond one server — no Discord review needed under 100 servers

## Moderation, before launch not after

A drawing canvas in a church server needs, at minimum:

- A delete button for the drawer
- A report path for everyone else
- A moderator who can remove any drawing
- A decision about whether drawings persist after removal

Worth designing now rather than the first time something goes wrong.
