/*
 * Headless smoke test for the browser pages — both the spike prototypes and
 * the real app/ pages the bot actually serves.
 *
 * jsdom has no canvas, so we stub a 2d context that records calls. That is
 * enough to actually run the page: build the palette, open menus, arm and
 * fire the destructive action, deal a card, type a guess. Parse-checking the
 * script would not have caught any of the bugs this does.
 *
 * The app pages also talk to the server, so `load` takes a fetch stub. The
 * point is not to re-test the server — tools/e2e.js does that against a real
 * one — but to prove the page does the right thing with each answer it can
 * get back, including the unhappy ones that are painful to reproduce live.
 *
 *   node tools/smoke.js
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const ok   = m => console.log("PASS  " + m);
const bad  = m => { failures++; console.log("FAIL  " + m); };

function stubCanvas(win) {
  const noop = () => {};
  win.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, {
      get: (_, k) =>
        k === "canvas" ? this
      : k === "measureText" ? (() => ({ width: 0 }))
      : typeof k === "string" ? noop
      : undefined,
      set: () => true
    });
  };
  win.HTMLCanvasElement.prototype.toBlob = cb => cb(new win.Blob([]));

  // jsdom lacks these; the page uses them for sizing and smooth panning
  win.Element.prototype.scrollBy = function (o) {
    this.scrollLeft = Math.max(0, this.scrollLeft + (o?.left || 0));
    this.dispatchEvent(new win.Event("scroll"));
  };
  win.Element.prototype.setPointerCapture = noop;
  win.Element.prototype.releasePointerCapture = noop;

  // jsdom has no blob URLs, and the download path needs them. Without these
  // the export silently throws and looks like a broken feature.
  if (!win.URL.createObjectURL) {
    win.URL.createObjectURL = () => "blob:stub";
    win.URL.revokeObjectURL = noop;
  }
  if (!win.matchMedia) {
    win.matchMedia = q => ({ matches: false, media: q, addEventListener: noop });
  }
}

async function load(file, { dir = "spike", url, fetch: fetchImpl } = {}) {
  let html = readFileSync(join(root, dir, file), "utf8");
  const bundle = readFileSync(join(root, dir, "bundle.js"), "utf8");
  const errors = [];

  /*
   * jsdom won't fetch <script src>, so splice the bundle in as an inline
   * script *before parsing*. Everything then executes exactly once, in
   * document order, the way a browser would.
   *
   * The obvious alternative — let it fail, then eval the bundle and re-run the
   * inline scripts — silently double-registers every event listener, which
   * makes each click toggle twice and reports phantom failures.
   */
  html = html.replace(
    /<script src="[^"]*bundle\.js"><\/script>/,
    "<script>" + bundle.replace(/<\/script>/gi, "<\\/script>") + "</script>"
  );

  /*
   * jsdom cannot navigate, and says so loudly when a page sets location.href.
   * That is expected here — a page that navigates is a page doing its job —
   * so swallow just that one complaint and let everything else through.
   */
  const virtualConsole = new VirtualConsole();
  virtualConsole.sendTo(console, { omitJSDOMErrors: true });
  virtualConsole.on("jsdomError", e => {
    if (!/Not implemented: navigation/.test(e.message)) console.error(e.message);
  });

  const dom = new JSDOM(html, {
    url: url ?? "file://" + join(root, dir, file),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(win) {
      stubCanvas(win);
      if (fetchImpl) win.fetch = (...a) => fetchImpl(...a);
      win.addEventListener("error", e => errors.push(e.error?.message || e.message));
      const origErr = win.console.error;
      win.console.error = (...a) => { errors.push(a.join(" ")); origErr(...a); };
    }
  });

  return { dom, win: dom.window, doc: dom.window.document, errors };
}

const click = (win, el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

/** Lets the page's own promise chain (session fetch → render) drain. */
const settle = () => new Promise(r => setTimeout(r, 0));

/** A minimal stand-in for a fetch Response, enough for what the pages read. */
const reply = (status, body) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body)
});

// ---------------------------------------------------------------- draw.html

