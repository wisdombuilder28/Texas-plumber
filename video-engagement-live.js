// video-engagement-live.js
// Likes and the public "Views" number for the Recent Work: Videos page.
//
// videos-live.js loads this file on its own, so a problem in here can never stop the video list or the player from
// working. It hands three things back to it:
//   buildStats(item, { player })   the like button and the view count for one video (a card, or the full-screen player)
//   loadStats(videoId)             reads that video's like count and whether this visitor liked it
//   trackPlayback(video, item)     watches one <video> element and reports a view once it has really played
//
// LIKES work the way the image likes on the Images page do (see work-live.js and firestore.rules):
//   * Every visitor is signed in silently and anonymously (this starts the moment the page loads, so the identity is
//     ready long before anyone taps), so each browser has a stable Firebase UID. Nobody is ever asked to log in and no
//     personal detail is stored.
//   * A like is ONE small document at videos/{videoId}/likes/{uid}. The document ID is the visitor's UID, so
//     Firestore itself refuses a second like from the same visitor on the same video; it isn't just a check here.
//     Unliking deletes that document.
//   * The number shown is how many of those documents exist (an aggregate count, which costs one read however many
//     likes there are). There is no counter anyone could tamper with or that could drift out of step.
//   * A tap answers on screen AT ONCE: the heart and the number change before anything has been sent. The save then
//     runs as one Firestore transaction (read the visitor's own like, then write exactly what the visitor asked for),
//     so a double tap, or the same visitor in two tabs, can never double-like or hit an error. The button is never
//     locked while that happens: tap again and the latest tap wins (the save simply catches up). When the transaction
//     has gone through, the real count is read again in the BACKGROUND (nothing waits for it), and a read that was
//     already on its way when the visitor tapped again can never overwrite the newer tap (see `rev` below).
//   * If the save fails (offline, refused, no answer within SAVE_TIMEOUT_MS) the heart and the number go back to
//     what the database holds, and a short message says so. Nothing can leave the button stuck.
//
// VIEWS are counted by the server (api/engagement.js), because a view is "once per visitor per video per 24 hours"
// and that can't be left to the browser. This file decides WHEN to ask: only after the visitor has really watched
// the video for 5 seconds with the tab visible. Merely opening a video, a thumbnail loading, a paused or buffering
// video, a video playing in a background tab, or one that failed to play never count. The server then makes the
// final decision (24 hours, one per visitor), and answers with the new total.
//   * While a video plays, this file already gets the three slow parts ready: the visitor's login token, a request that
//     wakes the server up (it "warms" a server that has been idle: certificates and its own Google sign-in), and
//     the connection to the server. So when the 5 seconds are up, the report is one short request.
//   * The number shows +1 the moment the 5 seconds are up, with a faint "updating" look, and is then replaced by the
//     server's answer. If the server says the visitor was already counted, or the request fails, the +1 is taken
//     back. An unsuccessful view is never left looking like a counted one.
//
// TIMING: every step that can make a like or a view feel slow is timed with performance.now() (and the server adds
// its own Server-Timing). The records hold numbers and a few fixed words only, never a visitor id, a token or a key.
// They are in window.NDF_TIMINGS; add ?timing=1 to the page address to see them on screen and in the console.
//
// Everything on screen is built with createElement / textContent. Failures are quiet: they are logged to the
// console and never get in the way of playback.
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getCountFromServer,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const VIEW_SECONDS = 5; //                      real, visible playback that makes a view (KEEP IN SYNC with VIDEO_ENGAGEMENT.md)
const VIEW_ENDPOINT = "/api/engagement";
const VIEW_RETRY_MS = [15000, 45000]; //        after a failed report: try again twice, quietly
const WARM_EVERY_MS = 4 * 60 * 1000; //         the server is woken at most this often (an idle server instance sleeps after a few minutes)
const SEEN_KEY = "ndf-video-views-v1"; //       this browser's note of "already counted, not due again until ..."
const SEEN_LIMIT = 300;
const SEEN_KEEP_MS = 60 * 24 * 60 * 60 * 1000; // a note whose 24 hours are over is kept this much longer, only to tell the server "returning"
const LIKES_FRESH_MS = 60 * 1000; //            how long a like count read from the database is reused before asking again
const SAVE_TIMEOUT_MS = 12000; //               a like that hasn't been saved by then is given up on (the heart goes back)
const NOTE_MS = 5000; //                        how long a "couldn't save" message stays
const NOTE_TEXT = "Couldn't save that. Check your connection and try again.";
const NEAR_PX = 300; //                         a card loads its like count when it comes within this distance of the screen
const PERMANENT_FAILURES = new Set([400, 401, 404, 405, 413, 501]); // answers that asking again won't change
const TIMING_KEEP = 40; //                      timing records kept in window.NDF_TIMINGS

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatNumber(n) {
  try {
    return Number(n).toLocaleString("en-NG");
  } catch (e) {
    return String(n);
  }
}

