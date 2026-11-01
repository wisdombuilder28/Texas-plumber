// video-engagement-live.js
// Likes and the public "Views" number for the Recent Work: Videos page.
//
// videos-live.js loads this file on its own, so a problem in here can never stop the video list or the player from
// working. It hands three things back to it:
//   buildStats(item, { player })   the like button and "N views" for one video (a card, or the full-screen player)
//   loadStats(videoId)             reads that video's like count and whether this visitor liked it
//   trackPlayback(video, item)     watches one <video> element and reports a view once it has really played
//
// LIKES work the way the image likes on the Images page do (see work-live.js and firestore.rules):
//   * Every visitor is signed in silently and anonymously, so each browser has a stable Firebase UID. Nobody is
//     ever asked to log in and no personal detail is stored.
//   * A like is ONE small document at videos/{videoId}/likes/{uid}. The document ID is the visitor's UID, so
//     Firestore itself refuses a second like from the same visitor on the same video; it isn't just a check here.
//     Unliking deletes that document.
//   * The number shown is how many of those documents exist (an aggregate count, which costs one read however many
//     likes there are). There is no counter anyone could tamper with or that could drift out of step.
//   * A tap runs as one Firestore transaction (read the visitor's own like, then write), so a double tap, or the
//     same visitor in two tabs, can never double-like or hit an error; the result is always "liked" or "not liked".
//     The button changes at once and the real count replaces the guess as soon as the database has answered.
//
// VIEWS are counted by the server (api/engagement.js), because a view is "once per visitor per video per 24 hours"
// and that can't be left to the browser. This file decides WHEN to ask: only after the visitor has really watched
// the video for 5 seconds with the tab visible. Merely opening a video, a thumbnail loading, a paused or buffering
// video, a video playing in a background tab, or one that failed to play never count. The server then makes the
// final decision (24 hours, one per visitor), and answers with the new total.
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
const SEEN_KEY = "ndf-video-views-v1"; //       this browser's note of "already counted, not due again until ..."
const SEEN_LIMIT = 300;
const LIKES_FRESH_MS = 60 * 1000; //            how long a like count read from the database is reused before asking again
const NOTE_MS = 5000; //                        how long a "couldn't save" message stays
const NOTE_TEXT = "Couldn't save that. Check your connection and try again.";
const NEAR_PX = 300; //                         a card loads its like count when it comes within this distance of the screen
const PERMANENT_FAILURES = new Set([400, 401, 404, 405, 413, 501]); // answers that asking again won't change

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
// Who is this visitor? (the same silent, anonymous sign-in the Images page uses)
// ---------------------------------------------------------------------------
let currentUid = null;
let signInPromise = null;

// Returns a UID, signing in anonymously if needed. It waits for Firebase to finish restoring any saved login first and
// then uses whoever is signed in: signInAnonymously() would replace a signed-in admin with a brand-new anonymous
// session, so it is only called when nobody is signed in at all.
function ensureSignedIn() {
  if (currentUid) return Promise.resolve(currentUid);
  if (!signInPromise) {
    signInPromise = Promise.resolve(auth.authStateReady && auth.authStateReady())
      .then(() => auth.currentUser || signInAnonymously(auth).then((result) => result.user))
      .then((user) => {
        currentUid = user.uid;
        return currentUid;
      })
      .catch((error) => {
        signInPromise = null; // let the next attempt try again instead of staying stuck
        throw error;
      });
  }
  return signInPromise;
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    const switched = currentUid && currentUid !== user.uid;
    currentUid = user.uid;
    if (switched) forgetWhoLiked(); // a different person is signed in now (say, the admin logged out in another tab)
  } else {
    const had = currentUid;
    currentUid = null;
    signInPromise = null;
    if (had) forgetWhoLiked();
    ensureSignedIn().catch((error) => console.warn("Anonymous sign-in failed:", error));
  }
});

