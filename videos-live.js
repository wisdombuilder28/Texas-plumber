// videos-live.js
// Shows the videos on the Recent Work page (work.html).
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
// Each card shows only the small cover picture saved with the video, so the page costs almost nothing
// until somebody presses play. Videos load six at a time; "Show more videos" fetches the next six (and the
// player fetches them by itself when you swipe near the end).
//
// Everything on screen is built with createElement / textContent, so a title or description is never
// read as HTML. If the list can't be loaded (offline, rules not published yet) or is empty, the whole
// video section simply stays hidden and the rest of the page looks exactly as it did before.
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  orderBy,
  limit,
  startAfter,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

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

// KEEP IN SYNC with admin/js/videos-admin.js (CATEGORIES) and firestore.rules.
const CATEGORIES = ["showcase", "before-after", "testimonial"];
const CARD_LABEL = { showcase: "Job showcase", "before-after": "Before & after", testimonial: "Testimonial" };
const TAB_LABEL = { showcase: "Job showcases", "before-after": "Before & afters", testimonial: "Testimonials" };

const $ = (id) => document.getElementById(id);
const section = $("videos");
const listEl = $("video-list");
const tabsEl = $("video-filter");
const moreBtn = $("video-more");
const jumpEl = $("video-jump");
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

const items = []; // { id, key, title, caption, category, poster, dur, w, h, pw, ph, date, el }
let lastDoc = null; // the last video shown so far: the next page starts after it
let hasMore = false;
let loading = false;
let loadedOnce = false;
let moreFailed = false;
let activeFilter = "all";
let tabSignature = null;

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
    date: formatDate(d.createdAt),
    el: null,
  };
}

function isPortrait(item) {
  const ratio = item.pw && item.ph ? item.pw / item.ph : item.w && item.h ? item.w / item.h : 1.78;
  return ratio < 0.95;
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
  if (isPortrait(item)) card.dataset.shape = "portrait";

  const media = el("button", "vid-media");
  media.type = "button";
  media.setAttribute("aria-label", `Play video: ${item.title}${item.dur ? ", " + clock(item.dur) : ""}`);
  if (item.poster) {
    const img = el("img");
    img.src = item.poster;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    media.appendChild(img);
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
  label.appendChild(dot);
  label.appendChild(el("span", "vid-cat", [CARD_LABEL[item.category], item.date].filter(Boolean).join(" · ")));
  body.appendChild(label);
  body.appendChild(el("h3", "vid-title", item.title));
  if (item.caption) body.appendChild(el("p", "vid-caption", item.caption));

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

function paint() {
  renderTabs();
  items.forEach((it) => {
    it.el.hidden = activeFilter !== "all" && it.category !== activeFilter;
  });
  const any = items.length > 0;
  section.hidden = !any;
  if (jumpEl) jumpEl.hidden = !any;
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

const visibleItems = () => items.filter((it) => activeFilter === "all" || it.category === activeFilter);
const activeSlide = () => slides[activeIdx] || null;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function durationOf(slide) {
  const v = slide && slide.video;
  return v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (slide && slide.item.dur) || 0;
}

// ----- one slide -----
// The description is cut after a few words with "Read more", like a WhatsApp status; the full text opens in place.
function previewText(text) {
  if (text.length <= CAPTION_PREVIEW + 20) return null; // short enough: show it all, no button
  let cut = text.slice(0, CAPTION_PREVIEW);
  const space = cut.search(/\s\S*$/);
  if (space > CAPTION_PREVIEW - 25) cut = cut.slice(0, space);
  return cut.trimEnd() + "… "; // the space keeps "Read more" off the text, and vanishes if "Read more" starts a new line
}

function buildCaption(item) {
  const cap = el("div", "vid-cap");
  const inner = el("div", "vid-cap-scroll");
  const meta = [CARD_LABEL[item.category], item.date].filter(Boolean).join(" · ");
  if (meta) inner.appendChild(el("p", "vid-cap-meta", meta));
  inner.appendChild(el("h3", "vid-cap-title", item.title));
  if (item.caption) {
    const text = el("p", "vid-cap-text");
    const short = previewText(item.caption);
    if (!short) {
      text.textContent = item.caption;
    } else {
      const body = document.createTextNode(short);
      const more = el("button", "vid-readmore", "Read more");
      more.type = "button";
      more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = !cap.classList.contains("is-open");
        cap.classList.toggle("is-open", open);
        body.nodeValue = open ? item.caption : short;
        more.textContent = open ? "Show less" : "Read more";
        more.setAttribute("aria-expanded", open ? "true" : "false");
        if (!open) inner.scrollTop = 0;
      });
      text.append(body, more);
    }
    inner.appendChild(text);
  }
  cap.appendChild(inner);
  return cap;
}

function buildSlide(item) {
  const slide = el("section", "vid-slide");
  slide.setAttribute("role", "group");
  slide.setAttribute("aria-roledescription", "slide");
  slide.dataset.state = "idle";

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

  slide.append(busy, center, buildCaption(item), errBox);

  const s = {
    item,
    el: slide,
    video: null,
    busy,
    slow,
    errBox,
    errText,
    state: "idle", //     idle | loading | playing | paused | error
    wantPlay: false, //   we are trying to have this one playing (cleared when swiped away or paused)
    errored: false,
    failing: false, //    one explanation per failure, even if the browser reports it twice
    played: false, //     counted once for analytics
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
    if (e.target.closest(".vid-cap, .vid-status, button")) return; // text, the error box and buttons are not "tap the video"
    toggleSlide(s);
  });
  return s;
}