// Small inline icons (no dependency on the icon CDN, like the rest of this page's script).
const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  heart: [["path", { d: "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" }]],
  eye: [
    ["path", { d: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
};
function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon-sm");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  ICON_PATHS[name].forEach(([tag, attrs]) => {
    const shape = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => shape.setAttribute(key, value));
    svg.appendChild(shape);
  });
  return svg;
}

// ---------------------------------------------------------------------------
// Timing: where do the seconds go?
// ---------------------------------------------------------------------------
const T0 = performance.now(); // when this file started (the page load, more or less)
const timings = []; // newest last: { kind, at, ...numbers }   (`at` = ms since T0)
let debugTiming = false;
try {
  const asked = new URLSearchParams(location.search).get("timing");
  if (asked === "1") sessionStorage.setItem("ndf-timing", "1");
  if (asked === "0") sessionStorage.removeItem("ndf-timing");
  debugTiming = sessionStorage.getItem("ndf-timing") === "1";
} catch (e) {
  debugTiming = false;
}
try {
  window.NDF_TIMINGS = timings;
} catch (e) {
  /* not available: the records are simply not exposed */
}

const since = (from) => Math.round((performance.now() - from) * 10) / 10;

// Only numbers and short fixed words are ever recorded (the callers never have a visitor id or token to give).
function clean(data) {
  const out = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && /^[A-Za-z0-9:_,.\- ]{0,80}$/.test(value)) out[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) out[key] = clean(value);
  });
  return out;
}

let panel = null;
const panelLines = [];
function showTiming(entry) {
  try {
    if (!panel) {
      panel = el("pre", "ndf-timing");
      panel.setAttribute("aria-hidden", "true");
    }
    const viewer = document.getElementById("vid-viewer");
    const host = viewer && viewer.open ? viewer : document.body; // a modal <dialog> covers the page, so the panel lives inside it while it is open
    if (panel.parentNode !== host) host.appendChild(panel);
    const { kind, at, ...rest } = entry;
    panelLines.push(`${kind} @${at}ms ${JSON.stringify(rest).replace(/[{}"]/g, "")}`);
    while (panelLines.length > 7) panelLines.shift();
    panel.textContent = panelLines.join("\n");
  } catch (e) {
    /* a debugging aid must never matter */
  }
}

function record(kind, data) {
  const entry = { kind, at: Math.round(performance.now() - T0), ...clean(data) };
  timings.push(entry);
  while (timings.length > TIMING_KEEP) timings.shift();
  if (debugTiming) {
    console.info("[ndf-timing]", entry);
    showTiming(entry);
  }
}

// The server's own breakdown (the Server-Timing header of its answer) as plain numbers.
function readServerTiming(header) {
  const out = {};
  String(header || "")
    .split(",")
    .forEach((part) => {
      const [name, ...params] = part.trim().split(";");
      if (!/^[a-z0-9_-]{1,16}$/i.test(name || "")) return;
      params.forEach((param) => {
        const [key, raw] = param.trim().split("=");
        const value = String(raw == null ? "" : raw).replace(/^"|"$/g, "");
        if (key === "dur" && Number.isFinite(Number(value))) out[name] = Number(value);
        else if (key === "desc" && /^[a-z0-9-]{1,16}$/i.test(value)) out[`${name}_is`] = value;
      });
    });
  return out;
}