// ---------------------------------------------------------------------------
// What is known about each video, shared by its card and its slide in the player so they always agree
// ---------------------------------------------------------------------------
// { likes: number | null, liked: boolean | null, views: number, loadedAt, promise, failed, busy, note, noteTimer, rev }
//   rev goes up on every tap, so a read that was already on its way when you tapped can't undo what you just did.
const stats = new Map();
const painters = new Map(); // videoId -> Set of functions that redraw one like/views row

function stat(id) {
  let s = stats.get(id);
  if (!s) {
    s = { likes: null, liked: null, views: 0, loadedAt: 0, promise: null, failed: false, busy: false, note: "", noteTimer: 0, rev: 0 };
    stats.set(id, s);
  }
  return s;
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

function forgetWhoLiked() {
  painters.forEach((_, id) => {
    stat(id).liked = null;
    load(id, { force: true });
  });
}

// Reads the like count and whether this visitor liked the video. Safe to call again and again: while a read is
// running it hands back the same one, and a count that is less than a minute old is reused.
function load(id, { force = false } = {}) {
  const s = stat(id);
  if (s.promise) return force ? s.promise.then(() => load(id, { force: true })) : s.promise;
  if (!force && s.likes !== null && s.liked !== null && Date.now() - s.loadedAt < LIKES_FRESH_MS) return Promise.resolve();

  const rev = s.rev;
  s.failed = false;
  repaint(id);
  s.promise = Promise.allSettled([
    getCountFromServer(likesOf(id)).then((snap) => snap.data().count),
    ensureSignedIn()
      .then((uid) => getDoc(doc(db, "videos", id, "likes", uid)))
      .then((snap) => snap.exists()),
  ])
    .then(([count, mine]) => {
      if (s.rev !== rev) return; // the visitor tapped Like while this was loading: what they did is newer
      if (count.status === "fulfilled" && Number.isFinite(count.value)) {
        s.likes = count.value;
        s.loadedAt = Date.now();
        s.failed = false;
      } else {
        console.warn(`Likes could not be loaded for video ${id}:`, count.reason);
        if (s.likes === null) s.failed = true;
      }
      if (mine.status === "fulfilled") s.liked = mine.value;
      else console.warn(`Could not tell whether this visitor liked video ${id}:`, mine.reason);
    })
    .finally(() => {
      s.promise = null;
      repaint(id);
    });
  return s.promise;
}

// One tap on the heart. The decision is made from what the database says (inside a transaction), not from what the
// button currently shows, which can be a moment behind (a second tab, a slow connection).
async function toggleLike(id) {
  const s = stat(id);
  if (s.busy) return;
  if (s.likes === null) {
    if (s.failed) load(id, { force: true }); // "couldn't load": a tap tries again instead of liking
    return;
  }

  const want = s.liked === null ? null : !s.liked; // null: we don't know, so just flip whatever is stored
  const before = { likes: s.likes, liked: s.liked };
  s.busy = true;
  s.rev += 1;
  setNote(id, "");
  if (want !== null) {
    s.liked = want; // show the result straight away; the database's own answer replaces it below
    s.likes = Math.max(0, s.likes + (want ? 1 : -1));
  }
  repaint(id);

  try {
    const uid = await ensureSignedIn();
    const ref = doc(db, "videos", id, "likes", uid);
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const make = want === null ? !snap.exists() : want;
      if (make && !snap.exists()) {
        tx.set(ref, { likedAt: serverTimestamp() });
        return { liked: true, changed: true };
      }
      if (!make && snap.exists()) {
        tx.delete(ref);
        return { liked: false, changed: true };
      }
      return { liked: make, changed: false }; // already as wanted (say, another tab got there first)
    });
    s.liked = result.liked;
    s.likes = Math.max(0, before.likes + (result.changed ? (result.liked ? 1 : -1) : 0)); // our best figure until the real one arrives
    repaint(id);
    try {
      s.likes = (await getCountFromServer(likesOf(id))).data().count; // the real count, including anyone else's likes
      s.loadedAt = Date.now();
    } catch (e) {
      /* keep our figure */
    }
  } catch (error) {
    console.warn(`Like could not be saved for video ${id}:`, error);
    s.liked = before.liked;
    s.likes = before.likes;
    setNote(id, NOTE_TEXT);
  } finally {
    s.busy = false;
    repaint(id);
  }
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