function setState(s, state) {
  s.state = state;
  s.el.dataset.state = state;
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
  v.muted = !soundOn;
  v.setAttribute("aria-label", s.item.title);
  if (s.item.poster) v.poster = s.item.poster;
  wireVideo(s, v);
  s.el.insertBefore(v, s.el.firstChild);
  s.video = v;
  return v;
}

function destroyVideo(s) {
  const v = s.video;
  if (!v) return;
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
    if (!live()) return;
    setBusy(s, false);
    setState(s, "playing");
    if (!s.played) {
      s.played = true;
      track(s.item);
    }
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
  v.muted = !soundOn;
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
function updateWindow(idx) {
  slides.forEach((s, i) => {
    const d = Math.abs(i - idx);
    if (d <= 2) prefetchLink(s.item.key); // a tiny request: makes a swipe start without waiting for a link
    if (d <= 1) ensureVideo(s); //           cover picture only, no download yet
    else if (s.video) destroyVideo(s);
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
  syncProgress();
  syncBuffered();
}

function syncProgress() {
  const s = activeSlide();
  const v = s && s.video;
  const dur = durationOf(s);
  const t = v ? v.currentTime || 0 : 0;
  const p = dur ? Math.min(1, t / dur) : 0;
  seekEl.value = String(Math.round(p * 1000));
  seekEl.style.setProperty("--p", `${(p * 100).toFixed(2)}%`);
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

// ----- opening and closing -----
function openViewer(item) {
  const list = visibleItems();
  const idx = Math.max(0, list.indexOf(item));
  slides.forEach(destroyVideo);
  slides = list.map(buildSlide);
  trackEl.replaceChildren(...slides.map((s) => s.el));
  labelSlides();
  activeIdx = -1;

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
  slides.forEach((s) => {
    setBusy(s, false);
    destroyVideo(s);
  });
  slides = [];
  activeIdx = -1;
  neighboursOk = false;
  scrubbing = false;
  trackEl.replaceChildren();
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
  });

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
    slides.forEach((s) => {
      if (s.video) s.video.muted = !soundOn;
    });
    syncControls();
    backToVideo(e);
  });

  // the progress bar: the time follows the finger while dragging, the video jumps when the finger lifts
  seekEl.addEventListener("pointerdown", () => {
    scrubbing = true;
  });
  seekEl.addEventListener("input", () => {
    const dur = durationOf(activeSlide());
    const t = (Number(seekEl.value) / 1000) * dur;
    timeEl.textContent = clock(t);
    seekEl.style.setProperty("--p", `${Number(seekEl.value) / 10}%`);
  });
  seekEl.addEventListener("change", () => {
    seekTo();
    scrubbing = false;
  });
  ["pointerup", "pointercancel", "blur"].forEach((type) =>
    seekEl.addEventListener(type, () => {
      scrubbing = false;
    })
  );

  viewer.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const onButton = e.target && e.target.closest && e.target.closest("button");
    const onSeek = e.target === seekEl; // the progress bar uses the arrow keys itself
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
async function start() {
  wireViewer();
  moreBtn.addEventListener("click", () => loadPage());
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length && !loadedOnce; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    await loadPage();
  }
}

// If work.html is an older copy without the video section, there is nothing to do.
if (
  section && listEl && tabsEl && moreBtn && viewer && trackEl && closeBtn && countEl && prevBtn && nextBtn &&
  seekEl && timeEl && totalEl && speedBtn && muteBtn
) {
  start();
}