// ---------------------------------------------------------------------------
// Who is this visitor? (the same silent, anonymous sign-in the Images page uses)
// ---------------------------------------------------------------------------
let currentUid = null;
let signInPromise = null;
let authRecorded = false;

// The first time this visitor's identity is known (an anonymous sign-in, or a restored one), how long after the page
// loaded: that is the "anonymous auth ready" number in the timing records.
function identityKnown(uid) {
  currentUid = uid;
  if (!authRecorded) {
    authRecorded = true;
    record("auth", { ready_ms: since(T0) });
  }
}

// Returns a UID, signing in anonymously if needed. It waits for Firebase to finish restoring any saved login first and
// then uses whoever is signed in: signInAnonymously() would replace a signed-in admin with a brand-new anonymous
// session, so it is only called when nobody is signed in at all. Everybody who asks while a sign-in is running shares it.
function ensureSignedIn() {
  if (currentUid) return Promise.resolve(currentUid);
  if (!signInPromise) {
    signInPromise = Promise.resolve(auth.authStateReady && auth.authStateReady())
      .then(() => auth.currentUser || signInAnonymously(auth).then((result) => result.user))
      .then((user) => {
        identityKnown(user.uid); // anonymous sign-in (or restoring the saved one) is done
        return currentUid;
      })
      .catch((error) => {
        signInPromise = null; // let the next attempt try again instead of staying stuck
        throw error;
      });
  }
  return signInPromise;
}

// The login token the views server checks. The SDK keeps it for about an hour and renews it quietly; asking early means
// a renewal (if one is due) happens now, not at the moment a view is reported.
async function getToken(force = false) {
  await ensureSignedIn();
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  return user.getIdToken(force);
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    const switched = currentUid && currentUid !== user.uid;
    identityKnown(user.uid);
    if (switched) forgetWhoLiked(); // a different person is signed in now (say, the admin logged out in another tab)
  } else {
    const had = currentUid;
    currentUid = null;
    if (had) {
      signInPromise = null; // somebody signed out: start over
      forgetWhoLiked();
    }
    ensureSignedIn().catch((error) => console.warn("Anonymous sign-in failed:", error));
  }
});

// Identity and token are made ready as the page loads, so neither is ever waited for when it matters.
ensureSignedIn()
  .then(() => getToken())
  .catch((error) => console.warn("The visitor's sign-in isn't ready yet:", error));

// ---------------------------------------------------------------------------
// What is known about each video, shared by its card and its slide in the player so they always agree
// ---------------------------------------------------------------------------
//   count      how many likes the database holds, as far as we know (null until it has been read)
//   server     whether the database holds THIS visitor's like: true | false | null (not known yet)
//   liked      what the heart shows: the visitor's latest tap, or what the database said
//   views      the video's view total as the server last told us; viewPending adds the optimistic +1 on top
//   saving     a save is in flight
//   rev        goes up on every tap, so a read that was already on its way when you tapped can't undo what you just did
// What is DRAWN for the like number is   count + (liked ? 1 : 0) - (server ? 1 : 0)   : the database's count, corrected
// by the difference between what the heart shows and what the database holds. So the number is always consistent with the
// heart, however many taps and reads cross each other.
const stats = new Map();
const painters = new Map(); // videoId -> Set of functions that redraw one like/views row

function stat(id) {
  let s = stats.get(id);
  if (!s) {
    s = {
      count: null,
      server: null,
      liked: false,
      views: 0,
      viewPending: false,
      loadedAt: 0,
      promise: null,
      failed: false,
      saving: false,
      rev: 0,
      note: "",
      noteTimer: 0,
    };
    stats.set(id, s);
  }
  return s;
}

function shownLikes(s) {
  if (s.count === null) return null;
  return Math.max(0, s.count + (s.liked ? 1 : 0) - (s.server === true ? 1 : 0));
}

