// videos-live.js
// Shows the videos on the Recent Work: Videos page (work-videos.html).
//
// The list comes from the `videos` collection in Firestore (written by the admin Videos page).
// The video files themselves sit in a private storage bucket, so this page never holds a permanent
// address for one: pressing play asks /api/videos for a link that works for a few hours, then plays it.
// The link is asked for a moment ahead (when a card comes into view or is touched), so play starts at once.
//
// Tapping a card opens a FULL-SCREEN player. The videos of the current list are slides in one row: swipe left or
// right (or use the arrow keys / the arrows on a computer) to play the one next to it. Only the video on screen and
// its two neighbours ever hold a video element; the next one is warmed up once the current one is playing smoothly,
// so a swipe starts playing straight away without the two videos fighting over a slow connection.
// If a video won't play, the page says why as far as it can tell (no connection to the video server, or the
// device couldn't play it) instead of always blaming the connection.
//
// The video is the star of the player: it is always shown whole (never stretched, never cropped) over a blurred, darkened copy
// of its own cover picture, whatever its shape (tall, wide, square). The text is small and sits at the bottom left, the like
// button and the view count in a column at the right edge, and a long description opens in a sheet ("Read more") that
// pauses the video while it is open. Three seconds after a video starts playing, the text and the controls fade away;
// a touch brings them back, and they stay while the video is paused, loading or failed.
//
// Each card shows only the small cover picture saved with the video (whole, over a blurred copy of itself, in an area of
// one fixed shape so tall, wide and square videos sit in the same neat grid), so the page costs almost nothing
// until somebody presses play. Videos load six at a time; "Show more videos" fetches the next six (and the
// player fetches them by itself when you swipe near the end).
//
// Everything on screen is built with createElement / textContent, so a title or description is never
// read as HTML. While the list loads the page says "Loading videos…". If the list is empty it says so, and if it
// can't be loaded (offline, rules not published yet) it says that too, with a "Try again" button.
//
// Likes and the "Views" number (on each card and in the full-screen player) come from video-engagement-live.js.
// It is loaded on its own, so if it ever fails to load the list and the player carry on exactly as before, just
// without the like button and the view count.
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  orderBy,
  limit,
  startAfter,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

let engagement = null;
const engagementReady = import("./video-engagement-live.js")
  .then((module) => {
    engagement = module;
  })
  .catch((error) => console.warn("Likes and views are unavailable:", error));

// Runs fn(module) now if the likes/views code is loaded, or as soon as it is. A problem in there never reaches the page.
function withEngagement(fn) {
  const run = () => {
    if (!engagement) return;
    try {
      fn(engagement);
    } catch (error) {
      console.warn("Likes and views problem:", error);
    }
  };
  if (engagement) run();
  else engagementReady.then(run);
}

const PAGE_SIZE = 6;
const LOAD_TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [3000, 8000]; // if the first load fails, try twice more before giving up quietly
const MAX_TITLE = 80;
const MAX_CAPTION = 300;
const MAX_POSTER_CHARS = 140000; // the same ceiling as the admin page and firestore.rules
const DATA_IMAGE = /^data:image\/(jpe?g|png|webp|gif|avif);base64,/i;
const VIDEO_KEY = /^videos\/[A-Za-z0-9_-]{8,64}\.(mp4|webm)$/;
const CAPTION_PREVIEW = 100; //   characters of the description shown over the video before "Read more"
const SPEEDS = [1, 1.5, 2];
const SETTLE_MS = 90; //          how long the swipe row must be still before the new video starts
const SPINNER_DELAY_MS = 450; //  the spinner only shows if a video still isn't moving after this long
const SLOW_HINT_MS = 7000; //     ...and says "slow connection" only after this long
const WARM_NEXT_AHEAD_S = 15; //  seconds buffered ahead of the playing video before the next one is warmed up
const IDLE_MS = 3000; //          the text and controls fade away this long after a video starts playing (or after the last touch)
const SHEET_MS = 280; //          how long the "Read more" sheet takes to slide away (the transition in work-videos.css is .26s)

// KEEP IN SYNC with admin/js/videos-admin.js (CATEGORIES) and firestore.rules.
const CATEGORIES = ["showcase", "before-after", "testimonial"];
const CARD_LABEL = { showcase: "Job showcase", "before-after": "Before & after", testimonial: "Testimonial" };
const TAB_LABEL = { showcase: "Job showcases", "before-after": "Before & afters", testimonial: "Testimonials" };

const $ = (id) => document.getElementById(id);
const section = $("videos");
const listEl = $("video-list");
const tabsEl = $("video-filter");
const moreBtn = $("video-more");
const statusEl = $("video-status"); //   "Loading…" / "No videos yet" / "Couldn't load" (the page still works without it)
const statusText = $("video-status-text");
const retryBtn = $("video-retry");
const viewer = $("vid-viewer");
const trackEl = $("vid-track");
const closeBtn = $("vid-close");
const countEl = $("vid-count");
const prevBtn = $("vid-prev");
const nextBtn = $("vid-next");
const seekEl = $("vid-seek");
const timeEl = $("vid-time");
const totalEl = $("vid-total");
const speedBtn = $("vid-speed");
const muteBtn = $("vid-mute");
// Newer parts of the player. Each one is optional: if an older copy of work-videos.html is cached without it, the player still works.
const topEl = viewer ? viewer.querySelector(".vid-top") : null;
const controlsEl = $("vid-controls");
const playBtn = $("vid-play");
const volumeEl = $("vid-volume");
const fsBtn = $("vid-fs");
const miniEl = viewer ? viewer.querySelector(".vid-mini") : null;
const sheetEl = $("vid-sheet"); //            "Read more": the sheet that slides up with the whole title and description
const sheetPanel = sheetEl ? sheetEl.querySelector(".vid-sheet-panel") : null;
const sheetHead = sheetEl ? sheetEl.querySelector(".vid-sheet-head") : null;
const sheetScroll = sheetEl ? sheetEl.querySelector(".vid-sheet-scroll") : null;
const sheetScrim = $("vid-sheet-scrim");
const sheetCloseBtn = $("vid-sheet-close");
const sheetMeta = $("vid-sheet-meta");
const sheetTitle = $("vid-sheet-title");
const sheetText = $("vid-sheet-text");

const items = []; // { id, key, title, caption, category, poster, dur, w, h, pw, ph, date, el }
let lastDoc = null; // the last video shown so far: the next page starts after it
let hasMore = false;
let loading = false;
let loadedOnce = false;
let moreFailed = false;
let activeFilter = "all";
let tabSignature = null;
let phase = "loading"; // the first load of the list: loading | ready | failed

// ---------- small helpers ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function playIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M8 5v14l11-7z");
  svg.appendChild(path);
  return svg;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

function formatDate(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== "function") return "";
  return timestamp.toDate().toLocaleDateString("en-NG", { month: "long", year: "numeric" });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- turning a Firestore entry into something safe to show ----------
function toItem(snap) {
  const d = snap.data();
  if (!d || typeof d.key !== "string" || !VIDEO_KEY.test(d.key)) return null; // can't be played: skip it
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const title = typeof d.title === "string" ? d.title.trim().slice(0, MAX_TITLE) : "";
  return {
    id: snap.id,
    key: d.key,
    title: title || "Video",
    caption: typeof d.caption === "string" ? d.caption.trim().slice(0, MAX_CAPTION) : "",
    category: CATEGORIES.includes(d.category) ? d.category : "showcase",
    poster: typeof d.poster === "string" && d.poster.length <= MAX_POSTER_CHARS && DATA_IMAGE.test(d.poster) ? d.poster : "",
    dur: num(d.durationSec),
    w: num(d.width),
    h: num(d.height),
    pw: num(d.posterW),
    ph: num(d.posterH),
    views: num(d.viewCount), // kept by api/engagement.js; a video that was never watched has none
    date: formatDate(d.createdAt),
    el: null,
  };
}