{
  const { win, doc, errors } = await load("draw.html");
  const $ = id => doc.getElementById(id);

  errors.length ? bad("draw.html runtime errors: " + errors.join(" | "))
                : ok("draw.html runs with no runtime errors");

  // palette
  const swatches = doc.querySelectorAll("#palette .sw");
  swatches.length === 124
    ? ok(`draw.html built all ${swatches.length} swatches`)
    : bad(`expected 124 swatches, got ${swatches.length}`);

  const chips = doc.querySelectorAll("#chips .chip");
  chips.length === 4 ? ok("draw.html built 4 group chips")
                     : bad(`expected 4 chips, got ${chips.length}`);

  // collapsing a group removes its swatches
  const before = doc.querySelectorAll("#palette .sw").length;
  click(win, chips[3]);                       // hide Spectrum (72 swatches)
  const after = doc.querySelectorAll("#palette .sw").length;
  after === before - 72
    ? ok(`collapsing a group frees space (${before} -> ${after} swatches)`)
    : bad(`collapse did not work: ${before} -> ${after}`);
  click(win, chips[3]);                       // restore

  // cannot hide every group and strand yourself
  chips.forEach(c => click(win, c));
  doc.querySelectorAll("#palette .sw").length > 0
    ? ok("at least one color group always remains visible")
    : bad("all groups were hidden — user is stranded with no colours");
  chips.forEach(c => { if (c.getAttribute("aria-pressed") === "false") click(win, c); });

  // pan buttons
  $("panLeft") && $("panRight")
    ? ok("pan arrows present for users who cannot side-scroll")
    : bad("pan arrows missing");
  $("panLeft").disabled === true
    ? ok("left pan starts disabled at the start of the row")
    : bad("left pan should start disabled");

  // American spelling, per request
  /colour/i.test(doc.body.innerHTML)
    ? bad("'colour' still appears in the UI")
    : ok("US spelling throughout — no 'colour' anywhere");

  const chipLabels = [...chips].map(c => c.textContent.trim());
  JSON.stringify(chipLabels) === JSON.stringify(["Greyscale", "Earth tones", "Skin tones", "Spectrum"])
    ? ok("group labels: " + chipLabels.join(", "))
    : bad("unexpected group labels: " + chipLabels.join(", "));

  // ---- word card is the first step, as a modal ----

  $("cardModal").hidden === false
    ? ok("word card opens automatically as the first step")
    : bad("word card did not open on load");

  $("cardModal").querySelector("[role=dialog][aria-modal=true]")
    ? ok("card is a proper modal dialog for assistive tech")
    : bad("card modal missing role=dialog / aria-modal");

  let choices = $("cardOut").querySelectorAll("button.choice");
  choices.length === 3
    ? ok("card offers 3 words offline via the bundle")
    : bad(`expected 3 word choices, got ${choices.length}`);

  // "New card" re-deals without choosing
  const before1 = [...choices].map(c => c.textContent);
  click(win, $("newCard"));
  choices = $("cardOut").querySelectorAll("button.choice");
  choices.length === 3 ? ok("New card re-deals three fresh choices")
                       : bad("New card broke the choice list");

  // on first run there is nothing to lose, so no warning and no cancel
  $("cardWarn").hidden === true ? ok("no 'will clear your drawing' warning on a blank canvas")
                                : bad("warned about clearing an empty canvas");
  $("cancelCard").hidden === true ? ok("first card cannot be dismissed — a word is required")
                                  : bad("first card was dismissable with no word chosen");

  // choosing a word closes the modal and shows a compact readout
  const chosen = choices[0].querySelector("span").textContent;
  click(win, choices[0]);
  $("cardModal").hidden === true ? ok("choosing a word closes the card")
                                 : bad("card stayed open after choosing");
  $("wordBar").hidden === false && $("wordName").textContent === chosen
    ? ok(`word readout shows "Drawing: ${chosen}" as plain text, not buttons`)
    : bad("word readout did not update");
  $("wordBar").querySelectorAll("button").length === 0
    ? ok("word readout has no buttons and no dismiss ✕")
    : bad("word readout still contains buttons");

  // ---- more menu ----

  $("moreMenu").hidden === true ? ok("More menu starts closed") : bad("More menu starts open");
  click(win, $("moreBtn"));
  $("moreMenu").hidden === false && $("moreBtn").getAttribute("aria-expanded") === "true"
    ? ok("More menu opens and reports aria-expanded")
    : bad("More menu did not open correctly");

  const inMenu = id => !!$("moreMenu").querySelector("#" + id);
  ["png", "json", "replay", "startOver", "toggleDiag2"].every(inMenu)
    ? ok("Replay, Save PNG, Save data, Diagnostics and Start over all live in More")
    : bad("something expected in the More menu is missing");

  !$("speed") ? ok("replay speed slider removed — rate is fixed for everyone")
              : bad("replay speed slider is still in the UI");

  // direct child only — the More menu is itself inside a .grp on the bar, so a
  // descendant selector here would report menu items as being on the main bar
  const onBar = id => !!doc.querySelector(".bar > .grp > #" + id);
  ["brush", "eraser", "undo"].every(onBar)
    ? ok("Brush, Eraser and Undo stayed as primary actions")
    : bad("a primary action was buried in the menu");
  !onBar("replay") ? ok("Replay moved off the main bar") : bad("Replay still on the main bar");

  // escape closes the menu
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  $("moreMenu").hidden === true ? ok("Escape closes the More menu") : bad("Escape did not close menu");

  // ---- start over ----

  click(win, $("moreBtn"));
  click(win, $("startOver"));
  $("cardModal").hidden === false
    ? ok("Start over reopens the word card")
    : bad("Start over did not reopen the card");
  $("cancelCard").hidden === false
    ? ok("reopened card can be dismissed with 'Keep drawing'")
    : bad("reopened card has no escape hatch");

  click(win, $("cancelCard"));
  $("cardModal").hidden === true && $("wordName").textContent === chosen
    ? ok("dismissing Start over leaves the current word untouched")
    : bad("dismissing Start over lost the current word");

  // palette collapse frees canvas space
  click(win, $("togglePalette"));
  $("palettePanel").hidden === true
    ? ok("whole palette collapses to maximise drawing area")
    : bad("palette did not collapse");
}

// ---------------------------------------------------------------- guess.html

