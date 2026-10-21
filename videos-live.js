// videos-live.js
// Shows the videos on the Recent Work page (work.html).
//
// The list comes from the `videos` collection in Firestore (written by the admin Videos page).
// The video files themselves sit in a private storage bucket, so this page never holds a permanent
// address for one: pressing play asks /api/videos for a link that works for a few hours, then plays it.
//
// Each card shows only the small cover picture saved with the video, so the page costs almost nothing
// until somebody presses play. Videos load six at a time; "Show more videos" fetches the next six.
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
const player = $("vid-player");
const statusEl = $("vid-status");
const statusText = $("vid-status-text");
const retryBtn = $("vid-retry");
const closeBtn = $("vid-close");
const vMeta = $("vid-meta");
const vTitle = $("vid-title");
const vCaption = $("vid-caption");

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
    loadedOnce = true;
  } catch (error) {
    console.warn("Videos could not be loaded:", error);
    if (loadedOnce) moreFailed = true; // the first page is already on screen: say so on the button
  } finally {
    loading = false;
    paint();
  }
}

// ---------- the player pop-up ----------
let current = null; // the video being shown: { item, token, retried, played, abort }
let openToken = 0;

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

function setStatus(kind, message) {
  if (!kind) {
    statusEl.hidden = true;
    return;
  }
  const failed = kind === "error";
  statusEl.hidden = false;
  statusEl.dataset.kind = kind;
  statusText.textContent = failed
    ? message || "This video couldn't load. Please try again."
    : kind === "buffering"
      ? "Buffering…"
      : "Loading video…";
  retryBtn.hidden = !failed;
}

function track(item) {
  try {
    if (typeof gtag === "function") gtag("event", "work_video_play", { video_category: item.category });
  } catch (e) {
    /* analytics must never get in the way of playing a video */
  }
}

async function startPlayback(resumeAt, fresh) {
  const cur = current;
  if (!cur) return;
  const token = cur.token;
  if (cur.abort) cur.abort.abort();
  cur.abort = typeof AbortController === "function" ? new AbortController() : null;
  setStatus("loading");
  let url;
  try {
    url = await getPlayLink(cur.item.key, cur.abort ? cur.abort.signal : undefined, fresh);
  } catch (error) {
    if (!current || current.token !== token) return; // closed or replaced while waiting
    if (error && error.name === "AbortError") return;
    console.warn("Could not get a play link:", error);
    setStatus("error");
    return;
  }
  if (!current || current.token !== token) return;
  if (resumeAt > 1) {
    player.addEventListener(
      "loadedmetadata",
      () => {
        try {
          player.currentTime = resumeAt;
        } catch (e) {
          /* not seekable yet: start from the beginning */
        }
      },
      { once: true }
    );
  }
  player.preload = "auto"; // start fetching the picture immediately; the user already asked to watch
  player.src = url;
  const started = player.play();
  if (started && typeof started.catch === "function") started.catch(() => {}); // blocked autoplay: the play button on the controls still works
}

function openViewer(item) {
  const token = ++openToken;
  if (current && current.abort) current.abort.abort();
  current = { item, token, retried: 0, played: false, abort: null };

  vMeta.textContent = [CARD_LABEL[item.category], item.date].filter(Boolean).join(" · ");
  vTitle.textContent = item.title;
  vCaption.textContent = item.caption;
  vCaption.hidden = !item.caption;
  const ratio = item.w && item.h ? item.w / item.h : item.pw && item.ph ? item.pw / item.ph : 16 / 9;
  viewer.style.setProperty("--ar", String(Math.min(2.5, Math.max(0.4, Math.round(ratio * 1000) / 1000))));

  player.pause();
  player.removeAttribute("src");
  if (item.poster) player.setAttribute("poster", item.poster);
  else player.removeAttribute("poster");
  player.load();
  setStatus("loading");

  if (!viewer.open) {
    if (typeof viewer.showModal === "function") viewer.showModal();
    else viewer.setAttribute("open", "");
  }
  document.documentElement.classList.add("vid-open"); // stops the page behind from scrolling (see work-videos.css)
  startPlayback(0);
}

// Stops the download, forgets the link and puts the page back as it was.
function cleanup() {
  if (!current && !player.getAttribute("src")) {
    document.documentElement.classList.remove("vid-open");
    return;
  }
  openToken += 1;
  if (current && current.abort) current.abort.abort();
  current = null;
  player.pause();
  player.removeAttribute("src");
  player.removeAttribute("poster");
  player.load();
  setStatus(null);
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
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) closeViewer(); // a tap on the dark area around the video
  });
  retryBtn.addEventListener("click", () => {
    if (!current) return;
    current.retried = 0;
    startPlayback(player.currentTime || 0, true);
  });
  player.addEventListener("loadeddata", () => {
    if (current) setStatus(null);
  });
  player.addEventListener("playing", () => {
    if (!current) return;
    setStatus(null);
    if (!current.played) {
      current.played = true;
      track(current.item);
    }
  });
  player.addEventListener("error", () => {
    const cur = current;
    if (!cur || !player.getAttribute("src")) return; // not a real failure: the viewer is just being emptied
    const code = player.error ? player.error.code : 0;
    if (code === 4 && cur.item.key.endsWith(".webm")) {
      // MEDIA_ERR_SRC_NOT_SUPPORTED on a WebM file: this phone/browser (older iPhones) can't play WebM.
      // Retrying won't help and it is not a connection problem, so say what it really is.
      setStatus("error", "This video format isn't supported on this device. Please try another browser or device.");
      return;
    }
    if (cur.retried < 2) {
      cur.retried += 1; // an expired or dropped link: ask for a fresh one, and carry on from the same spot
      startPlayback(player.currentTime || 0, true);
      return;
    }
    setStatus("error", "This video couldn't load. Check your connection and tap Try again.");
  });
  // Slow network: show a spinner while the picture waits for data instead of looking frozen.
  player.addEventListener("waiting", () => {
    if (current && player.getAttribute("src")) setStatus("buffering");
  });
  player.addEventListener("canplay", () => {
    if (current) setStatus(null);
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
if (section && listEl && tabsEl && moreBtn && viewer && player && statusEl && statusText && retryBtn && closeBtn && vMeta && vTitle && vCaption) {
  start();
}