// The real shape of a video. It comes from what is already stored with it: the size of the video, or of its cover picture (a frame
// of the same video, so the same shape). Once a video has loaded in the player, the browser's own numbers replace these (see
// applyShape). Nothing is assumed: a video with no size at all is "unknown" and is simply drawn whole, whatever shape it turns out to be.
const ratioOf = (w, h) => (w > 0 && h > 0 ? w / h : 0);
const itemRatio = (item) => ratioOf(item.w, item.h) || ratioOf(item.pw, item.ph);
function shapeOf(ratio) {
  if (!ratio) return "unknown";
  return ratio < 0.9 ? "portrait" : ratio > 1.1 ? "landscape" : "square";
}

// ---------- the cards ----------
// When a card comes near the screen, fetch its play link in the background (a tiny request, not the video).
const cardObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            cardObserver.unobserve(entry.target);
            if (typeof entry.target._warm === "function") entry.target._warm();
          });
        },
        { rootMargin: "200px" }
      )
    : null;

function buildCard(item) {
  const card = el("article", "vid-item");
  card.dataset.category = item.category;
  card.dataset.shape = shapeOf(itemRatio(item));

  const media = el("button", "vid-media");
  media.type = "button";
  media.setAttribute("aria-label", `Play video: ${item.title}${item.dur ? ", " + clock(item.dur) : ""}`);
  if (item.poster) {
    // The cover picture twice: a blown-up, blurred, darkened copy that fills the whole area, and the picture itself on top, shown
    // whole (work-videos.css). A tall or a wide video gets soft colour from its own picture beside it, never bare black bars.
    const bg = el("img", "vid-bg");
    const img = el("img", "vid-thumb");
    [bg, img].forEach((node) => {
      node.src = item.poster;
      node.alt = "";
      node.loading = "lazy";
      node.decoding = "async";
    });
    // No size stored with this video? The picture knows its own shape once it has loaded.
    if (!itemRatio(item)) {
      img.addEventListener("load", () => (card.dataset.shape = shapeOf(ratioOf(img.naturalWidth, img.naturalHeight))), { once: true });
    }
    media.append(bg, img);
  }
  const badge = el("span", "vid-play");
  badge.appendChild(playIcon());
  media.appendChild(badge);
  if (item.dur) media.appendChild(el("span", "vid-dur", clock(item.dur)));
  media.addEventListener("click", () => openViewer(item));
  const warm = () => prefetchLink(item.key);
  media.addEventListener("pointerdown", warm, { passive: true });
  media.addEventListener("mouseenter", warm, { passive: true });
  media.addEventListener("focus", warm);
  if (cardObserver) cardObserver.observe(media), (media._warm = warm);

  const body = el("div", "vid-body");
  const label = el("div", "vid-label");
  const dot = el("span", "dot");
  dot.setAttribute("aria-hidden", "true");
  label.append(dot, el("span", "vid-cat", CARD_LABEL[item.category]));
  if (item.date) {
    const sep = el("span", "work-cat-sep", "·");
    sep.setAttribute("aria-hidden", "true");
    label.append(sep, el("span", "vid-date", item.date));
  }
  body.appendChild(label);
  body.appendChild(el("h3", "vid-title", item.title));
  if (item.caption) body.appendChild(el("p", "vid-caption", item.caption));
  withEngagement((m) => body.appendChild(m.buildStats(item).el)); // the like button and the view count

  card.appendChild(media);
  card.appendChild(body);
  return card;
}