{
  const { win, doc, errors } = await load("guess.html");
  const $ = id => doc.getElementById(id);

  errors.length ? bad("guess.html runtime errors: " + errors.join(" | "))
                : ok("guess.html runs with no runtime errors");

  const boxes = doc.querySelectorAll("#boxes .box");
  boxes.length > 0 ? ok(`guess.html rendered ${boxes.length} slots`) : bad("no letter boxes rendered");

  doc.querySelectorAll("input").length === 1
    ? ok("exactly one real input backs the whole letter row")
    : bad("more than one input — segmented-input accessibility trap");

  doc.querySelectorAll("#boxes[aria-hidden='true']").length === 1
    ? ok("boxes are aria-hidden decoration, not focusable widgets")
    : bad("boxes are exposed to assistive tech as separate controls");

  /*
   * Force a known answer through the picker rather than reaching into the
   * page's internals — `let` bindings inside an indirect eval are discarded,
   * so win.eval("answer") cannot see them.
   */
  const answer = "hot air balloon";
  const sel = $("pick");
  sel.value = "medium|" + answer;
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));

  const shape = $("shape").textContent;
  shape.includes("3 words")
    ? ok(`mask shape shown to the guesser: "${shape}"`)
    : bad(`unexpected shape text: "${shape}"`);

  const fixed = doc.querySelectorAll("#boxes .box.gap, #boxes .box.fixed").length;
  fixed === 2
    ? ok("separators are pre-filled and locked (2 spaces in 'hot air balloon')")
    : bad(`expected 2 locked separators, got ${fixed}`);

  const entry = $("entry");
  $("submit").disabled === true ? ok("Submit starts disabled") : bad("Submit was enabled while empty");

  const letters = answer.replace(/[^a-z0-9]/gi, "");
  entry.value = letters.slice(0, -1);
  entry.dispatchEvent(new win.Event("input", { bubbles: true }));
  $("submit").disabled === true
    ? ok("Submit stays disabled until every box is filled")
    : bad("Submit enabled on an incomplete row");

  entry.value = letters;
  entry.dispatchEvent(new win.Event("input", { bubbles: true }));
  $("submit").disabled === false
    ? ok("Submit enables when the row is complete")
    : bad("Submit never enabled");

  // punctuation typed by the user is ignored rather than rejected
  entry.value = answer.toUpperCase();
  entry.dispatchEvent(new win.Event("input", { bubbles: true }));
  entry.value === letters.toLowerCase()
    ? ok("typed spaces and punctuation are silently dropped")
    : bad(`input drifted: "${entry.value}" vs "${letters.toLowerCase()}"`);

  // a wrong guess first, to prove it neither penalises nor resets anything
  const bonusBefore = $("bonusNow").textContent;
  entry.value = "x".repeat(letters.length);
  entry.dispatchEvent(new win.Event("input", { bubbles: true }));
  click(win, $("submit"));
  $("result").className === "wrong"
    ? ok("wrong guess is rejected without penalty")
    : bad("wrong guess was accepted");

  // re-watching the drawing must not refill the bonus
  const beforeReplay = $("track").classList.contains("done");
  click(win, $("replay"));
  const fillNow = parseFloat($("fill").style.width) || 0;
  fillNow <= (parseFloat(bonusBefore.match(/(\d+)s left/)?.[1] ?? "100") * 100)
    ? ok("Replay does not refill the bonus window")
    : bad("Replay reset the bonus clock");
  $("track").classList.contains("done") === beforeReplay
    ? ok("Replay leaves the bonus clock state alone")
    : bad("Replay changed the bonus clock state");

  // now the right answer
  entry.value = letters;
  entry.dispatchEvent(new win.Event("input", { bubbles: true }));
  click(win, $("submit"));
  const res = $("result");
  !res.hidden && res.className === "right"
    ? ok("correct guess after a wrong one is accepted and scored")
    : bad("correct guess was not accepted");

  res.textContent.includes("bonus window")
    ? ok("result explains the bonus in terms of the window, not the replay")
    : bad("result still refers to replay timing");

  // exactly the attempts we made, no auto-submits
  const log = $("log").textContent;
  (log.match(/attempt/g) || []).length === 2
    ? ok("typing never auto-submitted — exactly the 2 attempts we made")
    : bad("unexpected attempt count: " + log);

  // the bonus window is tier-based, not replay-based
  const label = $("bonusLabel").textContent;
  /\d+s for (easy|medium|hard) words/.test(label)
    ? ok(`bonus window is tier-based: "${label}"`)
    : bad(`bonus label not tier-based: "${label}"`);
}

// ---------------------------------------------------------------- app/draw.html

const CARD = [
  { word: "cat",      tier: "easy",   points: 10 },
  { word: "windmill", tier: "medium", points: 20 },
  { word: "eclipse",  tier: "hard",   points: 35 }
];

/** The canvas app as the bot serves it: /draw?t=TOKEN, session behind fetch. */
function loadApp({ session = 200, sessionBody, submit = 200, submitBody = { ok: true, posted: true } } = {}) {
  const calls = [];

  return load("draw.html", {
    dir: "app",
    url: "http://localhost/draw?t=TESTTOKEN",
    fetch: (url, init) => {
      calls.push({ url, init });

      if (String(url).startsWith("/api/session")) {
        return reply(session, sessionBody ?? (session === 200
          ? { userId: "u1", card: CARD, expiresAt: Date.now() + 30 * 60 * 1000 }
          : { error: "This link has expired. Run /draw again for a fresh one." }));
      }
      if (String(url) === "/api/submit") return reply(submit, submitBody);

      return reply(404, { error: "unexpected " + url });
    }
  }).then(r => ({ ...r, calls }));
}