function repaint(id) {
  const set = painters.get(id);
  if (set) set.forEach((paint) => paint());
}

function setNote(id, text) {
  const s = stat(id);
  clearTimeout(s.noteTimer);
  s.note = text;
  if (text) {
    s.noteTimer = setTimeout(() => {
      s.note = "";
      repaint(id);
    }, NOTE_MS);
  }
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------
const likesOf = (id) => collection(db, "videos", id, "likes");
const readCount = (id) => getCountFromServer(likesOf(id)).then((snap) => snap.data().count);
const readMine = (id) =>
  ensureSignedIn()
    .then((uid) => getDoc(doc(db, "videos", id, "likes", uid)))
    .then((snap) => snap.exists());

function forgetWhoLiked() {
  painters.forEach((_, id) => {
    const s = stat(id);
    s.server = null;
    s.liked = false;
    load(id, { force: true });
  });
}

// Reads the like count and whether this visitor liked the video. Safe to call again and again: while a read is
// running it hands back the same one, and a count that is less than a minute old is reused. The two reads run at the
// same time and each is used the moment it arrives (the count doesn't wait for the visitor's own like).
function load(id, { force = false } = {}) {
  const s = stat(id);
  if (s.promise) return force ? s.promise.then(() => load(id, { force: true })) : s.promise;
  if (!force && s.count !== null && s.server !== null && Date.now() - s.loadedAt < LIKES_FRESH_MS) return Promise.resolve();

  const rev = s.rev;
  const t0 = performance.now();
  const stale = () => s.rev !== rev || s.saving; // the visitor tapped (or a save is running): what they did is newer than this read
  s.failed = false;
  repaint(id);

  const counting = readCount(id).then(
    (count) => {
      record("like-count", { ms: since(t0) });
      if (stale() || !Number.isFinite(count)) return;
      s.count = count;
      s.loadedAt = Date.now();
      s.failed = false;
      repaint(id);
    },
    (error) => {
      console.warn(`Likes could not be loaded for video ${id}:`, error);
      if (!stale() && s.count === null) {
        s.failed = true;
        repaint(id);
      }
    }
  );
  const mine = readMine(id).then(
    (liked) => {
      record("like-own", { ms: since(t0) });
      if (stale()) return;
      s.server = liked;
      s.liked = liked;
      repaint(id);
    },
    (error) => console.warn(`Could not tell whether this visitor liked video ${id}:`, error)
  );
  s.promise = Promise.all([counting, mine]).finally(() => {
    s.promise = null;
    repaint(id);
  });
  return s.promise;
}

// The real count again, after a save, without anybody waiting for it. If the visitor has tapped since this read was
// started, a newer save is running (and will ask again when it is done), so this answer is simply dropped.
function refreshCount(id) {
  const s = stat(id);
  const rev = s.rev;
  const t0 = performance.now();
  readCount(id).then(
    (count) => {
      record("like-refresh", { ms: since(t0) });
      if (s.rev !== rev || s.saving || !Number.isFinite(count)) return;
      s.count = count;
      s.loadedAt = Date.now();
      s.failed = false;
      repaint(id);
    },
    () => {
      /* keep the number on screen; the next visit or tap reads it again */
    }
  );
}

// Runs fn(op) and gives up on it after limitMs. A transaction can't be cancelled once it is on its way, so a given-up
// one is told (op.dead) not to write anything if it ever gets as far as doing so.
function withTimeout(fn, limitMs) {
  const op = { dead: false };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      op.dead = true;
      reject(new Error("The like was not saved in time"));
    }, limitMs);
    let started;
    try {
      started = Promise.resolve(fn(op));
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Makes the database hold exactly what the visitor wants (liked or not liked). The decision is made inside the
// transaction from what the database says right now, not from what the page thinks, so two tabs or a double tap can
// never create a second like or fail.
function likeTransaction(id, want, op) {
  return ensureSignedIn().then((uid) => {
    const ref = doc(db, "videos", id, "likes", uid);
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (op.dead) return { liked: snap.exists() }; // given up on while it was waiting: change nothing
      if (want && !snap.exists()) {
        tx.set(ref, { likedAt: serverTimestamp() });
        return { liked: true };
      }
      if (!want && snap.exists()) {
        tx.delete(ref);
        return { liked: false };
      }
      return { liked: want }; // already as wanted (say, another tab got there first)
    });
  });
}