// ---------- tabs + drawing ----------
// Tabs only appear once there are at least two kinds of video to switch between.
function renderTabs() {
  const present = CATEGORIES.filter((c) => items.some((it) => it.category === c));
  const show = present.length >= 2;
  if (activeFilter !== "all" && !present.includes(activeFilter)) activeFilter = "all";

  const signature = show ? present.join(",") : "";
  if (signature !== tabSignature) {
    tabSignature = signature;
    tabsEl.replaceChildren();
    if (show) {
      ["all", ...present].forEach((key) => {
        const btn = el("button", "work-filter-btn", key === "all" ? "All" : TAB_LABEL[key]);
        btn.type = "button";
        btn.dataset.videoFilter = key;
        btn.addEventListener("click", () => setFilter(key));
        tabsEl.appendChild(btn);
      });
    }
  }
  tabsEl.hidden = !show;
  tabsEl.querySelectorAll("button").forEach((btn) => {
    const on = btn.dataset.videoFilter === activeFilter;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function setFilter(key) {
  activeFilter = CATEGORIES.includes(key) ? key : "all";
  paint();
}

// What the page says when there is no list to show yet: still loading, nothing posted, or it couldn't be loaded.
function paintStatus(any) {
  if (!statusEl) return;
  statusEl.hidden = any;
  if (any) return;
  if (statusText) {
    statusText.dataset.phase = phase; // work-videos.html has a safety-net timer that only speaks while this says "loading"
    statusText.textContent =
      phase === "loading"
        ? "Loading videos…"
        : phase === "failed"
          ? "Couldn't load the videos right now. Please check your connection and try again."
          : "No videos yet — check back soon.";
  }
  if (retryBtn) retryBtn.hidden = phase !== "failed";
}

function paint() {
  renderTabs();
  items.forEach((it) => {
    it.el.hidden = activeFilter !== "all" && it.category !== activeFilter;
  });
  const any = items.length > 0;
  section.hidden = !any;
  paintStatus(any);
  moreBtn.hidden = !hasMore;
  moreBtn.disabled = loading;
  moreBtn.textContent = loading ? "Loading…" : moreFailed ? "Couldn't load more. Tap to try again" : "Show more videos";
}

// ---------- loading the list ----------
async function loadPage() {
  if (loading) return;
  loading = true;
  moreFailed = false;
  paint();
  try {
    const parts = [orderBy("order", "desc")];
    if (lastDoc) parts.push(startAfter(lastDoc));
    parts.push(limit(PAGE_SIZE + 1)); // one extra tells us whether there is a next page
    const snap = await withTimeout(getDocs(query(collection(db, "videos"), ...parts)), LOAD_TIMEOUT_MS);
    const docs = snap.docs;
    hasMore = docs.length > PAGE_SIZE;
    const shown = hasMore ? docs.slice(0, PAGE_SIZE) : docs;
    if (shown.length) lastDoc = shown[shown.length - 1];
    shown.forEach((docSnap) => {
      const item = toItem(docSnap);
      if (!item) return;
      item.el = buildCard(item);
      listEl.appendChild(item.el);
      items.push(item);
    });
    // Ask for the first two play links right away: it also opens the connection to the video server early.
    if (!loadedOnce) items.slice(0, 2).forEach((it) => prefetchLink(it.key));
    loadedOnce = true;
  } catch (error) {
    console.warn("Videos could not be loaded:", error);
    if (loadedOnce) moreFailed = true; // the first page is already on screen: say so on the button
  } finally {
    loading = false;
    paint();
  }
}

// ---------- play links ----------
// Play links are asked for ahead of the tap (when a card scrolls into view, is touched or hovered), so
// that by the time someone presses play the link is already here. A link stays valid for hours; we keep
// it for 20 minutes only, to be safe.
const LINK_TTL_MS = 20 * 60 * 1000;
const linkCache = new Map(); // key -> { url, at } | { promise }
let preconnected = false;

function preconnect(url) {
  if (preconnected) return;
  try {
    const origin = new URL(url).origin;
    for (const rel of ["preconnect", "dns-prefetch"]) {
      const link = document.createElement("link");
      link.rel = rel;
      link.href = origin;
      document.head.appendChild(link);
    }
    preconnected = true;
  } catch (e) {
    /* a hint only */
  }
}

function peekLink(key) {
  const hit = linkCache.get(key);
  return hit && hit.url && Date.now() - hit.at < LINK_TTL_MS ? hit.url : null;
}

function prefetchLink(key) {
  if (peekLink(key) || (linkCache.get(key) && linkCache.get(key).promise)) return;
  const promise = fetchPlayLink(key)
    .then((url) => {
      linkCache.set(key, { url, at: Date.now() });
      preconnect(url);
    })
    .catch(() => linkCache.delete(key)); // a failed warm-up is silent; pressing play will ask again
  linkCache.set(key, { promise });
}

async function getPlayLink(key, signal, fresh) {
  if (fresh) linkCache.delete(key);
  const ready = peekLink(key);
  if (ready) return ready;
  const pending = linkCache.get(key);
  if (pending && pending.promise) {
    await pending.promise;
    const after = peekLink(key);
    if (after) return after;
  }
  const url = await fetchPlayLink(key, signal);
  linkCache.set(key, { url, at: Date.now() });
  preconnect(url);
  return url;
}

async function fetchPlayLink(key, signal) {
  const res = await fetch(`/api/videos?action=play&key=${encodeURIComponent(key)}`, {
    signal,
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  if (!res.ok || !body || typeof body.url !== "string" || !/^https:\/\//i.test(body.url)) {
    const error = new Error((body && body.error) || `HTTP ${res.status}`);
    error.code = body && body.code;
    throw error;
  }
  return body.url;
}

function track(item) {
  try {
    if (typeof gtag === "function") gtag("event", "work_video_play", { video_category: item.category });
  } catch (e) {
    /* analytics must never get in the way of playing a video */
  }
}

// ---------- when a video won't play ----------
const AUTO_RETRIES = 2; // fresh links tried automatically before saying so
const PROBE_MS = 5000; //   how long to wait for the video server when finding out why

// Can this phone reach the video server at all? ANY answer counts, even "not allowed": the point is only to tell
// "no connection to the server" apart from "the server answered but the video still wouldn't play".
async function canReachVideoServer(url) {
  if (!url) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  if (typeof AbortController !== "function") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_MS);
  try {
    await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// What to tell the visitor. `code` is the browser's own reason (1-4, 0 if unknown); `reachable` is true / false / null (couldn't tell).
function failureMessage(code, reachable, key) {
  const tail = code ? ` (error ${code})` : "";
  if (reachable === false) return `Your device couldn't reach the video server. Check your connection and tap Try again.${tail}`;
  if (code === 2) return `The connection dropped while the video was loading. Tap Try again.${tail}`;
  if (code === 3 || code === 4) {
    const old = /\.webm$/i.test(key || "") ? " Some older iPhones can't play this type of video." : "";
    return `This video couldn't be played right now.${old} Tap Try again, or open this page in another browser.${tail}`;
  }
  return `This video couldn't load. Please tap Try again.${tail}`;
}


// ---------- the full-screen player ----------
// One "slide" per video, in the order of the cards on the page (and only the kind shown by the current tab).
// slide = { item, el, video, state, wantPlay, retried, failing, errored, played, resumeAt, loadToken, abort, ... }
let slides = [];
let activeIdx = -1;
let soundOn = true; //        flipped by the speaker button (or by the browser refusing sound before a tap)
let speedIdx = 0;
let neighboursOk = false; //  true once the current video is playing smoothly: only then are the next ones loaded
let settleTimer = 0;
let scrubbing = false;
let volumeLevel = 1; //       0 to 1: the volume slider (drawn only where there is a mouse). The speaker button mutes on top of it.
let sheetOpen = false; //     the "Read more" sheet is open (see openSheet)
let idleTimer = 0; //         counts down to the moment the text and controls fade away
let overControls = false; //  a mouse is over the playback bar, which keeps it on screen
let wokeByTap = false; //     this touch found the controls faded away: it only brings them back, it doesn't also pause the video

const visibleItems = () => items.filter((it) => activeFilter === "all" || it.category === activeFilter);
const activeSlide = () => slides[activeIdx] || null;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function durationOf(slide) {
  const v = slide && slide.video;
  return v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (slide && slide.item.dur) || 0;
}

// Sound for a <video>: the speaker button decides whether it is on (soundOn), the volume slider how loud (volumeLevel).
function applyAudio(v) {
  try {
    v.volume = volumeLevel; // some phones ignore this: their own volume keys do the job
  } catch (e) {
    /* not settable */
  }
  v.muted = !soundOn;
}

// ----- one slide -----
// What is written over the bottom of the video: a small category / date line, the title (two lines at most) and the start of the
// description, ending in "Read more", which opens the whole text in a sheet (openSheet). The likes and views go in the "rail", a
// column at the right edge (buildSlide fills it as soon as the likes / views code is here).
// The description is cut after two lines. How much fits in two lines depends on the width of the screen, so the cut is measured
// (fitCaption) once the slide is on screen and again whenever the width changes. previewText is the rough, by-characters cut that
// stands in until then. A title that is longer than its own two lines gets the "Read more" button too, so nothing is ever unreadable.
const CAPTION_LINES = 2; //       lines of description shown before "Read more"
const CAPTION_LINES_SHORT = 1; // ...on a screen with little height (a phone turned sideways, a very small phone), so the picture keeps its room
const shortScreen = () => typeof matchMedia === "function" && matchMedia("(max-height: 520px)").matches;

function previewText(text) {
  if (text.length <= CAPTION_PREVIEW + 20) return null; // short enough: show it all, no button
  let cut = text.slice(0, CAPTION_PREVIEW);
  const space = cut.search(/\s\S*$/);
  if (space > CAPTION_PREVIEW - 25) cut = cut.slice(0, space);
  return cut.trimEnd() + "… "; // the space keeps "Read more" off the text, and vanishes if "Read more" starts a new line
}

function lineHeightOf(node) {
  const style = getComputedStyle(node);
  const px = parseFloat(style.lineHeight);
  return Number.isFinite(px) ? px : (parseFloat(style.fontSize) || 16) * 1.4;
}

function buildInfo(item, onMore) {
  const stage = el("div", "vid-stage");
  const cap = el("div", "vid-cap");
  const rail = el("div", "vid-rail");

  const meta = el("p", "vid-cap-meta");
  meta.appendChild(el("span", "vid-cap-cat", CARD_LABEL[item.category]));
  if (item.date) meta.appendChild(el("span", "vid-cap-date", item.date));
  const title = el("h3", "vid-cap-title", item.title);

  const full = item.caption;
  const text = el("p", "vid-cap-text");
  const body = document.createTextNode("");
  const more = el("button", "vid-readmore", "Read more");
  more.type = "button";
  more.setAttribute("aria-haspopup", "dialog");
  text.append(body, more);

  let short = full ? previewText(full) : null; // what shows before "Read more" (null: the whole text fits, no button)
  let titleCut = false; //                        the title is longer than its lines
  let fitted = ""; //                             what `short` was last measured for: "<width>x<lines>"

  const draw = () => {
    body.nodeValue = full ? short || full : "";
    more.hidden = !(short || titleCut);
    text.hidden = !full && more.hidden;
  };

  // Finds the longest start of the description that, with "…" and the button, still fits in the lines allowed at the
  // width the text has right now (a cut at a word end, by halving, so it is a handful of measurements).
  const fit = () => {
    const width = Math.round(title.clientWidth);
    if (!width) return; // not laid out (yet)
    const lines = shortScreen() ? CAPTION_LINES_SHORT : CAPTION_LINES;
    const key = `${width}x${lines}`;
    if (key === fitted) return;
    fitted = key;
    titleCut = title.scrollHeight > title.clientHeight + 1;
    if (!full) {
      draw();
      return;
    }
    text.hidden = false;
    const limit = lineHeightOf(text) * lines + 1;
    const fits = () => text.getBoundingClientRect().height <= limit;
    more.hidden = true;
    body.nodeValue = full;
    if (fits()) {
      short = null;
      draw();
      return;
    }
    more.hidden = false;
    const ends = [];
    for (const m of full.matchAll(/\s+/g)) ends.push(m.index);
    let lo = 0;
    let hi = ends.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      body.nodeValue = full.slice(0, ends[mid]).trimEnd() + "… ";
      if (fits()) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    short = (best >= 0 ? full.slice(0, ends[best]).trimEnd() : full.slice(0, 24).trimEnd()) + "… ";
    draw();
  };

  more.addEventListener("click", (e) => {
    e.stopPropagation();
    onMore(e);
  });
  draw();
  cap.append(meta, title, text);
  stage.append(cap, rail);
  return { stage, rail, fit };
}

// Measures the text of a slide that is (about to be) on screen.
function fitCaption(s) {
  if (s && s.info) s.info.fit();
}

// The shape of a slide's video: --vr (width / height) lets the text and the likes / views hug a narrow, tall video on a wide screen
// (work-videos.css), and data-shape names it. Called with the stored size at first, and again with the browser's own once loaded.
function applyShape(s, ratio) {
  s.ratio = ratio > 0 ? Math.min(3.5, Math.max(0.3, ratio)) : 0;
  s.el.dataset.shape = shapeOf(ratio);
  if (s.ratio) s.el.style.setProperty("--vr", s.ratio.toFixed(4));
  else s.el.style.removeProperty("--vr");
  if (s === activeSlide()) syncRatio();
}

function buildSlide(item) {
  const slide = el("section", "vid-slide");
  slide.setAttribute("role", "group");
  slide.setAttribute("aria-roledescription", "slide");
  slide.dataset.state = "idle";

  // The same video's cover picture, blurred and darkened, behind it: it fills whatever the video itself doesn't cover (a tall video on
  // a wide screen, a wide one on a phone) instead of bare black. Its picture is only loaded while the slide is on screen or next to it.
  let backdrop = null;
  if (item.poster) {
    backdrop = el("img", "vid-backdrop");
    backdrop.alt = "";
    backdrop.decoding = "async";
  }
  const shade = el("div", "vid-shade"); // the soft dark fade at the bottom that keeps the text and the controls readable
  shade.setAttribute("aria-hidden", "true");

  const busy = el("div", "vid-busy");
  busy.appendChild(el("span", "vid-spin"));
  const slow = el("p", "vid-slow", "Slow connection. Still loading…");
  slow.hidden = true;
  busy.appendChild(slow);

  const center = el("span", "vid-center");
  center.setAttribute("aria-hidden", "true");
  center.appendChild(playIcon());

  const errBox = el("div", "vid-status");
  errBox.hidden = true;
  const errText = el("p");
  errText.setAttribute("role", "alert");
  const retry = el("button", "btn-accent", "Try again");
  retry.type = "button";
  errBox.append(errText, retry);

  const info = buildInfo(item, (e) => openSheet(s, e));
  slide.append(...[backdrop, shade, busy, center, info.stage, errBox].filter(Boolean));

  const s = {
    item,
    el: slide,
    video: null,
    backdrop,
    info,
    busy,
    slow,
    errBox,
    errText,
    ratio: 0, //          width / height of the video (0: not known yet)
    dead: false, //       the player was closed: the likes / views code, if it arrives late, must not touch this slide
    releaseStats: null, // stops the like / view numbers following this slide (see video-engagement-live.js)
    state: "idle", //     idle | loading | playing | paused | error
    wantPlay: false, //   we are trying to have this one playing (cleared when swiped away or paused)
    errored: false,
    failing: false, //    one explanation per failure, even if the browser reports it twice
    played: false, //     counted once for analytics
    untrack: null, //     stops the view counter watching this slide's <video> (see video-engagement-live.js)
    retried: 0,
    resumeAt: 0,
    loadToken: 0,
    abort: null,
    busyOn: false,
    busyTimer: 0,
    slowTimer: 0,
  };

  retry.addEventListener("click", () => retrySlide(s));
  slide.addEventListener("click", (e) => {
    // The error box, the likes / views column, "Read more" and buttons are not "tap the video".
    if (e.target.closest(".vid-status, .vid-rail, .vid-readmore, button")) return;
    if (wokeByTap) {
      wokeByTap = false; // the text and controls had faded away: this touch only brought them back
      return;
    }
    toggleSlide(s);
  });
  applyShape(s, itemRatio(item));
  // The like button and the view count: one set per slide, built once, in the column at the right edge.
  withEngagement((m) => {
    if (s.dead) return;
    const stats = m.buildStats(item, { player: true });
    info.rail.appendChild(stats.el);
    s.releaseStats = stats.release; // called when the player closes
  });
  return s;
}

function setState(s, state) {
  const changed = s.state !== state;
  s.state = state;
  s.el.dataset.state = state;
  if (changed && s === activeSlide()) onActiveState();
}

// The state of the video on screen changed (loading, playing, paused, failed): the play button follows it, and the text and
// controls stay on screen at every state except "playing".
function onActiveState() {
  syncPlayButton();
  const s = activeSlide();
  if (s && s.state === "playing") armIdle();
  else showControls();
}

// ----- text and controls that fade away -----
// While a video plays, everything laid over it (the top row, the text, the likes / views, the playback bar) fades out IDLE_MS
// after it starts, leaving only a thin progress line, so the picture is alone on screen. Any touch, mouse move or key press brings
// it back. It never fades while the video is paused, loading or failed, while the "Read more" sheet is open, while the progress
// bar is being dragged, or while a mouse is over the playback bar. (work-videos.css does the fading: the .is-idle class on the pop-up.)
// A video that stalls and carries on does not bring it back: only a change of state, or the visitor, does.
function autoHideAllowed() {
  const s = activeSlide();
  return viewer.open && !!s && s.state === "playing" && !s.errored && !sheetOpen && !scrubbing && !overControls;
}

function showControls() {
  clearTimeout(idleTimer);
  idleTimer = 0;
  viewer.classList.remove("is-idle");
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = 0;
  if (!autoHideAllowed()) return;
  idleTimer = setTimeout(() => {
    idleTimer = 0;
    if (!autoHideAllowed()) return;
    // Keyboard focus on something that is about to vanish moves to the video, so the keys (space, arrows) keep working.
    const focused = document.activeElement;
    if (focused && focused !== trackEl && viewer.contains(focused)) trackEl.focus({ preventScroll: true });
    viewer.classList.add("is-idle");
  }, IDLE_MS);
}

function wake() {
  showControls();
  armIdle();
}

// Spinner: waits a moment before showing (a video that starts at once never shows one) and only talks if it is slow.
function setBusy(s, on) {
  if (on === s.busyOn) return;
  s.busyOn = on;
  clearTimeout(s.busyTimer);
  clearTimeout(s.slowTimer);
  s.busyTimer = s.slowTimer = 0;
  if (!on) {
    s.el.classList.remove("is-busy");
    s.slow.hidden = true;
    return;
  }
  s.busyTimer = setTimeout(() => s.el.classList.add("is-busy"), SPINNER_DELAY_MS);
  s.slowTimer = setTimeout(() => {
    s.slow.hidden = false;
  }, SLOW_HINT_MS);
}

function showError(s, message) {
  s.errored = true;
  s.wantPlay = false;
  setBusy(s, false);
  setState(s, "error");
  s.errText.textContent = message || "This video couldn't load. Please tap Try again.";
  s.errBox.hidden = false;
}

function hideError(s) {
  s.errored = false;
  s.errBox.hidden = true;
}

// ----- the <video> of a slide -----
// Created for the slide on screen and the two next to it, destroyed when a slide is two or more away
// (which also stops its download).
function ensureVideo(s) {
  if (s.video) return s.video;
  const v = document.createElement("video");
  v.className = "vid-player";
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.setAttribute("disableremoteplayback", "");
  v.controls = false;
  v.preload = "none"; // the cover picture only, until this slide is told to load
  applyAudio(v);
  v.setAttribute("aria-label", s.item.title);
  if (s.item.poster) v.poster = s.item.poster;
  wireVideo(s, v);
  s.el.insertBefore(v, s.backdrop ? s.backdrop.nextSibling : s.el.firstChild); // above the blurred backdrop, below everything else
  s.video = v;
  // The view counter only listens: it counts a view after 5 real seconds of playback, and can't touch the video.
  withEngagement((m) => {
    if (s.video === v && !s.untrack) s.untrack = m.trackPlayback(v, s.item);
  });
  return v;
}

function destroyVideo(s) {
  const v = s.video;
  if (!v) return;
  if (s.untrack) {
    s.untrack(); // credits the seconds played so far, before the video is emptied below
    s.untrack = null;
  }
  s.loadToken += 1; // a play-link request still on its way is ignored
  if (s.abort) {
    s.abort.abort();
    s.abort = null;
  }
  s.video = null; // first, so the "emptied" events below are ignored
  try {
    v.pause();
    v.removeAttribute("src");
    v.load();
  } catch (e) {
    /* already gone */
  }
  v.remove();
}

function wireVideo(s, v) {
  const live = () => s.video === v;
  const isActive = () => live() && slides[activeIdx] === s;

  v.addEventListener("loadedmetadata", () => {
    if (!live()) return;
    v.playbackRate = SPEEDS[speedIdx];
    if (s.resumeAt > 1) {
      try {
        v.currentTime = s.resumeAt;
      } catch (e) {
        /* not seekable yet: start from the beginning */
      }
    }
    s.resumeAt = 0;
    // The browser now knows the video's real shape: use it (it replaces the stored size, or the guess when there was none).
    if (v.videoWidth && v.videoHeight) {
      applyShape(s, v.videoWidth / v.videoHeight);
      fitCaption(s); // the text hugs the video's width, so its cut may change
    }
    if (isActive()) syncControls();
  });
  v.addEventListener("durationchange", () => {
    if (isActive()) syncControls();
  });
  v.addEventListener("waiting", () => {
    if (live() && s.wantPlay && v.getAttribute("src")) setBusy(s, true);
  });
  v.addEventListener("canplay", () => {
    if (live() && !v.paused) setBusy(s, false);
  });
  v.addEventListener("playing", () => {
    if (!live() || v.paused) return; // (a "playing" that was already on its way when the video was paused is stale: ignore it)
    setBusy(s, false);
    setState(s, "playing");
    if (!s.played) {
      s.played = true;
      track(s.item);
    }
  });
  v.addEventListener("pause", () => {
    // Paused by something outside the page (a phone call, another app, a headset button): show the play button instead
    // of a frozen picture. Our own pauses clear wantPlay first, a video that has ended has its own handler below, and
    // when a video fails to load Chrome pauses it too: that is the "error" handler's business (it retries), not this.
    if (!live() || !s.wantPlay || v.ended || v.error) return;
    s.wantPlay = false;
    setBusy(s, false);
    setState(s, "paused");
  });
  v.addEventListener("canplaythrough", () => {
    if (isActive()) allowNeighbours();
  });
  v.addEventListener("timeupdate", () => {
    if (isActive() && !scrubbing) syncProgress();
  });
  v.addEventListener("progress", () => {
    if (!isActive()) return;
    syncBuffered();
    if (!neighboursOk && bufferedAhead(v) >= WARM_NEXT_AHEAD_S) allowNeighbours();
  });
  v.addEventListener("ended", () => {
    if (!live()) return;
    s.wantPlay = false;
    setBusy(s, false);
    setState(s, "paused"); // shows the play button; a tap plays it again from the start
    if (isActive()) syncProgress();
  });
  v.addEventListener("error", () => {
    if (!live() || s.failing || !v.getAttribute("src")) return; // not a real failure: the video is just being emptied
    const code = v.error ? v.error.code : 0;
    // The browser's reason is vague: a refused or expired link is reported the same way as a format it can't play
    // (code 4), so a fresh link is always tried first, and the page only explains once that has failed too.
    console.warn("A video could not be played:", code, v.error && v.error.message);
    if (!isActive()) {
      destroyVideo(s); // a video we only had warming up: drop it, it will be set up again if someone swipes to it
      return;
    }
    if (s.retried < AUTO_RETRIES) {
      s.retried += 1; // an expired, refused or dropped link: ask for a fresh one, and carry on from the same spot
      s.resumeAt = v.currentTime || 0;
      loadSource(s, { fresh: true, play: s.wantPlay });
      return;
    }
    giveUp(s, code);
  });
}

function bufferedAhead(v) {
  const t = v.currentTime || 0;
  for (let i = 0; i < v.buffered.length; i += 1) {
    if (v.buffered.start(i) <= t + 0.25 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
  }
  return 0;
}

// Gets the (usually already waiting) play link and hands it to the video. Safe to call twice: the later call wins.
async function loadSource(s, { fresh = false, play = false } = {}) {
  const v = ensureVideo(s);
  const token = (s.loadToken += 1);
  if (s.abort) s.abort.abort();
  s.abort = typeof AbortController === "function" ? new AbortController() : null;
  let url;
  try {
    url = await getPlayLink(s.item.key, s.abort ? s.abort.signal : undefined, fresh);
  } catch (error) {
    if (s.video !== v || s.loadToken !== token) return; // swiped away, or a newer request took over
    if (error && error.name === "AbortError") return;
    console.warn("Could not get a play link:", error);
    if (slides[activeIdx] === s) showError(s, null);
    return;
  }
  if (s.video !== v || s.loadToken !== token) return;
  // A retry (fresh = true) must reload even when the link is the same one (links are shared within the hour), so the
  // address is set again; otherwise it is only set when it is new, so a second call can't restart a download.
  if (fresh || v.getAttribute("src") !== url) v.src = url;
  if (play && s.wantPlay) tryPlay(s);
}

function tryPlay(s) {
  const v = s.video;
  if (!v) return;
  applyAudio(v);
  v.playbackRate = SPEEDS[speedIdx];
  const started = v.play();
  if (started && typeof started.catch === "function") {
    started.catch((e) => {
      if (s.video !== v || !s.wantPlay || !e || e.name !== "NotAllowedError") return; // anything else is reported by the video's own events
      if (!v.muted) {
        // Some phones only start a video WITH sound from a tap. Start it muted instead; the speaker button turns sound on.
        soundOn = false;
        syncControls();
        tryPlay(s);
      } else {
        s.wantPlay = false; // nothing is wrong: the big play button starts it
        setBusy(s, false);
        setState(s, "paused");
      }
    });
  }
}

function playSlide(s) {
  s.wantPlay = true;
  s.failing = false;
  hideError(s);
  const v = ensureVideo(s);
  v.preload = "auto"; // the visitor asked to watch this one: fetch the picture straight away
  setState(s, "loading");
  setBusy(s, true);
  if (v.getAttribute("src")) tryPlay(s);
  else loadSource(s, { play: true });
}

function pauseSlide(s) {
  s.wantPlay = false;
  setBusy(s, false);
  if (s.video) {
    try {
      s.video.pause();
      // Swiped away from: stop reading ahead. A paused video that may "preload" keeps downloading in the background, which
      // takes the connection from the video now on screen. It carries on again if somebody swipes back to it (playSlide).
      s.video.preload = "metadata";
    } catch (e) {
      /* nothing to pause */
    }
  }
  if (!s.errored) setState(s, "idle");
}

// A tap on the video.
function toggleSlide(s) {
  const v = s.video;
  if (!v || s.errored) return;
  if (!v.getAttribute("src")) {
    playSlide(s);
  } else if (v.paused) {
    s.wantPlay = true;
    setState(s, "loading");
    tryPlay(s);
  } else {
    s.wantPlay = false;
    v.pause();
    setBusy(s, false);
    setState(s, "paused");
  }
  if (s === activeSlide()) syncControls();
}

function retrySlide(s) {
  s.retried = 0;
  s.failing = false;
  s.resumeAt = s.video ? s.video.currentTime || 0 : 0;
  s.wantPlay = true;
  hideError(s);
  setState(s, "loading");
  setBusy(s, true);
  loadSource(s, { fresh: true, play: true });
}

async function giveUp(s, code) {
  const v = s.video;
  if (!v) return;
  s.failing = true;
  const reachable = await canReachVideoServer(v.getAttribute("src"));
  if (s.video !== v) return; // closed or replaced while finding out
  showError(s, failureMessage(code, reachable, s.item.key));
}

// ----- which videos hold a <video> right now -----
function showBackdrop(s, on) {
  const img = s.backdrop;
  if (!img) return;
  if (on) {
    if (!img.getAttribute("src")) img.src = s.item.poster;
  } else if (img.getAttribute("src")) {
    img.removeAttribute("src"); // a long list doesn't keep a decoded picture for every slide
  }
}

function updateWindow(idx) {
  slides.forEach((s, i) => {
    const d = Math.abs(i - idx);
    if (d <= 2) prefetchLink(s.item.key); // a tiny request: makes a swipe start without waiting for a link
    if (d <= 1) ensureVideo(s); //           cover picture only, no download yet
    if (d <= 1) fitCaption(s); //            the description's cut depends on the screen's width
    else if (s.video) destroyVideo(s);
    showBackdrop(s, d <= 1); //              the blurred cover picture behind the video: only held for the slides on or next to the screen
  });
  if (!neighboursOk) return;
  [idx + 1, idx - 1].forEach((i) => {
    const s = slides[i];
    if (!s || s.errored) return;
    const v = ensureVideo(s);
    if (v.getAttribute("src")) return;
    v.preload = i > idx ? "auto" : "metadata"; // the next one gets a head start; the one behind only its first bytes
    loadSource(s);
  });
}

// The current video is playing smoothly, so it is safe to start warming the next one without slowing it down.
function allowNeighbours() {
  if (neighboursOk || activeIdx < 0) return;
  neighboursOk = true;
  updateWindow(activeIdx);
}

function activate(idx) {
  const next = slides[idx];
  if (!next) return;
  const prev = activeSlide();
  if (prev && prev !== next) pauseSlide(prev);
  activeIdx = idx;
  neighboursOk = false;
  updateWindow(idx);
  withEngagement((m) => m.loadStats(next.item.id)); // the like count for the video now on screen
  playSlide(next);
  const v = next.video;
  if (v && v.readyState >= 4) allowNeighbours(); // it was warmed up as a neighbour and is ready: warm the next one too
  syncControls();
  maybeLoadMore();
}

// ----- swiping -----
function onTrackScroll() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, SETTLE_MS);
}

function settle() {
  const w = trackEl.clientWidth;
  if (!w || !slides.length) return;
  const idx = Math.max(0, Math.min(slides.length - 1, Math.round(trackEl.scrollLeft / w)));
  if (idx !== activeIdx) activate(idx);
}

function goTo(idx) {
  const w = trackEl.clientWidth;
  if (!w) return;
  const target = Math.max(0, Math.min(slides.length - 1, idx));
  trackEl.scrollTo({ left: target * w, behavior: reducedMotion() ? "auto" : "smooth" });
}

function step(delta) {
  const w = trackEl.clientWidth || 1;
  goTo(Math.round(trackEl.scrollLeft / w) + delta); // from where the row is now, so quick repeated presses keep moving
}

// When the visitor nears the last video of what has loaded, the next six are fetched and appended.
function maybeLoadMore() {
  if (!viewer.open || !hasMore || loading || moreFailed || activeIdx < slides.length - 2) return;
  loadPage().then(extendSlides);
}

function extendSlides() {
  if (!viewer.open || activeIdx < 0) return;
  const have = new Set(slides.map((s) => s.item));
  visibleItems()
    .filter((it) => !have.has(it))
    .forEach((it) => {
      const s = buildSlide(it);
      slides.push(s);
      trackEl.appendChild(s.el);
    });
  labelSlides();
  syncControls();
  updateWindow(activeIdx);
}

function labelSlides() {
  slides.forEach((s, i) => s.el.setAttribute("aria-label", `Video ${i + 1} of ${slides.length}`));
}

// ----- the bar at the bottom (always about the slide on screen) -----
function syncControls() {
  const s = activeSlide();
  if (!s) return;
  const v = s.video;
  totalEl.textContent = clock(durationOf(s));
  seekEl.disabled = !(v && v.readyState >= 1);
  speedBtn.textContent = `${SPEEDS[speedIdx].toFixed(1)}x`;
  speedBtn.setAttribute("aria-label", `Playback speed ${SPEEDS[speedIdx]}x. Tap to change.`);
  muteBtn.dataset.muted = soundOn ? "0" : "1";
  muteBtn.setAttribute("aria-label", soundOn ? "Mute" : "Turn sound on");
  countEl.textContent = slides.length > 1 ? `${activeIdx + 1} / ${slides.length}` : "";
  prevBtn.disabled = activeIdx <= 0;
  nextBtn.disabled = activeIdx >= slides.length - 1;
  syncPlayButton();
  syncVolume();
  syncRatio();
  syncProgress();
  syncBuffered();
}

// The play / pause button shows what a tap will do: pause while the video is playing (or on its way to playing), play otherwise.
function syncPlayButton() {
  const s = activeSlide();
  if (!playBtn || !s) return;
  const on = !!s.wantPlay;
  playBtn.dataset.playing = on ? "1" : "0";
  playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
  playBtn.disabled = s.errored; // a video that failed has the "Try again" button instead
}

function syncVolume() {
  if (!volumeEl) return;
  const shown = soundOn ? Math.round(volumeLevel * 100) : 0;
  volumeEl.value = String(shown);
  volumeEl.style.setProperty("--p", `${shown}%`);
}

// The controls at the bottom are as wide as the video on screen (a tall video on a wide screen is a narrow column).
function syncRatio() {
  const s = activeSlide();
  if (s && s.ratio) viewer.style.setProperty("--vr", s.ratio.toFixed(4));
  else viewer.style.removeProperty("--vr");
}

function syncProgress() {
  const s = activeSlide();
  const v = s && s.video;
  const dur = durationOf(s);
  const t = v ? v.currentTime || 0 : 0;
  const p = dur ? Math.min(1, t / dur) : 0;
  seekEl.value = String(Math.round(p * 1000));
  seekEl.style.setProperty("--p", `${(p * 100).toFixed(2)}%`);
  if (miniEl) miniEl.style.setProperty("--p", `${(p * 100).toFixed(2)}%`); // the thin line that stays when the controls have faded
  timeEl.textContent = clock(t);
  seekEl.setAttribute("aria-valuetext", dur ? `${clock(t)} of ${clock(dur)}` : clock(t));
}

function syncBuffered() {
  const s = activeSlide();
  const v = s && s.video;
  const dur = durationOf(s);
  const end = v && dur ? (v.currentTime || 0) + bufferedAhead(v) : 0;
  seekEl.style.setProperty("--b", `${(dur ? Math.min(1, end / dur) * 100 : 0).toFixed(2)}%`);
}

function seekTo() {
  const s = activeSlide();
  const v = s && s.video;
  if (!v || v.readyState < 1) return;
  const dur = durationOf(s);
  if (!dur) return;
  try {
    v.currentTime = (Number(seekEl.value) / 1000) * dur;
  } catch (e) {
    /* not seekable yet */
  }
}

// ----- "Read more": the sheet with the whole title and description -----
// It slides up over the dimmed video. The video is paused while it is open and carries on when it closes, if it was playing (a
// video that was already paused stays paused). Everything behind it is made inert, so a keyboard or a screen reader stays inside
// the sheet. It closes with its X, a tap on the dimmed video, the Esc key / back gesture, or by pulling the handle down.
let sheetSlide = null; //   the slide the sheet is about
let sheetResume = false; // the video was playing (or on its way to playing) when the sheet opened
let sheetOpener = null; //  the "Read more" button to give focus back to, when it was a keyboard that opened the sheet
let sheetTimer = 0;
let sheetDrag = null;

function setBehindInert(on) {
  [trackEl, topEl, prevBtn, nextBtn, controlsEl].forEach((node) => {
    if (!node) return;
    if (on) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  });
}

function openSheet(s, e) {
  if (!sheetEl || !sheetPanel || sheetOpen || s !== activeSlide()) return;
  sheetOpen = true;
  sheetSlide = s;
  sheetOpener = e && e.detail === 0 ? document.activeElement : null; // a click made with the keyboard has detail 0
  sheetResume = !!s.wantPlay;
  clearTimeout(sheetTimer);
  sheetTimer = 0;
  if (!s.errored) {
    // Our own pause (wantPlay is cleared first), so the video's "pause" event is not mistaken for another app pausing it.
    s.wantPlay = false;
    setBusy(s, false);
    if (s.video) {
      try {
        s.video.pause();
      } catch (err) {
        /* nothing to pause */
      }
    }
    if (sheetResume) setState(s, "paused");
  }
  if (sheetMeta) {
    sheetMeta.replaceChildren(el("span", "vid-cap-cat", CARD_LABEL[s.item.category]));
    if (s.item.date) sheetMeta.appendChild(el("span", "vid-cap-date", s.item.date));
  }
  if (sheetTitle) sheetTitle.textContent = s.item.title;
  if (sheetText) {
    sheetText.textContent = s.item.caption;
    sheetText.hidden = !s.item.caption;
  }
  if (sheetScroll) sheetScroll.scrollTop = 0;
  sheetPanel.style.transform = "";
  showControls();
  viewer.classList.add("has-sheet");
  setBehindInert(true);
  sheetEl.hidden = false;
  void sheetEl.offsetWidth; // lets the slide-up start from below the screen
  sheetEl.classList.add("is-open");
  if (sheetCloseBtn) sheetCloseBtn.focus({ preventScroll: true });
}

// resume: carry on playing if it was playing before. instant: no slide-away (the whole player is closing).
function closeSheet({ resume = true, instant = false } = {}) {
  if (!sheetOpen) return;
  const s = sheetSlide;
  const wasPlaying = sheetResume;
  const back = sheetOpener;
  sheetOpen = false;
  sheetSlide = null;
  sheetResume = false;
  sheetOpener = null;
  sheetDrag = null;
  setBehindInert(false);
  viewer.classList.remove("has-sheet");
  sheetEl.classList.remove("is-open");
  const done = () => {
    sheetTimer = 0;
    sheetEl.hidden = true;
    if (sheetPanel) sheetPanel.style.transform = "";
  };
  clearTimeout(sheetTimer);
  if (instant || reducedMotion()) done();
  else sheetTimer = setTimeout(done, SHEET_MS);
  // Back to what it was doing: playing carries on from the same spot, paused stays paused.
  if (resume && wasPlaying && s && s === activeSlide() && viewer.open && !s.errored) playSlide(s);
  if (viewer.open) (back && back.isConnected ? back : trackEl).focus({ preventScroll: true });
}

// ----- full screen (where the browser can do it) -----
function exitFullscreen() {
  if (!document.fullscreenElement || typeof document.exitFullscreen !== "function") return;
  try {
    const done = document.exitFullscreen();
    if (done && typeof done.catch === "function") done.catch(() => {});
  } catch (e) {
    /* already out */
  }
}

// ----- opening and closing -----
function openViewer(item) {
  const list = visibleItems();
  const idx = Math.max(0, list.indexOf(item));
  slides.forEach(destroyVideo);
  slides = list.map(buildSlide);
  trackEl.replaceChildren(...slides.map((s) => s.el));
  labelSlides();
  activeIdx = -1;
  viewer.classList.remove("is-idle", "has-sheet");
  showControls();

  if (!viewer.open) {
    if (typeof viewer.showModal === "function") viewer.showModal();
    else viewer.setAttribute("open", "");
  }
  document.documentElement.classList.add("vid-open"); // stops the page behind from scrolling (see work-videos.css)
  trackEl.scrollLeft = idx * trackEl.clientWidth; // start on the tapped video, no animation
  activate(idx); // the play link is normally already here (asked for when the card scrolled into view or was touched)
}

// Stops every download and puts the page back as it was.
function cleanup() {
  clearTimeout(settleTimer);
  closeSheet({ resume: false, instant: true });
  showControls();
  slides.forEach((s) => {
    s.dead = true;
    setBusy(s, false);
    destroyVideo(s);
    if (typeof s.releaseStats === "function") s.releaseStats();
  });
  slides = [];
  activeIdx = -1;
  neighboursOk = false;
  scrubbing = false;
  overControls = false;
  wokeByTap = false;
  trackEl.replaceChildren();
  viewer.classList.remove("is-idle", "has-sheet");
  viewer.style.removeProperty("--vr");
  exitFullscreen();
  document.documentElement.classList.remove("vid-open");
}

function closeViewer() {
  if (typeof viewer.close === "function") {
    if (viewer.open) viewer.close();
  } else {
    viewer.removeAttribute("open");
  }
  cleanup();
}

function wireViewer() {
  viewer.addEventListener("close", cleanup); // Esc key, the close button, or the Android back gesture
  viewer.addEventListener("cancel", (e) => {
    if (!sheetOpen) return;
    e.preventDefault(); // Esc or the back gesture closes the "Read more" sheet first, not the whole player
    closeSheet();
  });
  closeBtn.addEventListener("click", closeViewer);

  trackEl.addEventListener("scroll", onTrackScroll, { passive: true });
  // After a mouse / finger click on a control, the keyboard shortcuts (Space, arrows) go back to the video; after a
  // keyboard press (e.detail is 0) focus stays where it is, so keyboard users keep their place.
  const backToVideo = (e) => {
    if (e.detail > 0) trackEl.focus({ preventScroll: true });
  };
  prevBtn.addEventListener("click", (e) => {
    step(-1);
    backToVideo(e);
  });
  nextBtn.addEventListener("click", (e) => {
    step(1);
    backToVideo(e);
  });
  window.addEventListener("resize", () => {
    // a turned phone or resized window: stay on the same video instead of landing between two
    if (viewer.open && activeIdx >= 0) trackEl.scrollLeft = activeIdx * trackEl.clientWidth;
    slides.forEach((s, i) => {
      if (Math.abs(i - activeIdx) <= 1) fitCaption(s);
    });
  });

  // The text and controls end just above the playback bar, whatever height it has (one row or two, with or without a gesture
  // bar under it): its real height is measured and handed to the stylesheet.
  if (controlsEl && typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      const h = Math.round(controlsEl.getBoundingClientRect().height);
      if (h > 0) viewer.style.setProperty("--ctl-h", `${h}px`);
    }).observe(controlsEl);
  }

  // ----- text and controls that have faded away come back at the visitor's next touch, mouse move or key press -----
  // The touch is noted before anything else happens: a touch that finds them gone only brings them back (the click handler in
  // buildSlide checks wokeByTap), so waking the screen never also pauses the video.
  viewer.addEventListener(
    "pointerdown",
    () => {
      wokeByTap = viewer.classList.contains("is-idle");
      wake();
    },
    true
  );
  let lastMove = 0;
  viewer.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse" || Date.now() - lastMove < 250) return;
      lastMove = Date.now();
      wake();
    },
    { passive: true }
  );
  if (controlsEl) {
    // a mouse resting on the playback bar keeps it on screen (a finger can't "rest": touches are handled above)
    controlsEl.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      overControls = true;
      showControls();
    });
    controlsEl.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      overControls = false;
      armIdle();
    });
  }

  // ----- the playback bar -----
  if (playBtn) {
    playBtn.addEventListener("click", (e) => {
      const s = activeSlide();
      if (s) toggleSlide(s);
      backToVideo(e);
    });
  }
  speedBtn.addEventListener("click", (e) => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    slides.forEach((s) => {
      if (s.video) s.video.playbackRate = SPEEDS[speedIdx];
    });
    syncControls();
    backToVideo(e);
  });
  muteBtn.addEventListener("click", (e) => {
    soundOn = !soundOn;
    if (soundOn && volumeLevel === 0) volumeLevel = 1; // sound back on after the slider was pulled right down
    slides.forEach((s) => {
      if (s.video) applyAudio(s.video);
    });
    syncControls();
    backToVideo(e);
  });
  if (volumeEl) {
    volumeEl.addEventListener("input", () => {
      volumeLevel = Number(volumeEl.value) / 100;
      soundOn = volumeLevel > 0;
      slides.forEach((s) => {
        if (s.video) applyAudio(s.video);
      });
      syncControls();
    });
  }
  // Full screen: only offered where the browser can do it (an iPhone can't, and there the player already fills the screen).
  // The page itself goes full screen, not the <dialog>: browsers refuse full screen for a dialog element. The open player
  // sits in the top layer, so it simply fills the screen on top of the page.
  if (fsBtn) {
    const root = document.documentElement;
    const canFullscreen = !!(document.fullscreenEnabled && typeof root.requestFullscreen === "function");
    fsBtn.hidden = !canFullscreen;
    if (canFullscreen) {
      fsBtn.addEventListener("click", (e) => {
        if (document.fullscreenElement) {
          exitFullscreen();
        } else {
          try {
            const asked = root.requestFullscreen();
            if (asked && typeof asked.catch === "function") asked.catch(() => {});
          } catch (err) {
            /* refused: nothing to do */
          }
        }
        backToVideo(e);
      });
      document.addEventListener("fullscreenchange", () => {
        const on = !!document.fullscreenElement;
        fsBtn.dataset.fs = on ? "1" : "0";
        fsBtn.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
      });
    }
  }

  // the progress bar: the time follows the finger while dragging, the video jumps when the finger lifts
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    armIdle(); // the controls may fade away again after the next quiet three seconds
  };
  seekEl.addEventListener("pointerdown", () => {
    scrubbing = true;
    showControls();
  });
  seekEl.addEventListener("input", () => {
    const dur = durationOf(activeSlide());
    const t = (Number(seekEl.value) / 1000) * dur;
    timeEl.textContent = clock(t);
    seekEl.style.setProperty("--p", `${Number(seekEl.value) / 10}%`);
  });
  seekEl.addEventListener("change", () => {
    seekTo();
    endScrub();
  });
  ["pointerup", "pointercancel", "blur"].forEach((type) => seekEl.addEventListener(type, endScrub));

  // ----- the "Read more" sheet -----
  if (sheetEl && sheetPanel) {
    if (sheetCloseBtn) sheetCloseBtn.addEventListener("click", () => closeSheet());
    if (sheetScrim) sheetScrim.addEventListener("click", () => closeSheet());
    if (sheetScroll) sheetScroll.tabIndex = 0; // so a keyboard can scroll a long description
    if (sheetHead) {
      // pull the handle down to close it
      sheetHead.addEventListener("pointerdown", (e) => {
        if (!sheetOpen || (e.target.closest && e.target.closest("button"))) return;
        sheetDrag = { id: e.pointerId, y: e.clientY, dy: 0 };
        sheetPanel.style.transition = "none"; // follows the finger exactly
        try {
          sheetHead.setPointerCapture(e.pointerId);
        } catch (err) {
          /* the drag still works without capture, only less forgivingly */
        }
      });
      sheetHead.addEventListener("pointermove", (e) => {
        if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
        sheetDrag.dy = Math.max(0, e.clientY - sheetDrag.y);
        sheetPanel.style.transform = `translateY(${sheetDrag.dy}px)`;
      });
      const endDrag = (e) => {
        if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
        const far = sheetDrag.dy > 90;
        sheetDrag = null;
        sheetPanel.style.transition = ""; // the stylesheet's own slide again
        if (far) {
          sheetPanel.style.transform = "translateY(100%)"; // carries on down from where the finger let go
          closeSheet();
        } else {
          sheetPanel.style.transform = ""; // springs back
        }
      };
      sheetHead.addEventListener("pointerup", endDrag);
      sheetHead.addEventListener("pointercancel", endDrag);
    }
  }

  viewer.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    wake(); // any key brings the faded text and controls back
    if (sheetOpen) return; // the sheet is on top: only its own buttons work, and Esc closes it (the "cancel" listener above)
    const onButton = e.target && e.target.closest && e.target.closest("button");
    const onSeek = e.target === seekEl || e.target === volumeEl; // the progress bar and the volume slider use the arrow keys themselves
    if (e.key === "ArrowRight" && !onSeek) {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft" && !onSeek) {
      e.preventDefault();
      step(-1);
    } else if ((e.key === " " || e.key === "k" || e.key === "K") && !onButton) {
      e.preventDefault();
      const s = activeSlide();
      if (s) toggleSlide(s);
    } else if (e.key === "m" || e.key === "M") {
      muteBtn.click();
    }
  });
}

// ---------- start ----------
// The first page of the list: tries, waits and tries again (twice more) before saying it couldn't load.
async function loadFirstPage() {
  phase = "loading";
  paint();
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length && !loadedOnce; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    await loadPage();
  }
  phase = loadedOnce ? "ready" : "failed";
  paint();
}

function start() {
  wireViewer();
  moreBtn.addEventListener("click", () => loadPage());
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      if (phase === "failed") loadFirstPage();
    });
  }
  loadFirstPage();
}

// If the page is an older copy without the video list or the player, there is nothing to do.
if (
  section && listEl && tabsEl && moreBtn && viewer && trackEl && closeBtn && countEl && prevBtn && nextBtn &&
  seekEl && timeEl && totalEl && speedBtn && muteBtn
) {
  start();
}