/**
 * Draws a short stroke so the canvas has something to post.
 *
 * jsdom has no PointerEvent, so we send a MouseEvent carrying the pointer
 * fields the page reads. Those are the only ones it touches, and faking the
 * whole interface would test jsdom rather than the page.
 */
function scribble(win, doc) {
  const cv = doc.getElementById("board");

  const send = (type, x, y) => {
    const e = new win.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(e, {
      pointerId:   { value: 1 },
      pointerType: { value: "mouse" },
      pressure:    { value: 0.5 }
    });
    cv.dispatchEvent(e);
  };

  send("pointerdown", 10, 10);
  send("pointermove", 40, 40);
  send("pointerup",   40, 40);
}

{
  const { win, doc, errors, calls } = await loadApp();
  const $ = id => doc.getElementById(id);
  await settle();

  errors.length ? bad("app/draw.html runtime errors: " + errors.join(" | "))
                : ok("app/draw.html runs with no runtime errors");

  // ---- the diagnostics panel is gone, not merely hidden ----

  !$("diag") && !$("verdict") && !$("toggleDiag2")
    ? ok("diagnostics panel, verdict box and its menu item are all gone")
    : bad("diagnostics survived into the shipping canvas");

  !/d-(frame|dpr|press|tilt|coal|rate|strokes|prange)/.test(doc.documentElement.innerHTML)
    ? ok("no leftover diagnostic element ids anywhere in the page")
    : bad("diagnostic element ids still present");

  /input spike/i.test(doc.documentElement.innerHTML)
    ? bad("'input spike' still shown to players")
    : ok("no 'input spike' wording in the shipping canvas");

  // ---- the card comes from the server, not the bundle ----

  calls.some(c => String(c.url).startsWith("/api/session?t=TESTTOKEN"))
    ? ok("canvas asks the server for its session using the URL token")
    : bad("canvas never fetched /api/session");

  const choices = [...$("cardOut").querySelectorAll("button.choice")];
  choices.length === 3
    ? ok("card shows the three server-dealt words")
    : bad(`expected 3 server-dealt choices, got ${choices.length}`);

  choices.map(c => c.querySelector("span").textContent).join(",") === "cat,windmill,eclipse"
    ? ok("the words shown are exactly the ones the server dealt")
    : bad("card words do not match the server's card");

  !$("newCard")
    ? ok("no 'New card' button — rerolling until you get easy words is a scoring hole")
    : bad("New card would let the client re-deal its own scoring");

  // ---- posting ----

  $("submit").disabled === true
    ? ok("Post it starts disabled — nothing drawn yet")
    : bad("Post it was enabled on a blank canvas");

  click(win, choices[1]);                       // windmill, medium, 20
  $("submit").disabled === true
    ? ok("Post it stays disabled with a word but no ink")
    : bad("Post it enabled before anything was drawn");

  scribble(win, doc);
  $("submit").disabled === false
    ? ok("Post it enables once there is a word and some ink")
    : bad("Post it stayed disabled after drawing");

  click(win, $("submit"));
  await settle();

  const post = calls.find(c => String(c.url) === "/api/submit");
  post ? ok("Post it sent the drawing to /api/submit") : bad("submit never reached the server");

  const sent = JSON.parse(post.init.body);
  sent.token === "TESTTOKEN"
    ? ok("the submit carries the session token, not a client-invented id")
    : bad("submit did not carry the token");

  sent.word === "windmill"
    ? ok("the submitted word is the one that was chosen")
    : bad("submitted the wrong word: " + sent.word);

  Array.isArray(sent.strokes) && sent.strokes.length > 0 && Array.isArray(sent.strokes[0].p)
    ? ok("strokes go over the wire in the compact recorded format")
    : bad("stroke payload is the wrong shape");

  typeof sent.durationMs === "number" && sent.width > 0 && sent.height > 0
    ? ok("submit includes duration and canvas size for the replay")
    : bad("submit is missing duration or canvas size");

  $("submit").disabled === true && /posted/i.test($("submit").textContent)
    ? ok("the canvas locks after posting — no double-posting the same round")
    : bad("Post it was still live after a successful post");

  $("notice").hidden === false
    ? ok("a confirmation notice is shown after posting")
    : bad("nothing confirmed the post");

  $("notice").getAttribute("role") === "alert"
    ? ok("notices announce themselves rather than stealing focus mid-drawing")
    : bad("notice is not announced to assistive tech");
}

// ---- stroke width survives a resize ----

{
  /*
   * Coordinates are stored relative to canvas width, so geometry rescales
   * when the window changes. Stroke width used to be kept in pixels, which
   * did not — so the same drawing became spidery on a wide canvas and
   * marker-thick on a narrow one. Both have to be relative or neither.
   */
  const { win, doc, calls } = await loadApp();
  const $ = id => doc.getElementById(id);
  await settle();

  click(win, [...$("cardOut").querySelectorAll("button.choice")][0]);
  scribble(win, doc);
  click(win, $("submit"));
  await settle();

  const posted = calls.find(c => c.url === "/api/submit");
  const sent   = posted ? JSON.parse(posted.init.body) : {};
  const stroke = sent.strokes?.[0];

  stroke
    ? ok("a stroke made it into the submitted payload")
    : bad("no stroke to inspect");

  /*
   * The submitted width must still be a pixel measurement matching the
   * recorded canvas width — that is the existing wire format, and changing
   * it would strand every drawing already in the database.
   */
  typeof stroke?.w === "number" && stroke.w > 0.5 && stroke.w < 200
    ? ok(`stroke width goes over the wire in pixels (${stroke.w}), format unchanged`)
    : bad(`stroke width is not a plausible pixel value: ${stroke?.w}`);

  sent.width > 0
    ? ok("and the canvas width it was measured against travels with it")
    : bad("no canvas width recorded — the reader cannot rescale the linework");
}