// Saves what the heart shows. Only one save runs per video at a time; if the visitor taps again meanwhile the heart
// has already changed, and this loop just goes round once more with the newest wish.
async function saveLike(id) {
  const s = stat(id);
  if (s.saving) return;
  s.saving = true;
  repaint(id);
  const t0 = performance.now();
  let failed = false;
  try {
    for (let round = 0; s.server !== s.liked; round += 1) {
      if (round >= 50) throw new Error("Too many rounds");
      const want = s.liked;
      const believed = s.server;
      const out = await withTimeout((op) => likeTransaction(id, want, op), SAVE_TIMEOUT_MS);
      // The database now holds out.liked. If that isn't what we believed it held, its count moved by one as well.
      if (believed !== null && believed !== out.liked && s.count !== null) s.count = Math.max(0, s.count + (out.liked ? 1 : -1));
      s.server = out.liked;
    }
    record("like-save", { ms: since(t0), ok: 1 });
  } catch (error) {
    failed = true;
    console.warn(`Like could not be saved for video ${id}:`, error);
    s.liked = s.server === null ? false : s.server; // show what the database holds again
    setNote(id, NOTE_TEXT);
    record("like-save", { ms: since(t0), ok: 0 });
  } finally {
    s.saving = false;
    repaint(id);
  }
  if (failed) setTimeout(() => load(id, { force: true }), 1500); // learn the truth (a given-up save may have landed after all)
  else refreshCount(id); //                                        the real count, in the background
}

// One tap on the heart.
function toggleLike(id) {
  const s = stat(id);
  s.rev += 1;
  setNote(id, "");
  s.liked = !s.liked; // the heart (and, through it, the number) changes right now
  repaint(id);
  saveLike(id);
}

// ---------------------------------------------------------------------------
// The like button and the views, as they appear on a card and in the full-screen player
// ---------------------------------------------------------------------------
// A card reads its like count only when it is near the screen, so a page of videos costs a few reads, not a burst.
const nearObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            nearObserver.unobserve(entry.target);
            if (typeof entry.target._onNear === "function") entry.target._onNear();
          });
        },
        { rootMargin: `${NEAR_PX}px` }
      )
    : null;

// "2 likes" is drawn as a number and a unit, so a narrow screen can show just the number (the unit stays in the
// page for screen readers, and the button's own label says it in full).
function setCount(node, number, unit) {
  if (!node._number) {
    node._number = el("span", "vid-num");
    node._unit = el("span", "vid-unit");
    node.append(node._number, node._unit);
  }
  node._number.textContent = number;
  node._unit.textContent = unit ? ` ${unit}` : "";
}