export function buildStats(item, { player = false } = {}) {
  const id = item.id;
  const s = stat(id);
  if (Number.isFinite(item.views) && item.views > s.views) s.views = item.views;

  const root = el("div", player ? "vid-stats vid-stats--player" : "vid-stats");
  const like = el("button", "like-btn vid-like is-loading");
  like.type = "button";
  like.setAttribute("aria-pressed", "false");
  const likeText = el("span", "like-count", "–");
  like.append(icon("heart"), likeText);
  const views = el("span", "vid-views");
  const viewsText = el("span", "vid-views-text");
  views.append(icon("eye"), viewsText);
  const note = el("span", "vid-stats-note");
  note.setAttribute("role", "status");
  root.append(like, views, note);

  const paint = () => {
    const st = stat(id);
    const unknown = st.likes === null;
    const retry = unknown && st.failed;
    like.classList.toggle("is-loading", unknown && !st.failed);
    if (retry) like.dataset.retry = "true";
    else delete like.dataset.retry;
    like.setAttribute("aria-pressed", st.liked ? "true" : "false");
    like.disabled = st.busy || (unknown && !st.failed);
    if (unknown) {
      likeText.textContent = "–";
      like.setAttribute("aria-label", retry ? "Likes couldn't load. Tap to try again." : "Like this video");
      like.title = retry ? "Couldn't load likes. Tap to try again." : "";
    } else {
      likeText.textContent = `${formatNumber(st.likes)} ${st.likes === 1 ? "like" : "likes"}`;
      like.setAttribute("aria-label", `Like this video. ${formatNumber(st.likes)} ${st.likes === 1 ? "like" : "likes"}.`);
      like.title = "";
    }
    viewsText.textContent = `${formatNumber(st.views)} ${st.views === 1 ? "view" : "views"}`;
    note.textContent = st.note;
  };

  like.addEventListener("click", () => toggleLike(id));

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

function remember(id, untilIso) {
  const until = Date.parse(untilIso);
  if (!Number.isFinite(until)) return;
  const seen = readSeen();
  const now = Date.now();
  Object.keys(seen).forEach((key) => {
    if (!(Number(seen[key]) > now)) delete seen[key];
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

async function postView(id) {
  await ensureSignedIn();
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const send = (token) =>
    fetch(VIEW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "view", videoId: id }),
      cache: "no-store",
      keepalive: true, // still goes through if the visitor closes the page a moment after the 5 seconds
    });
  let res = await send(await user.getIdToken());
  if (res.status === 401) res = await send(await user.getIdToken(true)); // an expired login: one try with a fresh one
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.permanent = PERMANENT_FAILURES.has(res.status);
    throw error;
  }
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  if (!body || body.ok !== true) throw new Error("Unexpected answer from the views service");
  return body;
}

// One entry per video, for as long as the page stays open:
//   seconds  of real, visible playback so far (counts up across plays of the same video)
//   state    idle (collecting seconds) | sending (a report is in flight) | done (reported, or not due)
//   dueAt    when "done" ends because the 24 hours are up (ms; 0: never on this page), so a page left open for a day
//            counts the next watch too
const meters = new Map();
function meterOf(id) {
  let m = meters.get(id);
  if (!m) meters.set(id, (m = { seconds: 0, state: "idle", dueAt: 0 }));
  return m;
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
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await postView(id);
      meter.state = "done";
      meter.dueAt = Date.parse(answer.nextEligibleAt) || 0;
      remember(id, answer.nextEligibleAt);
      if (answer.counted) {
        const s = stat(id);
        s.views = Number.isFinite(answer.viewCount) ? answer.viewCount : s.views + 1;
        repaint(id);
      }
      return;
    } catch (error) {
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
  let startedAt = 0; //    clock time when the current stretch of real playback began (0: not playing)
  let startedMedia = 0; // the video's position then
  let lastMedia = 0; //    the latest position seen while playing (a seek moves currentTime before we can look)
  let timer = 0;
  let detached = false;

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