// ---- downloads inside the Discord Activity ----

{
  /*
   * A Discord Activity runs in a sandboxed iframe that ignores download
   * clicks — no exception, no event, nothing. The canvas used to announce
   * "Saved <file>" regardless, telling people their drawing was safe on disk
   * when it was not. That is worse than the feature simply not working.
   */
  const calls = [];
  const { win, doc } = await load("draw.html", {
    dir: "app",
    url: "http://localhost/.proxy/draw?t=TESTTOKEN",
    fetch: (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).startsWith("/api/session")
        ? reply(200, { userId: "u1", card: CARD, expiresAt: Date.now() + 1800000 })
        : reply(200, { ok: true, posted: true });
    }
  });
  const $ = id => doc.getElementById(id);
  await settle();

  /Save PNG.*not in Discord/i.test($("png").textContent)
    ? ok("inside the Activity, Save PNG says up front that it can't work")
    : bad("Save PNG gives no warning inside the Activity: " + $("png").textContent);

  click(win, [...$("cardOut").querySelectorAll("button.choice")][0]);
  scribble(win, doc);

  click(win, $("png"));
  await settle();

  const notice = $("notice");
  notice.hidden === false && /downloads/i.test(notice.textContent)
    ? ok("pressing it explains why nothing downloaded")
    : bad("silent failure on Save PNG inside the Activity");

  !/Saved /.test($("status").textContent)
    ? ok("and it does not claim the file was saved")
    : bad("claimed a download succeeded inside a sandbox that blocks downloads");
}

{
  // Outside Discord the same buttons must still work normally.
  const { win, doc } = await loadApp();
  const $ = id => doc.getElementById(id);
  await settle();

  !/not in Discord/.test($("png").textContent)
    ? ok("in a normal browser Save PNG is offered without caveats")
    : bad("the Discord warning leaked into the browser build");

  click(win, [...$("cardOut").querySelectorAll("button.choice")][0]);
  scribble(win, doc);
  click(win, $("png"));
  await settle();

  /Saved /.test($("status").textContent)
    ? ok("and a browser download reports success")
    : bad("Save PNG stopped working in a normal browser: " + $("status").textContent);
}

// ---- an expired link ----

{
  const { doc, errors } = await loadApp({ session: 404 });
  const $ = id => doc.getElementById(id);
  await settle();

  errors.length ? bad("expired-link path errored: " + errors.join(" | "))
                : ok("an expired link is handled without a runtime error");

  $("notice").hidden === false && /expired/i.test($("notice").textContent)
    ? ok("an expired link says so in plain language")
    : bad("expired link gave no explanation");

  $("submit").hidden === true
    ? ok("Post it is removed when there is no session to post to")
    : bad("Post it still offered with a dead session");

  $("cardModal").hidden === true
    ? ok("no empty word card — an unescapable modal with no options is a focus trap")
    : bad("opened a word card with nothing in it");
}

// ---- the bot could not reach the channel ----

{
  const { win, doc } = await loadApp({ submitBody: { ok: true, posted: false } });
  const $ = id => doc.getElementById(id);
  await settle();

  click(win, [...$("cardOut").querySelectorAll("button.choice")][0]);
  scribble(win, doc);
  click(win, $("submit"));
  await settle();

  /saved/i.test($("notice").textContent) && /couldn't post/i.test($("notice").textContent)
    ? ok("a saved-but-unposted drawing says so instead of claiming success")
    : bad("unposted drawing was reported as posted: " + $("notice").textContent);
}

// ---- the session was spent between load and submit ----

{
  const { win, doc } = await loadApp({ submit: 409, submitBody: { error: "This drawing was already posted." } });
  const $ = id => doc.getElementById(id);
  await settle();

  click(win, [...$("cardOut").querySelectorAll("button.choice")][0]);
  scribble(win, doc);
  click(win, $("submit"));
  await settle();

  $("submit").disabled === true
    ? ok("a spent session disables Post it — retrying could never work")
    : bad("offered a retry that cannot succeed");
}

// ---------------------------------------------------------------- app/watch.html

const MASK = [
  { type: "letter" }, { type: "letter" }, { type: "letter" },
  { type: "fixed", char: " " },
  { type: "letter" }, { type: "letter" }, { type: "letter" }
];

const DRAWING = {
  width: 800, height: 600, durationMs: 4000,
  strokes: [{ c: "#000000", w: 6, e: 0, p: [[0.1, 0.1, 0.5, 0], [0.4, 0.4, 0.5, 900]] }]
};

/*
 * `code` is the HTTP status and is kept separate from the round's own
 * `status` field, which is a word like "open" or "hidden". Conflating the
 * two is exactly the sort of thing this file exists to catch.
 */