export function buildStats(item, { player = false } = {}) {
  const id = item.id;
  const s = stat(id);
  if (Number.isFinite(item.views) && item.views > s.views) s.views = item.views;

  const root = el("div", player ? "vid-stats vid-stats--player" : "vid-stats");
  const group = el("div", "vid-engage"); // the like button and the views: one row, one look
  const like = el("button", "like-btn vid-like is-loading");
  like.type = "button";
  like.setAttribute("aria-pressed", "false");
  const likeText = el("span", "like-count");
  setCount(likeText, "–", "");
  like.append(icon("heart"), likeText);
  const sep = el("span", "vid-sep", "·");
  sep.setAttribute("aria-hidden", "true");
  const views = el("span", "vid-views");
  const viewsText = el("span", "vid-views-text");
  views.append(icon("eye"), viewsText);
  group.append(like, sep, views);
  const note = el("span", "vid-stats-note");
  note.setAttribute("role", "status");
  root.append(group, note);

  const paint = () => {
    const st = stat(id);
    const shown = shownLikes(st);
    const unknown = shown === null;
    const retry = unknown && st.failed;
    like.classList.toggle("is-loading", unknown && !st.failed);
    if (retry) like.dataset.retry = "true";
    else delete like.dataset.retry;
    like.setAttribute("aria-pressed", st.liked ? "true" : "false");
    like.setAttribute("aria-busy", st.saving ? "true" : "false");
    if (unknown) {
      setCount(likeText, "–", "");
      like.setAttribute("aria-label", retry ? "Like this video. The like count couldn't load." : "Like this video");
      like.title = retry ? "Couldn't load the like count" : "";
    } else {
      const word = shown === 1 ? "like" : "likes";
      setCount(likeText, formatNumber(shown), word);
      like.setAttribute("aria-label", `Like this video. ${formatNumber(shown)} ${word}.`);
      like.title = "";
    }
    // the view total, plus the +1 that is shown while the server is still confirming it
    const total = st.views + (st.viewPending ? 1 : 0);
    const viewWord = total === 1 ? "view" : "views";
    setCount(viewsText, formatNumber(total), viewWord);
    views.title = `${formatNumber(total)} ${viewWord}`;
    if (st.viewPending) views.dataset.pending = "true";
    else delete views.dataset.pending;
    note.textContent = st.note;
  };

  like.addEventListener("click", () => {
    const turningOn = !stat(id).liked;
    toggleLike(id);
    if (turningOn) {
      // a small pop on the heart (CSS, off for people who asked for less motion); the class is removed when it ends
      like.classList.remove("pop");
      void like.offsetWidth; // lets the animation start again on a quick like / unlike / like
      like.classList.add("pop");
      setTimeout(() => like.classList.remove("pop"), 400);
    }
  });

  let set = painters.get(id);
  if (!set) painters.set(id, (set = new Set()));
  set.add(paint);
  paint();

  if (!player) {
    if (nearObserver) {
      root._onNear = () => load(id);
      nearObserver.observe(root);
    } else {
      setTimeout(() => load(id), 0);
    }
  }

  return {
    el: root,
    release() {
      set.delete(paint);
      if (nearObserver) nearObserver.unobserve(root);
    },
  };
}

export function loadStats(id) {
  return load(id);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
// This browser's own note of when each video is next due to count, so a refresh or a second look never even asks the
// server. It is only a shortcut: the server decides.
function readSeen() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

// When this browser's note says the next view is due (a time in ms), or 0 if it isn't holding one back.
function snoozedUntil(id) {
  const until = Number(readSeen()[id]);
  return Number.isFinite(until) && until > Date.now() ? until : 0;
}

// Has this browser counted this video before (even if that was more than 24 hours ago)? Sent to the server as a hint
// that saves it a step; see "returning" in api/engagement.js. It never changes what is counted.
function countedBefore(id) {
  const until = Number(readSeen()[id]);
  return Number.isFinite(until) && until > 0;
}

function remember(id, untilIso) {
  const until = Date.parse(untilIso);
  if (!Number.isFinite(until)) return;
  const seen = readSeen();
  const now = Date.now();
  Object.keys(seen).forEach((key) => {
    if (!(Number(seen[key]) > now - SEEN_KEEP_MS)) delete seen[key];
  });
  seen[id] = until;
  const keys = Object.keys(seen);
  if (keys.length > SEEN_LIMIT) keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - SEEN_LIMIT).forEach((key) => delete seen[key]);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch (e) {
    /* private mode or full: the server still stops repeats */
  }
}

// One request to the views server, with the visitor's login token. Times each step (token, request) and reads the
// server's own breakdown. Throws for anything but a 200 (error.status, error.permanent).
async function callServer(body, { kind, keepalive = false }) {
  let tokenMs = 0;
  let requestMs = 0;
  const send = async (force) => {
    const t1 = performance.now();
    const token = await getToken(force);
    tokenMs += since(t1);
    const t2 = performance.now();
    const res = await fetch(VIEW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      cache: "no-store",
      keepalive, // a view still goes through if the visitor closes the page a moment after the 5 seconds
    });
    requestMs += since(t2); // until the server's answer started to arrive
    return res;
  };
  let res = await send(false);
  if (res.status === 401) res = await send(true); // an expired login: one try with a fresh one
  const server = readServerTiming(res.headers && res.headers.get && res.headers.get("server-timing"));
  const timing = { token_ms: tokenMs, request_ms: requestMs, status: res.status };
  if (typeof server.total === "number") timing.network_ms = Math.max(0, Math.round((requestMs - server.total) * 10) / 10); // the part that wasn't the server working
  timing.server = server;
  if (!res.ok) {
    record(kind, { ...timing, ok: 0 });
    const error = new Error(`HTTP ${res.status}`);
    error.permanent = PERMANENT_FAILURES.has(res.status);
    throw error;
  }
  let answer = null;
  try {
    answer = await res.json();
  } catch (e) {
    answer = null;
  }
  if (!answer || answer.ok !== true) {
    record(kind, { ...timing, ok: 0 });
    throw new Error("Unexpected answer from the views service");
  }
  return { answer, timing };
}

// Wakes the views server (and prepares this browser's login token and connection) shortly before a view may be
// needed. Counts nothing. Quiet if it fails: the real report does everything itself anyway, just a little slower.
let lastWarmAt = 0;
function warmServer() {
  const now = Date.now();
  if (lastWarmAt && now - lastWarmAt < WARM_EVERY_MS) return;
  lastWarmAt = now;
  callServer({ action: "warm" }, { kind: "warm" }).then(
    ({ timing }) => record("warm", { ...timing, ok: 1 }),
    () => {
      lastWarmAt = 0; // try again the next time a video starts
    }
  );
}

// One entry per video, for as long as the page stays open:
//   seconds  of real, visible playback so far (counts up across plays of the same video)
//   state    idle (collecting seconds) | sending (a report is in flight) | done (reported, or not due)
//   dueAt    when "done" ends because the 24 hours are up (ms; 0: never on this page), so a page left open for a day
//            counts the next watch too
//   startup  how long the video took to start playing for real (ms), for the timing record
const meters = new Map();
function meterOf(id) {
  let m = meters.get(id);
  if (!m) meters.set(id, (m = { seconds: 0, state: "idle", dueAt: 0, startup: 0 }));
  return m;
}

function setViewPending(id, on) {
  const s = stat(id);
  if (s.viewPending === on) return;
  s.viewPending = on;
  repaint(id);
}

async function reportView(id) {
  const meter = meterOf(id);
  if (meter.state !== "idle") return;
  meter.state = "sending";
  const holdUntil = snoozedUntil(id);
  if (holdUntil) {
    meter.state = "done"; // this browser already knows the next view isn't due yet
    meter.dueAt = holdUntil;
    return;
  }
  const returning = countedBefore(id); //   (its 24 hours are over, or the note would have held this back)
  const qualifiedAt = performance.now(); // the 5 seconds are up
  setViewPending(id, true); //               show the +1 now (faintly); the server's answer replaces it
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { answer, timing } = await callServer(returning ? { action: "view", videoId: id, returning: true } : { action: "view", videoId: id }, { kind: "view", keepalive: true });
      setViewPending(id, false); // the guess is over: what follows is the server's word
      meter.state = "done";
      meter.dueAt = Date.parse(answer.nextEligibleAt) || 0;
      remember(id, answer.nextEligibleAt);
      if (answer.counted) {
        const s = stat(id);
        s.views = Number.isFinite(answer.viewCount) ? answer.viewCount : s.views + 1;
        repaint(id);
      }
      record("view", { ...timing, counted: answer.counted ? 1 : 0, startup_ms: meter.startup, answered_after_ms: since(qualifiedAt), ok: 1 });
      return;
    } catch (error) {
      setViewPending(id, false); // not counted (yet): take the +1 back, whatever the reason
      if (error && error.permanent) {
        console.warn("View was not counted:", error.message);
        meter.state = "done"; // asking again won't change the answer
        return;
      }
      if (attempt >= VIEW_RETRY_MS.length) {
        console.warn("View could not be reported:", error);
        meter.state = "idle"; // another 5 seconds of playing earns another try
        meter.seconds = 0;
        return;
      }
      await sleep(VIEW_RETRY_MS[attempt]);
    }
  }
}