/*
 * The page carries no credential of its own — identity is an httpOnly cookie
 * the browser attaches automatically, which is precisely why there is nothing
 * here to stub. `canStartDrawing` in the payload is how the page learns
 * whether the server recognised it.
 */
const loadWatch = (body, code = 200, { draw, guess } = {}) => {
  const calls = [];

  return load("watch.html", {
    dir: "app",
    url: "http://localhost/watch/round-1",
    fetch: (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("/api/watch/"))    return reply(code, body);
      if (String(url) === "/api/draw-session")      return reply(draw?.code ?? 200,
                                                                draw?.body ?? { url: "/draw?t=NEW" });
      if (String(url) === "/api/guess")             return reply(guess?.code ?? 200,
                                                                guess?.body ?? { ok: true, correct: false, attempts: 1 });
      return reply(404, { error: "unexpected " + url });
    }
  }).then(r => ({ ...r, calls }));
};

{
  const { doc, errors } = await loadWatch({
    id: "round-1", status: "open", tier: "medium", points: 20,
    mask: MASK, solverCount: 2, drawing: DRAWING
  });
  const $ = id => doc.getElementById(id);
  await settle();

  errors.length ? bad("app/watch.html runtime errors: " + errors.join(" | "))
                : ok("app/watch.html runs with no runtime errors");

  $("board").hidden === false && $("msg").hidden === true
    ? ok("watch page shows the canvas once the drawing loads")
    : bad("watch page never revealed the canvas");

  doc.querySelectorAll("#shape .box").length === 6
    ? ok("watch page renders one box per letter")
    : bad(`expected 6 letter boxes, got ${doc.querySelectorAll("#shape .box").length}`);

  doc.querySelectorAll("#shape .gap").length === 1
    ? ok("the word break is a gap, not a guessable box")
    : bad("word break was not rendered as a gap");

  doc.querySelectorAll("#shape .box.filled").length === 0
    ? ok("no letters are filled in for someone who hasn't solved it")
    : bad("the watch page leaked letters of the answer");

  /\d+ letters/.test($("shape").getAttribute("aria-label"))
    ? ok(`the word shape is described, not left as empty boxes: "${$("shape").getAttribute("aria-label")}"`)
    : bad("word shape has no useful description for screen readers");

  $("solvers").textContent.includes("2 people")
    ? ok("watch page reports how many people have got it")
    : bad("solver count missing: " + $("solvers").textContent);
}

// ---- guessing from the replay page ----

/*
 * The bug these exist to prevent: the page showed a row of empty letter boxes
 * and nothing to type into, because the boxes are role="img". People clicked
 * them, nothing happened, and there was no way to play.
 */
const GUESSABLE = {
  id: "round-1", status: "open", tier: "medium", points: 20,
  mask: MASK, solverCount: 0, drawing: DRAWING,
  canGuess: true, canStartDrawing: true
};

{
  const { doc, win } = await loadWatch(GUESSABLE);
  const $ = id => doc.getElementById(id);
  await settle();

  $("guessPanel").hidden === false
    ? ok("someone who may guess is given somewhere to do it")
    : bad("the guess panel never appeared for a guessable round");

  const input = $("answer");
  const label = doc.querySelector('label[for="answer"]');

  input && input.tagName === "INPUT" && label
    ? ok("the guess field is a real labelled input, not a row of styled boxes")
    : bad("no labelled text input on the replay page");

  // A placeholder disappears the moment you type, so it cannot be the label.
  label && !label.classList.contains("sr-only") && label.textContent.trim()
    ? ok("the label is visible, not a placeholder that vanishes on the first keystroke")
    : bad("the guess field has no visible label");

  // The reported symptom, as a test: clicking the boxes has to reach the field.
  $("shape").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  doc.activeElement === input
    ? ok("clicking the letter boxes focuses the field, because that is what people try")
    : bad("clicking the letter boxes still does nothing");

  // Typing fills the boxes, so the shape stays the thing you are looking at.
  input.value = "the cat";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));

  doc.querySelectorAll("#shape .box.filled").length === 6
    ? ok("typing mirrors into the letter boxes")
    : bad("typed letters never reached the boxes");

  [...doc.querySelectorAll("#shape .box")].map(b => b.textContent).join("") === "THECAT"
    ? ok("punctuation and spacing are skipped — only letters take a slot")
    : bad("letters landed in the wrong slots");
}

{
  const { doc, win } = await loadWatch(GUESSABLE, 200, {
    guess: { body: { ok: true, correct: false, attempts: 1 } }
  });
  const $ = id => doc.getElementById(id);
  await settle();

  $("answer").value = "a dog";
  $("guessForm").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  await settle();

  /isn't it/i.test($("guessHelp").textContent)
    ? ok("a wrong guess says so without treating it as an error")
    : bad("wrong guess gave no feedback: " + $("guessHelp").textContent);

  $("guessPanel").hidden === false && $("answer").disabled === false
    ? ok("and leaves you able to guess again straight away")
    : bad("a wrong guess locked the player out");

  $("answer").value === "a dog"
    ? ok("the wrong guess is left in the field, because it is usually nearly right")
    : bad("the field was cleared, so a one-letter typo means retyping it all");

  doc.querySelectorAll("#shape .box.filled").length !== 6 || $("shape").textContent !== "THECAT"
    ? ok("a wrong guess reveals nothing about the answer")
    : bad("the answer leaked on a wrong guess");
}