// Watches one <video> and adds up the seconds it REALLY played with the tab visible. Returns a function that stops
// watching (call it when the video element is thrown away).
//
// A second only counts while all of these are true: the video is playing (not paused, ended, seeking or
// buffering), it has data to show, and the tab is visible. Dragging the progress bar doesn't add seconds, and a
// video stuck on a frame doesn't either: the credit for each stretch is the smaller of the clock time that passed
// and the video time that actually moved.
export function trackPlayback(video, item) {
  const id = item.id;
  const meter = meterOf(id);
  const attachedAt = performance.now();
  let startedAt = 0; //    clock time when the current stretch of real playback began (0: not playing)
  let startedMedia = 0; // the video's position then
  let lastMedia = 0; //    the latest position seen while playing (a seek moves currentTime before we can look)
  let timer = 0;
  let detached = false;
  let playedOnce = false;

  const playingNow = () =>
    !detached &&
    !video.paused &&
    !video.ended &&
    !video.seeking &&
    video.readyState >= 3 &&
    document.visibilityState === "visible";

  function credit() {
    if (!startedAt) return;
    const clock = (performance.now() - startedAt) / 1000;
    const moved = Math.max(0, (video.seeking ? lastMedia : video.currentTime) - startedMedia);
    const rate = video.playbackRate > 0 ? video.playbackRate : 1;
    meter.seconds += Math.max(0, Math.min(clock, moved / rate));
    startedAt = 0;
    clearTimeout(timer);
    timer = 0;
  }

  function judge() {
    if (meter.state === "idle" && meter.seconds >= VIEW_SECONDS) reportView(id);
  }

  function begin() {
    if (meter.state === "done" && meter.dueAt && Date.now() >= meter.dueAt) {
      meter.state = "idle"; // the 24 hours ran out while this page stayed open: this watch can count again
      meter.seconds = 0;
      meter.dueAt = 0;
    }
    if (startedAt || meter.state !== "idle" || !playingNow()) return;
    if (!playedOnce) {
      playedOnce = true;
      meter.startup = since(attachedAt); // how long this video took to really start
      record("play-start", { startup_ms: meter.startup });
    }
    startedAt = performance.now();
    startedMedia = lastMedia = video.currentTime;
    const remaining = Math.max(0, VIEW_SECONDS - meter.seconds);
    timer = setTimeout(() => {
      credit();
      judge();
      begin(); // it stalled for part of that time and isn't at 5 seconds yet: keep watching
    }, remaining * 1000 + 80);
  }

  function end() {
    credit();
    judge();
  }

  const onTime = () => {
    if (startedAt && !video.seeking) lastMedia = video.currentTime;
  };
  const onVisibility = () => (document.visibilityState === "visible" ? begin() : end());
  const STOPS = ["pause", "waiting", "seeking", "ended", "emptied", "error", "abort"];
  const STARTS = ["playing", "seeked", "canplay"];
  STOPS.forEach((name) => video.addEventListener(name, end));
  STARTS.forEach((name) => video.addEventListener(name, begin));
  video.addEventListener("timeupdate", onTime);
  document.addEventListener("visibilitychange", onVisibility);
  // The video exists, so it is probably about to play: get the server awake and the login token ready now, while the
  // visitor is still looking at the first frames, instead of after the 5 seconds. (Not if this browser already knows
  // the next view isn't due.)
  if (meter.state === "idle" && !snoozedUntil(id)) warmServer();
  begin(); // already playing by the time this was attached

  return function stopWatching() {
    end();
    detached = true;
    STOPS.forEach((name) => video.removeEventListener(name, end));
    STARTS.forEach((name) => video.removeEventListener(name, begin));
    video.removeEventListener("timeupdate", onTime);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