{
  const { doc, win } = await loadWatch(GUESSABLE, 200, {
    guess: {
      body: {
        ok: true, correct: true, word: "the cat", awarded: 26,
        base: 20, bonus: 6, solverIndex: 0, solverCount: 1, attempts: 2
      }
    }
  });
  const $ = id => doc.getElementById(id);
  await settle();

  $("answer").value = "the cat";
  $("guessForm").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  await settle();

  doc.querySelectorAll("#shape .box.filled").length === 6
    ? ok("a correct guess reveals the word in place, without a reload")
    : bad("the word was not revealed after solving");

  $("guessPanel").hidden === true
    ? ok("and retires the field, because there is nothing left to guess")
    : bad("the guess field survived the answer");

  /26/.test($("youScore").textContent) && $("youScore").hidden === false
    ? ok("the score lands on screen")
    : bad("no score shown after solving: " + $("youScore").textContent);

  $("solvers").textContent.includes("1 person")
    ? ok("the solver count moves without a round trip")
    : bad("solver count stale after solving: " + $("solvers").textContent);

  /the cat/.test($("status").textContent) && /26/.test($("status").textContent)
    ? ok("and the whole result is announced to screen readers")
    : bad("solving was silent for anyone not looking: " + $("status").textContent);
}

{
  // A stranger sent the link can watch, but publicView tells them they cannot
  // guess — so they are not handed a field that would 401 the moment they use it.
  const { doc } = await loadWatch({
    id: "round-1", status: "open", tier: "medium", points: 20,
    mask: MASK, solverCount: 0, drawing: DRAWING,
    canGuess: false, canStartDrawing: false
  });
  await settle();

  doc.getElementById("guessPanel").hidden === true
    ? ok("someone who cannot guess is not offered a field that would fail")
    : bad("the guess panel was shown to someone who cannot use it");
}

// ---- the answer is only shown when the server sends it ----

{
  const { doc } = await loadWatch({
    id: "round-1", status: "open", tier: "easy", points: 10,
    mask: MASK, solverCount: 1, drawing: DRAWING, word: "the cat"
  });
  await settle();

  doc.querySelectorAll("#shape .box.filled").length === 6
    ? ok("a solver who reloads sees the answer filled in")
    : bad("the answer was withheld from someone who had earned it");
}

// ---- a hidden round ships no strokes ----

{
  const { doc } = await loadWatch({
    id: "round-1", status: "hidden", tier: "hard", points: 35,
    mask: MASK, solverCount: 0
  });
  const $ = id => doc.getElementById(id);
  await settle();

  $("board").hidden === true && /moderator/i.test($("msg").textContent)
    ? ok("a hidden drawing explains itself instead of rendering nothing")
    : bad("hidden drawing was not handled: " + $("msg").textContent);
}

{
  const { doc } = await loadWatch({ error: "not found" }, 404);
  const $ = id => doc.getElementById(id);
  await settle();

  $("bar").hidden === true && $("msg").hidden === false
    ? ok("a missing round shows a message, not a broken player")
    : bad("missing round left the player in a broken state");
}

{
  // Even a 404 says whether we know the caller, so a dead link isn't a dead end.
  const { doc } = await loadWatch({ error: "not found", canStartDrawing: true }, 404);
  await settle();

  doc.getElementById("yourTurn").hidden === false
    ? ok("a missing round still offers a recognised viewer a canvas")
    : bad("a recognised viewer hit a dead end on a missing round");
}

// ---------------------------------------------------------------- coming back

/*
 * The second visit. Someone clicks whatever gets them back into the game, so
 * wherever they land has to say what happened last time and offer one obvious
 * next thing. These checks are about that, not about the replay.
 */

const OPEN = {
  id: "round-1", status: "open", tier: "medium", points: 20,
  mask: MASK, solverCount: 2, drawing: DRAWING
};

{
  const { doc, calls } = await loadWatch(
    { ...OPEN, word: "the cat", canStartDrawing: true,
      you: { isDrawer: false, solved: true, attempts: 3, awarded: 26, solverIndex: 0 } }
  );
  const $ = id => doc.getElementById(id);
  await settle();

  /*
   * The request carries no credential of its own. Identity is an httpOnly
   * cookie the browser attaches — which is the point: there is nothing in
   * this page, or in its address bar, for anyone to copy and paste.
   */
  !/[?&](v|g|token)=/.test(calls[0].url)
    ? ok("the replay page asks for the round with no credential in the URL")
    : bad("a credential leaked into the request: " + calls[0].url);

  !/[?&](v|g|token)=/.test(doc.location.search)
    ? ok("nothing worth stealing is left in the address bar")
    : bad("a token is sitting in the address bar: " + doc.location.search);

  doc.querySelectorAll("#shape .box.filled").length === 6
    ? ok("a returning solver sees the answer, not the boxes they already beat")
    : bad("the answer was withheld from someone who had earned it");

  $("you").hidden === false && /got it first/i.test($("youText").textContent)
    ? ok("a returning solver is told they got it first")
    : bad("no result shown to a returning solver: " + $("youText").textContent);

  /3 goes/.test($("youText").textContent)
    ? ok("wrong guesses are counted back with the win, not hidden")
    : bad("attempt count missing: " + $("youText").textContent);

  $("youScore").hidden === false && $("youScore").textContent === "+26 pts"
    ? ok("the score they earned on this round is shown")
    : bad("score missing: " + $("youScore").textContent);

  $("yourTurn").hidden === false
    ? ok("a big obvious next action — no dead end")
    : bad("no CTA offered to an identified viewer");
}

{
  const { doc } = await loadWatch(
    { ...OPEN, solverCount: 4, word: "the cat", canStartDrawing: true,
      you: { isDrawer: false, solved: true, attempts: 1, awarded: 20, solverIndex: 3 } }
  );
  const $ = id => doc.getElementById(id);
  await settle();

  /4th to crack it/i.test($("youText").textContent)
    ? ok("later solvers are placed in the queue, correctly ordinalised")
    : bad("wrong placing text: " + $("youText").textContent);

  /goes/.test($("youText").textContent)
    ? bad("a one-shot solve was described as taking multiple goes")
    : ok("a one-shot solve isn't padded with an attempt count");
}

{
  const { doc } = await loadWatch(
    { ...OPEN, canStartDrawing: true,
      you: { isDrawer: false, solved: false, attempts: 2, awarded: 0, solverIndex: null } }
  );
  const $ = id => doc.getElementById(id);
  await settle();

  doc.querySelectorAll("#shape .box.filled").length === 0
    ? ok("someone still stuck on it is not shown the answer by the CTA panel")
    : bad("the answer leaked to a non-solver");

  /cost nothing/i.test($("youText").textContent)
    ? ok("a stuck guesser is encouraged rather than scored")
    : bad("unhelpful text for a stuck guesser: " + $("youText").textContent);

  $("youScore").hidden === true
    ? ok("no score badge when nothing has been earned")
    : bad("showed a score to someone who has not scored");
}

{
  const { doc } = await loadWatch(
    { ...OPEN, solverCount: 2, word: "the cat", canStartDrawing: true,
      you: { isDrawer: true, solved: false, attempts: 0, awarded: 14, solverIndex: null } }
  );
  const $ = id => doc.getElementById(id);
  await settle();

  /you drew this one/i.test($("youText").textContent) && /2 people/.test($("youText").textContent)
    ? ok("the drawer is told how many people have cracked it")
    : bad("wrong text for the drawer: " + $("youText").textContent);

  $("youScore").textContent === "+14 pts"
    ? ok("the drawer's share of the points is shown on their own drawing")
    : bad("drawer score missing: " + $("youScore").textContent);
}

{
  // No token: a link someone pasted elsewhere.
  const { doc } = await loadWatch({ ...OPEN, canStartDrawing: false });
  const $ = id => doc.getElementById(id);
  await settle();

  $("yourTurn").hidden === true && /\/draw/.test($("ctaNote").textContent)
    ? ok("a stranger with a shared link is pointed at /draw instead of a button")
    : bad("wrong fallback for an unidentified viewer");

  $("you").hidden === false
    ? ok("even an anonymous viewer gets a next step")
    : bad("anonymous viewer left with nowhere to go");
}

{
  const { win, doc, calls } = await loadWatch(
    { ...OPEN, canStartDrawing: true,
      you: { isDrawer: false, solved: false, attempts: 0, awarded: 0, solverIndex: null } }
  );
  const $ = id => doc.getElementById(id);
  await settle();

  click(win, $("yourTurn"));
  await settle();

  const minted = calls.find(c => c.url === "/api/draw-session");
  const sent   = minted ? JSON.parse(minted.init.body) : {};

  minted && sent.roundId === "round-1"
    ? ok("the CTA names the round it came from, so the drawing lands in that channel")
    : bad("draw session was not asked for against a round: " + JSON.stringify(sent));

  // Identity rides on the cookie. The body says where, never who.
  !("v" in sent) && !("userId" in sent) && !("channelId" in sent)
    ? ok("the browser never claims who it is or where the drawing should go")
    : bad("the CTA body carried identity it should not: " + JSON.stringify(sent));

  $("yourTurn").dataset.href === "/draw?t=NEW"
    ? ok("a successful CTA heads straight for the canvas it was given")
    : bad("CTA did not use the minted canvas url: " + $("yourTurn").dataset.href);
}

{
  const { win, doc } = await loadWatch(
    { ...OPEN, canStartDrawing: true,
      you: { isDrawer: false, solved: false, attempts: 0, awarded: 0, solverIndex: null } },
    200, { draw: { code: 401, body: { error: "I don't know who you are any more. Run /draw in Discord to start one." } } }
  );
  const $ = id => doc.getElementById(id);
  await settle();

  click(win, $("yourTurn"));
  await settle();

  $("yourTurn").hidden === true && /\/draw/.test($("ctaNote").textContent)
    ? ok("an expired cookie falls back to telling you where the game is")
    : bad("stale CTA left a button that cannot work");
}

{
  // A removed drawing is still a person who turned up wanting to play.
  const { doc } = await loadWatch(
    { id: "round-1", status: "removed", tier: "easy", points: 10,
      mask: MASK, solverCount: 0, canStartDrawing: true }
  );
  const $ = id => doc.getElementById(id);
  await settle();

  $("yourTurn").hidden === false
    ? ok("even a removed drawing offers a way into a round of your own")
    : bad("a dead end with no way forward");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
