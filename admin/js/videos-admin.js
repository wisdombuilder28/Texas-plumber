// admin/js/videos-admin.js
// The admin "Videos" page: pick a video, make it smaller on this phone, send it to the video storage, post it
// to Recent Work. The pieces:
//   video-engine.bundle.js  makes the smaller copy and the cover pictures (loaded only when a video is picked)
//   video-upload.js         sends the copy to the storage in parts, with retries
//   /api/videos             hands out the one-time upload links and checks the whole video arrived
// The video itself never passes through the website's server.
import { auth, db } from "../../firebase-config.js";
import { requireAuth, wireLogout, wireSidebar } from "./auth-guard.js";
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import { UploadError, uploadBlob, abortUpload, deleteStored, apiPost, apiStatus, playLink, runStorageTest } from "./video-upload.js";

wireSidebar();
wireLogout("logout-btn");
if (window.lucide) lucide.createIcons();

// KEEP IN SYNC with firestore.rules (videos): title limit, caption limit and the three type ids are enforced there too.
const MiB = 1024 * 1024;
const MAX_TITLE = 80;
const MAX_CAPTION = 300;
const MAX_ORIGINAL_BYTES = 4 * 1024 * MiB; // the biggest file we will even try to read on a phone
const SLACK_SECONDS = 5; //                   same slack the server allows on the length limit
const FALLBACK_LIMITS = { maxUploadBytes: 400 * MiB, maxSeconds: 720 }; // used until the server tells us its own
const PAGE_SIZE = 20;
const MAX_POSTER_CHARS = 140000;
const DATA_IMAGE = /^data:image\/(jpe?g|png|webp);base64,/i;
const CATEGORIES = [
  { id: "showcase", label: "Job showcase" },
  { id: "before-after", label: "Before & after" },
  { id: "testimonial", label: "Testimonial" },
];
const DEFAULT_CATEGORY = "showcase";
const HEIGHTS = [
  { id: "480", label: "480p" },
  { id: "720", label: "720p" },
  { id: "1080", label: "1080p" },
];
const QUALITIES = [
  { id: "small", label: "Smaller" },
  { id: "balanced", label: "Balanced" },
  { id: "better", label: "Sharper" },
];

const $ = (id) => document.getElementById(id);
const pick = $("video-pick");
const pickInput = $("video-input");
const pickText = $("video-pick-text");
const storageBox = $("storage-box");
const newCard = $("new-video");
const headlineEl = $("nv-headline");
const sizeEl = $("nv-size");
const metaEl = $("nv-meta");
const notesEl = $("nv-notes");
const formEl = $("nv-form");
const titleInput = $("nv-title");
const captionInput = $("nv-caption");
const counterEl = $("nv-counter");
const qualityEl = $("nv-quality");
const estimateEl = $("nv-estimate");
const qualitySummary = $("nv-quality-summary");
const asIsRow = $("nv-asis-row");
const asIsInput = $("nv-asis");
const reviewEl = $("nv-review");
const preview = $("nv-preview");
const compareEl = $("nv-compare");
const coversEl = $("nv-covers");
const coversNote = $("nv-covers-note");
const grabBtn = $("nv-cover-grab");
const redoBtn = $("nv-redo");
const saveFileLink = $("nv-save-file");
const progressWrap = $("nv-progress");
const progressLabel = $("nv-progress-label");
const progressFill = $("nv-progress-fill");
const primaryBtn = $("nv-primary");
const secondaryBtn = $("nv-secondary");
const listEl = $("video-list");
const loadingEl = $("video-loading");
const emptyEl = $("video-empty");
const emptyText = $("video-empty-text");
const moreBtn = $("video-more");
const playerDialog = $("player");
const playerVideo = $("player-video");
const playerCaption = $("player-caption");
const editDialog = $("edit-dialog");
const editForm = $("edit-form");
const toastEl = $("toast");
const setupBox = $("setup-box");

// ---------- Small helpers ----------
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

// Inline icons for controls and rows built by this script: they must never depend on the icon CDN.
const ICONS = {
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};
function icon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = ICONS[name]; // static strings above -- never user data
  return svg;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "0 KB";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
function formatDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function formatLeft(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 8) return "a few seconds left";
  if (sec < 90) return `about ${Math.max(10, Math.round(sec / 10) * 10)} seconds left`;
  return `about ${Math.ceil(sec / 60)} min left`;
}
function shortText(text, max = 40) {
  const t = String(text || "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function categoryOf(data) {
  return CATEGORIES.some((c) => c.id === data?.category) ? data.category : DEFAULT_CATEGORY;
}
function labelOf(id) {
  return (CATEGORIES.find((c) => c.id === id) || CATEGORIES[0]).label;
}

// Feedback that stays on screen wherever the admin has scrolled to.
let toastTimer;
function toast(text, kind = "success") {
  clearTimeout(toastTimer);
  toastEl.textContent = "";
  toastEl.className = `toast is-${kind}`;
  toastEl.hidden = false;
  requestAnimationFrame(() => {
    toastEl.textContent = text; // set after un-hiding so screen readers announce it
  });
  toastTimer = setTimeout(
    () => {
      toastEl.hidden = true;
    },
    kind === "error" ? 9000 : 3500
  );
}
toastEl.addEventListener("click", () => {
  toastEl.hidden = true;
});

// Turns a raw Firestore error into something specific enough to act on.
function friendlyError(error) {
  switch (error?.code) {
    case "permission-denied":
      return "the server refused it. Sign out and back in; if it keeps happening, this account isn't listed as an admin in Firebase, or the video rules haven't been published yet.";
    case "unauthenticated":
      return "you've been signed out. Refresh the page and log in again.";
    case "unavailable":
    case "deadline-exceeded":
    case "client-timeout":
      return "network problem. Check your connection and try again.";
    case "resource-exhausted":
      return "Firebase's free daily limit has been reached. Try again later.";
    case "invalid-argument":
      return "Firebase rejected the data.";
    default:
      return error?.code ? `something went wrong (${error.code}). Try again.` : "something went wrong. Try again.";
  }
}

// Stops the page waiting forever on a bad connection. (It can't cancel the request already in flight.)
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "client-timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}
function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

// A row of radio buttons drawn like the Gallery page's switches.
function buildSeg(container, name, options, onPick) {
  const inputs = options.map((o) => {
    const input = el("input", { type: "radio", name, value: o.id });
    input.addEventListener("change", () => {
      if (input.checked) onPick(o.id);
    });
    container.append(el("label", { class: "seg-opt" }, input, el("span", { text: o.label })));
    return input;
  });
  return {
    set(value) {
      inputs.forEach((i) => {
        i.checked = i.value === value;
      });
    },
    disable(on) {
      inputs.forEach((i) => {
        i.disabled = on;
      });
    },
  };
}

// ---------- The storage ----------
let status = null; //        the last answer from /api/videos?action=status
let statusError = null; //   plain-English reason we couldn't ask
let statusLoading = false;
let cleaned = false;

async function getToken() {
  const user = auth.currentUser;
  if (!user) throw new UploadError("auth", "You've been signed out. Refresh the page and log in again.");
  try {
    return await user.getIdToken();
  } catch {
    throw new UploadError("network", "Couldn't reach the sign-in service. Check your connection and try again.");
  }
}

const storageReady = () => !!(status && status.configured && status.storageOk);
const limitsNow = () => ({
  maxBytes: (status && status.limits && status.limits.maxUploadBytes) || FALLBACK_LIMITS.maxUploadBytes,
  maxSeconds: (status && status.limits && status.limits.maxSeconds) || FALLBACK_LIMITS.maxSeconds,
});
const capBytes = () => (status && status.limits && Number.isFinite(status.limits.capBytes) ? status.limits.capBytes : null);

async function loadStatus() {
  if (statusLoading) return;
  statusLoading = true;
  renderStorage();
  updatePick();
  try {
    status = await apiStatus(getToken);
    statusError = null;
  } catch (error) {
    status = null;
    statusError = error.message || "Couldn't check the video storage.";
  }
  statusLoading = false;
  renderStorage();
  updatePick();
  if (job) renderJob();
  if (storageReady() && !cleaned) {
    cleaned = true;
    apiPost(getToken, { action: "cleanup" }).catch(() => {}); // frees half-finished uploads left by earlier attempts
  }
}

function openSetup() {
  setupBox.open = true;
  setupBox.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Has this phone already shown it can send files to the storage? Only used to show a first-time hint.
const WORKS_FLAG = "ndflow-video-storage-works";
function storageWorksHere() {
  try {
    return localStorage.getItem(WORKS_FLAG) === "1";
  } catch {
    return false;
  }
}
function rememberStorageWorks() {
  try {
    localStorage.setItem(WORKS_FLAG, "1");
  } catch {
    /* private window: the hint just shows again */
  }
}
function runTestNow() {
  openSetup();
  testBtn.click();
}

function renderStorage() {
  storageBox.className = "v-storage";
  const buttons = [];
  const again = () => el("button", { type: "button", class: "btn-ghost-dark", text: "Check again", onclick: loadStatus });
  const setup = () => el("button", { type: "button", class: "btn-ghost-dark", text: "Open storage setup", onclick: openSetup });

  if (statusLoading && !status) {
    storageBox.replaceChildren(document.createTextNode("Checking the video storage…"));
    return;
  }
  if (statusError) {
    storageBox.classList.add("is-error");
    storageBox.replaceChildren(el("p", { text: `Couldn't check the video storage: ${statusError}` }), el("div", { class: "v-storage-actions" }, again()));
    return;
  }
  if (!status) {
    storageBox.replaceChildren(document.createTextNode("Checking the video storage…"));
    return;
  }
  if (!status.configured) {
    storageBox.classList.add("is-error");
    const missing = (status.missing || []).length ? ` These settings are missing in Vercel: ${status.missing.join(", ")}.` : "";
    storageBox.replaceChildren(
      el("p", { text: `Video storage isn't set up yet.${missing}${status.problem ? ` ${status.problem}` : ""}` }),
      el("div", { class: "v-storage-actions" }, setup(), again())
    );
    return;
  }
  if (!status.storageOk) {
    storageBox.classList.add("is-error");
    storageBox.replaceChildren(
      el("p", { text: status.problem || "The website can't reach the video storage right now." }),
      el("div", { class: "v-storage-actions" }, setup(), again())
    );
    return;
  }

  const cap = capBytes();
  const used = Number(status.usedBytes) || 0;
  const count = Number(status.objectCount) || 0;
  const ratio = cap ? Math.min(1, used / cap) : 0;
  if (cap && ratio >= 1) storageBox.classList.add("is-full", "is-warn");
  else if (cap && ratio >= 0.8) storageBox.classList.add("is-warn");
  const parts = [
    el("p", {}, el("strong", { text: formatBytes(used) }), document.createTextNode(cap ? ` of ${formatBytes(cap)} used` : " used"), document.createTextNode(` · ${count} ${count === 1 ? "video" : "videos"}`)),
  ];
  if (cap) {
    const fill = el("div", { class: "v-meter-fill" });
    fill.style.width = `${Math.max(1, Math.round(ratio * 100))}%`;
    parts.push(el("div", { class: "v-meter-track", role: "img", "aria-label": `${Math.round(ratio * 100)} percent of the video storage is used` }, fill));
    if (ratio >= 1) parts.push(el("p", { class: "v-meter-note", text: "The storage is full. Delete some old videos before adding new ones." }));
    else if (ratio >= 0.8) parts.push(el("p", { class: "v-meter-note", text: "Getting full. Delete old videos you no longer need to make room." }));
  }
  if (!storageWorksHere()) {
    parts.push(
      el("p", { class: "v-meter-note", text: "First video on this phone? Run the quick test first. It takes a few seconds and shows if anything is still missing." }),
      el("div", { class: "v-storage-actions" }, el("button", { type: "button", class: "btn-ghost-dark", text: "Run the test", onclick: runTestNow }))
    );
  }
  storageBox.replaceChildren(...parts);
}

function updatePick() {
  const full = storageReady() && capBytes() != null && Number(status.usedBytes) >= capBytes();
  const enabled = storageReady() && !job && !full;
  pickInput.disabled = !enabled;
  pick.classList.toggle("disabled", !enabled);
  if (!storageReady()) pickText.textContent = statusLoading || (!status && !statusError) ? "Checking…" : "Storage not ready";
  else if (job) pickText.textContent = "Finish the video below first";
  else if (full) pickText.textContent = "Storage full";
  else pickText.textContent = "Add a video";
}

// ---------- The video engine (only loaded once a video is picked) ----------
let engine = null;
let enginePromise = null;
async function loadEngine() {
  if (engine) return engine;
  if (!enginePromise) {
    enginePromise = import("./video-engine.bundle.js").then(
      (mod) => {
        engine = mod;
        return mod;
      },
      (cause) => {
        enginePromise = null;
        throw Object.assign(new Error("engine_load"), { code: "engine_load", cause });
      }
    );
  }
  return enginePromise;
}

// ---------- The video being added ----------
// stage: inspecting (reading the file) -> ready (choose size, fill in details) -> working (shrinking / getting
//        cover pictures) -> review (preview, cover, post) -> uploading -> saving -> done (the card goes away)
let job = null;
let jobSeq = 0;
let category = DEFAULT_CATEGORY;

const heightSeg = buildSeg($("nv-height"), "nv-height", HEIGHTS, (v) => {
  if (!job || job.stage !== "ready") return;
  job.opts.height = v;
  recomputePlan();
});
const qualitySeg = buildSeg($("nv-qual"), "nv-qual", QUALITIES, (v) => {
  if (!job || job.stage !== "ready") return;
  job.opts.quality = v;
  recomputePlan();
});
const categorySeg = buildSeg($("nv-category"), "nv-cat", CATEGORIES, (v) => {
  category = v;
});
asIsInput.addEventListener("change", () => {
  if (!job || job.stage !== "ready") return;
  job.opts.asIs = asIsInput.checked;
  recomputePlan();
});
captionInput.addEventListener("input", () => {
  counterEl.textContent = `${captionInput.value.length}/${MAX_CAPTION}`;
  counterEl.classList.toggle("near-limit", captionInput.value.length >= MAX_CAPTION * 0.9);
});
titleInput.addEventListener("input", () => {
  if (job && job.error && job.error.kind === "title" && titleInput.value.trim()) {
    job.error = null; // they've fixed it: take the red note away
    renderNotes(job);
  }
});

function resetForm() {
  titleInput.value = "";
  captionInput.value = "";
  counterEl.textContent = `0/${MAX_CAPTION}`;
  counterEl.classList.remove("near-limit");
  category = DEFAULT_CATEGORY;
  categorySeg.set(category);
}
resetForm();

function newJob(file) {
  return {
    id: ++jobSeq,
    file,
    stage: "inspecting",
    blocked: null, //      text: this video can't be used at all
    error: null, //        { text, action? }: the last thing that went wrong
    info: null,
    plan: null,
    opts: { height: "720", quality: "balanced", asIs: false },
    asIsOk: false,
    asIsForced: false,
    spaceProblem: null,
    workHeadline: "",
    shrunk: null, //       { blob, mime, ext, codec, width, height, bytes, audioLost, asIs? }
    shrunkUrl: null,
    originalUrl: null,
    showing: "after",
    previewBroken: false,
    frames: [],
    custom: null,
    cover: 0,
    look: null,
    session: null, //      an unfinished upload we can carry on with
    uploaded: null, //     { key, bytes } once the whole video is in the storage
    retry: false,
    abort: null,
  };
}

function revokeUrls(j) {
  if (j.shrunkUrl) URL.revokeObjectURL(j.shrunkUrl);
  if (j.originalUrl) URL.revokeObjectURL(j.originalUrl);
  j.shrunkUrl = null;
  j.originalUrl = null;
}
function dropShrunk(j) {
  revokeUrls(j);
  j.shrunk = null;
  j.frames = [];
  j.custom = null;
  j.cover = 0;
  j.look = null;
  j.showing = "after";
  j.previewBroken = false;
}

function block(j, text) {
  if (job !== j) return;
  j.blocked = text;
  j.stage = "ready";
  renderJob();
}

async function startJob(file) {
  if (job) return;
  const j = newJob(file);
  job = j;
  resetForm();
  renderJob();
  newCard.scrollIntoView({ behavior: "smooth", block: "start" });

  if (file.type && !file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(file.name || "")) {
    return block(j, "That doesn't look like a video file. Pick a video from your phone.");
  }
  if (file.size > MAX_ORIGINAL_BYTES) {
    return block(j, `This file is ${formatBytes(file.size)}. The biggest video this page can handle is ${formatBytes(MAX_ORIGINAL_BYTES)}. Trim it in CapCut and try again.`);
  }

  let eng;
  try {
    eng = await loadEngine();
  } catch (error) {
    return block(j, explain(error));
  }
  if (job !== j) return;
  const support = await eng.supportReport();
  if (job !== j) return;
  if (!support.webcodecs) {
    return block(j, "This browser can't shrink videos. Open this page in Chrome on your phone.");
  }

  let info;
  try {
    info = await eng.inspect(file);
  } catch (error) {
    if (job !== j) return;
    return block(j, explain(error));
  }
  if (job !== j) return;

  const limits = limitsNow();
  if (info.duration > limits.maxSeconds + SLACK_SECONDS) {
    return block(j, `This video is ${formatDuration(info.duration)} long. Videos can be at most ${Math.round(limits.maxSeconds / 60)} minutes. Trim it in CapCut and try again.`);
  }
  if (!info.canDecode) return block(j, eng.describeError({ code: "cannot_decode" }).message);

  const asIsOk = eng.canUploadAsIs(info, limits);
  const canMake = support.h264 || support.vp9;
  if (!canMake && !asIsOk) return block(j, eng.describeError({ code: "no_encoder" }).message);

  j.info = info;
  j.asIsOk = asIsOk;
  j.asIsForced = !canMake && asIsOk;
  recomputePlan(true);
  if (j.asIsOk && (j.asIsForced || !j.plan.smaller)) {
    j.opts.asIs = true; // already small (or this browser can't make a smaller one): upload it as it is
    j.autoAsIs = true;
  }
  j.stage = "ready";
  renderJob();
}

function recomputePlan(skipRender) {
  const j = job;
  if (!j || !j.info || !engine) return;
  j.plan = engine.plan(j.info, { height: Number(j.opts.height), quality: j.opts.quality, maxBytes: limitsNow().maxBytes });
  const size = j.opts.asIs ? j.info.fileSize : j.plan.estimateBytes;
  const cap = capBytes();
  const used = status && Number.isFinite(status.usedBytes) ? status.usedBytes : null;
  j.spaceProblem =
    cap != null && used != null && used + size > cap
      ? `There isn't enough free space for this video (about ${formatBytes(Math.max(0, cap - used))} left, it needs about ${formatBytes(size)}). Delete some old videos first${j.opts.asIs ? "" : ", or choose a smaller size or quality"}.`
      : null;
  if (!skipRender) renderJob();
}

// ----- notes: the short messages above the form -----
function computeNotes(j) {
  const notes = [];
  if (j.blocked) {
    notes.push({ kind: "error", text: j.blocked });
    return notes;
  }
  if (j.error) notes.push({ kind: "error", text: j.error.text, action: j.error.action });
  if (j.stage === "ready" && j.info) {
    if (j.spaceProblem) notes.push({ kind: "error", text: j.spaceProblem });
    if (j.autoAsIs && j.opts.asIs && !j.asIsForced) notes.push({ kind: "info", text: "This video is already small, so it will be uploaded as it is." });
    if (j.asIsForced) notes.push({ kind: "info", text: "This browser can't make a smaller copy, so the video will be uploaded as it is." });
    if (j.info.hdr) notes.push({ kind: "warn", text: "This looks like an HDR video, so its colours may look a little flat after shrinking. Check the preview before posting." });
    if (!j.info.audio) notes.push({ kind: "info", text: "This video has no sound." });
    if (j.plan && j.plan.limitedBySize && !j.opts.asIs) notes.push({ kind: "warn", text: "To fit the size limit this long video has to be squeezed harder, so it will look softer than usual." });
  }
  if ((j.stage === "review" || j.stage === "uploading" || j.stage === "saving") && j.shrunk) {
    if (j.uploaded && j.stage === "review") notes.push({ kind: "info", text: "The video is uploaded. It only needs saving to the list." });
    if (j.shrunk.audioLost) notes.push({ kind: "warn", text: "This smaller copy has no sound, because this browser couldn't keep the original sound." });
    if (j.look && j.look.differs && !j.shrunk.asIs) {
      const how = j.look.delta > 10 ? "brighter" : j.look.delta < -10 ? "darker" : "different in contrast";
      notes.push({ kind: "warn", text: `Heads-up: the smaller copy looks ${how} than the original. Play both with the buttons under the video and check you're happy with it. If it looks wrong, tap “Choose another size or quality”.` });
    }
    if (j.previewBroken) notes.push({ kind: "warn", text: "This browser can't show a preview of the smaller copy, but it can still be posted." });
  }
  return notes;
}

function renderNotes(j) {
  notesEl.replaceChildren(
    ...computeNotes(j).map((n) => {
      const p = el("p", { class: `v-note is-${n.kind === "warn" ? "warn" : n.kind === "error" ? "error" : n.kind === "ok" ? "ok" : "info"}`, role: n.kind === "error" ? "alert" : null }, document.createTextNode(n.text));
      if (n.action) p.append(document.createElement("br"), el("button", { type: "button", text: n.action.label, onclick: n.action.run }));
      return p;
    })
  );
}

function renderQuality(j) {
  heightSeg.set(j.opts.height);
  qualitySeg.set(j.opts.quality);
  asIsInput.checked = j.opts.asIs;
  asIsInput.disabled = j.asIsForced;
  asIsRow.hidden = !j.asIsOk;
  const manual = j.opts.asIs;
  $("nv-height").classList.toggle("is-off", manual);
  $("nv-qual").classList.toggle("is-off", manual);
  heightSeg.disable(manual);
  qualitySeg.disable(manual);
  if (!j.plan) return;
  if (manual) {
    estimateEl.textContent = `Uploads as it is: ${formatBytes(j.info.fileSize)}.`;
    qualitySummary.textContent = "(not changed)";
  } else {
    const p = j.plan;
    estimateEl.textContent = p.smaller
      ? `The smaller copy will be about ${formatBytes(p.estimateBytes)} (${p.width}×${p.height}), down from ${formatBytes(j.info.fileSize)}.`
      : `This video is already fairly small. The copy will be about ${formatBytes(p.estimateBytes)} (${p.width}×${p.height}).`;
    qualitySummary.textContent = `(${HEIGHTS.find((h) => h.id === String(p.targetHeight))?.label || `${p.targetHeight}p`}, ${QUALITIES.find((q) => q.id === p.quality)?.label || "Balanced"})`;
  }
}

function renderJob() {
  updatePick();
  const j = job;
  newCard.hidden = !j;
  document.body.classList.toggle("has-staging", !!j);
  if (!j) return;
  const st = j.stage;
  newCard.dataset.state = st;
  const working = st === "working" || st === "uploading" || st === "saving";

  headlineEl.textContent = j.blocked
    ? "This video can't be used"
    : st === "inspecting"
      ? "Reading your video…"
      : st === "ready"
        ? "New video"
        : st === "working"
          ? j.workHeadline || "Working…"
          : st === "review"
            ? j.uploaded
              ? "Almost done"
              : "Check it, then post it"
            : st === "uploading"
              ? "Uploading…"
              : "Saving…";
  sizeEl.textContent = formatBytes(j.file.size);
  metaEl.textContent = j.info
    ? `${j.file.name || "video"} · ${formatDuration(j.info.duration)} · ${j.info.width}×${j.info.height}`
    : j.file.name || "video";

  formEl.hidden = st === "inspecting" || !!j.blocked;
  qualityEl.hidden = !(st === "ready" && !j.blocked && j.info);
  reviewEl.hidden = !(st === "review" || st === "uploading" || st === "saving");
  progressWrap.hidden = !working;
  if (!qualityEl.hidden) renderQuality(j);

  const busy = st === "uploading" || st === "saving";
  compareEl.hidden = !(j.shrunk && !j.shrunk.asIs);
  saveFileLink.hidden = !(j.shrunk && !j.shrunk.asIs && j.shrunkUrl);
  if (!saveFileLink.hidden) {
    saveFileLink.href = j.shrunkUrl;
    const base = String(j.file.name || "video").replace(/\.[^.]+$/, "") || "video";
    saveFileLink.download = `${base}-small.${j.shrunk.ext}`;
  }
  redoBtn.hidden = !(st === "review" && !j.uploaded && !j.session);
  grabBtn.hidden = !(st === "review");
  grabBtn.disabled = j.showing !== "after" || !!j.previewBroken;
  coversEl.querySelectorAll("input").forEach((i) => {
    i.disabled = busy;
  });
  paintCompare();

  let text = "";
  let show = false;
  let disabled = false;
  if (st === "ready" && !j.blocked) {
    show = true;
    text = j.opts.asIs ? "Next: choose a cover" : "Make it smaller";
    disabled = !!j.spaceProblem;
  } else if (st === "review") {
    show = true;
    text = j.uploaded ? "Save again" : j.retry ? "Try again" : "Upload and post";
  } else if (working) {
    show = true;
    disabled = true;
    text = st === "saving" ? "Saving…" : st === "uploading" ? "Uploading…" : "Working…";
  }
  primaryBtn.hidden = !show;
  primaryBtn.textContent = text;
  primaryBtn.disabled = disabled;
  secondaryBtn.textContent = st === "working" || st === "uploading" ? "Cancel" : "Remove";
  secondaryBtn.disabled = st === "saving";

  renderNotes(j);
}

function setProgress(label, fraction) {
  progressWrap.hidden = false;
  progressLabel.textContent = label;
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  progressFill.style.width = `${Math.round(f * 100)}%`;
}

// ----- plain-English problems -----
function uploadMessage(e) {
  switch (e.code) {
    case "network":
      return "Lost the connection. What was already sent is kept. Tap Try again when your signal is back.";
    case "blocked":
      return "The storage isn't letting this phone send videos to it yet. That's the one-time “upload permission” step. Tap “Open the setup” and follow step 2, then come back here and tap Try again: your video is kept, nothing to redo. (If you already did that step, check your signal and tap Try again.)";
    case "stalled":
      return "The connection stopped moving. What was already sent is kept. Tap Try again.";
    case "link_rejected":
      return "The storage refused the upload link. Open “Storage setup & test” at the bottom of this page and run the test.";
    case "upload_gone":
      return "That upload expired, so it will start fresh. Tap Try again.";
    case "storage_busy":
      return "The storage is busy right now. Wait a minute, then tap Try again.";
    case "storage_refused":
      return `The storage refused the video (error ${e.status || "?"}). Open “Storage setup & test” at the bottom of this page and run the test.`;
    case "incomplete":
      return "The storage didn't get the whole video. Tap Try again.";
    default:
      return e.message || "The upload didn't finish. Tap Try again.";
  }
}
function explain(e) {
  if (e instanceof UploadError) return uploadMessage(e);
  if (e && e.code === "engine_load") return "Couldn't load the video tools. Check your connection and try again.";
  if (engine) return engine.describeError(e).message;
  return "Something went wrong. Try again.";
}

// ----- step 1: make it smaller -----
async function doShrink(allowNoAudio = false) {
  const j = job;
  if (!j || !j.info || !j.plan || j.stage !== "ready") return;
  j.error = null;
  j.abort = new AbortController();
  j.stage = "working";
  j.workHeadline = "Making it smaller…";
  renderJob();
  setProgress("Starting…", 0);
  const release = engine.keepScreenOn();
  const t0 = performance.now();
  try {
    const result = await engine.shrink(j.file, j.info, j.plan, {
      signal: j.abort.signal,
      allowNoAudio,
      onProgress: (f) => {
        if (job !== j) return;
        const left = f > 0.04 ? (((performance.now() - t0) / f) * (1 - f)) / 1000 : null;
        setProgress(`Making it smaller… ${Math.round(f * 100)}%${left != null ? ` · ${formatLeft(left)}` : ""}`, f);
      },
    });
    if (job !== j) return;
    if (result.bytes > limitsNow().maxBytes) {
      throw Object.assign(new Error("still_big"), { code: "still_big", bytes: result.bytes });
    }
    await prepareReview(j, result);
  } catch (error) {
    if (job !== j) return;
    const canceled = (error && error.code === "canceled") || j.abort.signal.aborted;
    dropShrunk(j);
    j.stage = "ready";
    if (!canceled) {
      if (error && error.code === "still_big") {
        j.error = { text: `The smaller copy came out at ${formatBytes(error.bytes)}, over the ${formatBytes(limitsNow().maxBytes)} limit. Choose 480p or “Smaller” quality and try again.` };
      } else if (error && error.code === "audio_dropped") {
        j.error = { text: "This browser can't keep this video's sound.", action: { label: "Make it without sound", run: () => doShrink(true) } };
      } else {
        console.error("Shrinking failed:", error);
        j.error = { text: explain(error) };
      }
    }
    renderJob();
  } finally {
    release();
    j.abort = null;
  }
}

// Skips shrinking (the file is already fine to upload), but still gets cover pictures.
async function prepareAsIs() {
  const j = job;
  if (!j || !j.info || j.stage !== "ready") return;
  j.error = null;
  j.abort = new AbortController();
  j.stage = "working";
  j.workHeadline = "Getting ready…";
  renderJob();
  setProgress("Getting cover pictures…", 0.5);
  try {
    await prepareReview(j, {
      blob: j.file,
      mime: j.info.containerMime,
      ext: j.info.containerMime === "video/webm" ? "webm" : "mp4",
      codec: j.info.codec,
      width: j.info.width,
      height: j.info.height,
      bytes: j.file.size,
      audioLost: false,
      asIs: true,
    });
  } catch (error) {
    if (job !== j) return;
    console.error("Preparing failed:", error);
    dropShrunk(j);
    j.stage = "ready";
    j.error = { text: explain(error) };
    renderJob();
  } finally {
    j.abort = null;
  }
}

async function prepareReview(j, result) {
  j.shrunk = result;
  j.shrunkUrl = URL.createObjectURL(result.blob);
  j.workHeadline = "Almost ready…";
  setProgress("Picking cover pictures…", 1);
  j.frames = await engine.grabFrames(result.blob, { width: result.width, height: result.height, duration: j.info.duration }, 3).catch(() => []);
  if (job !== j) return;
  j.cover = j.frames.length > 1 ? 1 : 0;
  j.custom = null;
  if (!result.asIs) {
    setProgress("Checking the picture still looks right…", 1);
    j.look = await engine.compareLook(j.file, result.blob, j.info.duration).catch(() => null);
    if (job !== j) return;
  }
  if (j.abort && j.abort.signal.aborted) throw Object.assign(new Error("canceled"), { code: "canceled" });
  j.stage = "review";
  j.showing = "after";
  j.previewBroken = false;
  renderJob();
  setPreview();
  renderCovers();
  newCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ----- step 2: review (preview, cover) -----
function setPreview(resumeAt = 0) {
  const j = job;
  if (!j || !j.shrunk) {
    preview.removeAttribute("src");
    preview.load();
    return;
  }
  let url = j.shrunkUrl;
  if (j.showing === "before") {
    if (!j.originalUrl) j.originalUrl = URL.createObjectURL(j.file);
    url = j.originalUrl;
  }
  preview.src = url;
  preview.load();
  if (resumeAt > 0) {
    preview.addEventListener(
      "loadedmetadata",
      () => {
        try {
          preview.currentTime = Math.min(resumeAt, preview.duration || resumeAt);
        } catch {
          /* the preview just starts from the beginning */
        }
      },
      { once: true }
    );
  }
  paintCompare();
  grabBtn.disabled = j.showing !== "after" || !!j.previewBroken;
}
function paintCompare() {
  const j = job;
  compareEl.querySelectorAll("[data-which]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(!!j && btn.dataset.which === j.showing));
  });
}
compareEl.querySelectorAll("[data-which]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const j = job;
    if (!j || !j.shrunk || btn.dataset.which === j.showing) return;
    const time = preview.currentTime;
    j.showing = btn.dataset.which;
    setPreview(time);
  })
);
preview.addEventListener("error", () => {
  const j = job;
  if (!j || !j.shrunk || !preview.getAttribute("src")) return;
  if (j.showing === "before") {
    j.showing = "after";
    setPreview();
    toast("This browser can't play the original here. That's normal for some phone formats. The smaller copy is what gets posted.", "error");
  } else {
    j.previewBroken = true;
    renderJob();
  }
});

function coverOptions(j) {
  return [...j.frames, ...(j.custom ? [j.custom] : [])];
}
function pickedCover(j) {
  const options = coverOptions(j);
  return options[j.cover] || options[0] || null;
}
function paintPicked() {
  coversEl.querySelectorAll(".cover-opt").forEach((label, i) => {
    label.classList.toggle("is-picked", !!job && i === job.cover);
  });
}
function renderCovers() {
  coversEl.replaceChildren();
  const j = job;
  if (!j || !j.shrunk) return;
  const options = coverOptions(j);
  coversNote.hidden = options.length > 0;
  coversNote.textContent = options.length ? "" : "Couldn't make cover pictures for this video. It will show a plain dark cover.";
  options.forEach((frame, i) => {
    if (!DATA_IMAGE.test(frame.dataUrl || "")) return;
    const input = el("input", { type: "radio", name: "nv-cover", value: String(i), "aria-label": frame.custom ? "Your own cover picture" : `Cover picture ${i + 1}, from ${formatDuration(frame.t)}` });
    input.checked = i === j.cover;
    input.disabled = j.stage !== "review";
    input.addEventListener("change", () => {
      if (!input.checked) return;
      j.cover = i;
      paintPicked();
    });
    coversEl.append(
      el(
        "label",
        { class: `cover-opt${i === j.cover ? " is-picked" : ""}` },
        input,
        el("img", { alt: "", src: frame.dataUrl }),
        el("span", { class: "cover-time", text: frame.custom ? "Your pick" : formatDuration(frame.t) })
      )
    );
  });
}

grabBtn.addEventListener("click", async () => {
  const j = job;
  if (!j || j.stage !== "review" || j.showing !== "after" || !preview.videoWidth) return;
  preview.pause();
  try {
    const scale = Math.min(1, 720 / Math.max(preview.videoWidth, preview.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(preview.videoWidth * scale));
    canvas.height = Math.max(2, Math.round(preview.videoHeight * scale));
    canvas.getContext("2d").drawImage(preview, 0, 0, canvas.width, canvas.height);
    const poster = await engine.posterFromCanvas(canvas);
    j.custom = { t: preview.currentTime, ...poster, custom: true };
    j.cover = j.frames.length;
    renderCovers();
    toast("Cover picked.");
  } catch (error) {
    console.error("Cover grab failed:", error);
    toast("Couldn't grab that picture. Try again.", "error");
  }
});

redoBtn.addEventListener("click", () => {
  const j = job;
  if (!j || j.stage !== "review" || j.uploaded || j.session) return;
  dropShrunk(j);
  j.error = null;
  j.retry = false;
  j.stage = "ready";
  setPreview();
  coversEl.replaceChildren();
  renderJob();
  newCard.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ----- step 3: upload, then save to the list -----
async function doUpload() {
  const j = job;
  if (!j || !j.shrunk || j.stage !== "review") return;
  const title = titleInput.value.trim();
  if (!title) {
    j.error = { kind: "title", text: "Add a short title first, for example “Bathroom pipe replacement, Lekki”." };
    renderJob();
    titleInput.focus();
    titleInput.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  j.error = null;
  preview.pause();
  const release = engine.keepScreenOn();
  try {
    if (!j.uploaded) {
      j.abort = new AbortController();
      j.stage = "uploading";
      renderJob();
      setProgress("Starting the upload…", 0);
      let retryAt = 0;
      const result = await uploadBlob({
        blob: j.shrunk.blob,
        mime: j.shrunk.mime,
        durationSec: j.info.duration,
        getToken,
        signal: j.abort.signal,
        session: j.session,
        onProgress: ({ fraction, bytesPerSecond, secondsLeft }) => {
          if (job !== j) return;
          const hiccup = Date.now() - retryAt < 6000 ? " · reconnecting…" : "";
          const speed = bytesPerSecond > 1024 ? ` · ${formatBytes(bytesPerSecond)}/s` : "";
          const left = secondsLeft != null && fraction > 0.02 ? ` · ${formatLeft(secondsLeft)}` : "";
          setProgress(`Uploading… ${Math.round(fraction * 100)}%${speed}${left}${hiccup}`, fraction);
        },
        onRetry: () => {
          retryAt = Date.now();
        },
      });
      j.uploaded = { key: result.key, bytes: Number.isInteger(result.bytes) ? result.bytes : j.shrunk.bytes };
      j.session = null;
      rememberStorageWorks();
    }
    if (job !== j) return;
    j.stage = "saving";
    renderJob();
    setProgress("Saving…", 1);
    await saveVideo(j);
    finishJob(j);
  } catch (error) {
    handleUploadError(j, error);
  } finally {
    release();
    j.abort = null;
  }
}

function handleUploadError(j, error) {
  if (job !== j) return;
  if (error instanceof UploadError && error.session) j.session = error.session;
  const wasSaving = j.stage === "saving";
  j.stage = "review";
  if (error instanceof UploadError && error.code === "canceled") {
    const s = j.session;
    j.session = null;
    abortUpload(getToken, s); // free what was already sent
    j.error = null;
    renderJob();
    return;
  }
  console.error(wasSaving ? "Saving failed:" : "Upload failed:", error);
  j.retry = true;
  if (!wasSaving && error instanceof UploadError && ["link_rejected", "upload_gone", "storage_refused"].includes(error.code)) {
    const s = j.session;
    j.session = null; // that upload can't be carried on: the next try starts a fresh one
    abortUpload(getToken, s);
  }
  j.error = { text: wasSaving ? `The video is uploaded, but saving it to the list failed: ${friendlyError(error)}` : explain(error) };
  if (!wasSaving && error instanceof UploadError && error.code === "blocked") j.error.action = { label: "Open the setup", run: openSetup };
  renderJob();
}

async function saveVideo(j) {
  const cover = pickedCover(j);
  const key = j.uploaded.key;
  const id = key.replace(/^videos\//, "").replace(/\.(mp4|webm)$/, "");
  const poster = cover && DATA_IMAGE.test(cover.dataUrl) && cover.dataUrl.length <= MAX_POSTER_CHARS ? cover : null;
  const data = {
    title: titleInput.value.trim().slice(0, MAX_TITLE),
    caption: captionInput.value.trim().slice(0, MAX_CAPTION),
    category,
    provider: (status && status.provider) || "b2",
    key,
    mime: j.shrunk.mime,
    bytes: j.uploaded.bytes,
    durationSec: Math.round(j.info.duration * 10) / 10,
    width: j.shrunk.width,
    height: j.shrunk.height,
    poster: poster ? poster.dataUrl : "",
    posterW: poster ? poster.width : 0,
    posterH: poster ? poster.height : 0,
    order: Date.now(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  // The list entry is named after the uploaded file, so saving twice (say, after a bad connection) can never
  // create a duplicate.
  await withTimeout(setDoc(doc(db, "videos", id), data), 30000);
}

function finishJob(j) {
  revokeUrls(j);
  job = null;
  resetForm();
  setPreview();
  coversEl.replaceChildren();
  renderJob();
  toast("Video posted. It's live on Recent Work.");
  listEl.scrollIntoView({ behavior: "smooth", block: "start" });
  loadStatus();
}

// ----- buttons on the card -----
primaryBtn.addEventListener("click", () => {
  const j = job;
  if (!j) return;
  if (j.stage === "ready") {
    if (j.opts.asIs) prepareAsIs();
    else doShrink();
  } else if (j.stage === "review") {
    doUpload();
  }
});

secondaryBtn.addEventListener("click", () => {
  const j = job;
  if (!j || j.stage === "saving") return;
  if (j.stage === "working" || j.stage === "uploading") {
    if (j.abort) j.abort.abort(); // the running step notices, tidies up and goes back one stage
    return;
  }
  if ((j.shrunk || j.uploaded) && !window.confirm(j.uploaded ? "Remove this video? It was uploaded but not posted, so the uploaded file will be deleted." : "Remove this video? The smaller copy that was made will be thrown away.")) return;
  const key = j.uploaded && j.uploaded.key;
  const session = j.session;
  revokeUrls(j);
  job = null;
  resetForm();
  setPreview();
  coversEl.replaceChildren();
  renderJob();
  if (session) abortUpload(getToken, session);
  if (key) deleteStored(getToken, key).catch(() => {});
});

// Don't lose the work (or a running upload) to an accidental back-swipe or refresh.
window.addEventListener("beforeunload", (e) => {
  if (job) {
    e.preventDefault();
    e.returnValue = "";
  }
});

pickInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  pickInput.value = ""; // so picking the very same file again still counts as a change
  if (file) startJob(file);
});

// ---------- The list of posted videos ----------
let docsById = new Map();
let orderedIds = [];
const cards = new Map();
let listLimit = PAGE_SIZE;
let unsubscribe = null;
let loaded = false;
let loadError = null;
const deleting = new Set();

function createCard(id) {
  const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
  const dur = el("span", { class: "v-dur" });
  const thumb = el("button", { type: "button", class: "v-thumb", onclick: () => openPlayer(id) }, el("span", { class: "v-ph" }, icon("film", 24)), img, el("span", { class: "v-play" }, icon("play", 20)), dur);
  const title = el("h3", { class: "v-title" });
  const sub = el("p", { class: "v-sub" });
  const caption = el("p", { class: "v-caption" });
  const edit = el("button", { type: "button", class: "btn-ghost-dark v-edit", onclick: () => openEdit(id) }, icon("pencil", 16), el("span", { text: "Edit" }));
  const del = el("button", { type: "button", class: "g-delete", onclick: () => deleteVideo(id) }, icon("trash"));
  const info = el("div", { class: "v-info" }, title, sub, caption, el("div", { class: "v-actions" }, edit, del));
  const root = el("li", { class: "v-card" }, thumb, info);
  return { id, root, img, dur, thumb, title, sub, caption, edit, del, sig: null, poster: null };
}

function updateCard(card, d) {
  const title = String(d.title || "").trim() || "Untitled video";
  const date = d.createdAt && typeof d.createdAt.toDate === "function" ? d.createdAt.toDate().toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }) : "";
  const sig = [title, d.caption, d.category, d.durationSec, d.bytes, date].join("|");
  if (card.poster !== d.poster) {
    card.poster = d.poster;
    if (typeof d.poster === "string" && DATA_IMAGE.test(d.poster)) card.img.src = d.poster;
    else card.img.removeAttribute("src");
  }
  if (card.sig === sig) return;
  card.sig = sig;
  card.title.textContent = title;
  card.sub.textContent = [labelOf(categoryOf(d)), formatBytes(d.bytes), date].filter(Boolean).join(" · ");
  card.caption.textContent = String(d.caption || "").trim();
  card.dur.textContent = formatDuration(d.durationSec);
  const what = shortText(title);
  card.thumb.setAttribute("aria-label", `Play ${what}`);
  card.edit.setAttribute("aria-label", `Edit ${what}`);
  card.del.setAttribute("aria-label", `Delete ${what}`);
}

function syncChildren(container, wanted) {
  wanted.forEach((node, i) => {
    const current = container.children[i];
    if (current !== node) container.insertBefore(node, current || null);
  });
  while (container.children.length > wanted.length) container.lastElementChild.remove();
}

function layoutList() {
  syncChildren(listEl, orderedIds.map((id) => cards.get(id).root));
  loadingEl.hidden = loaded;
  const empty = loaded && orderedIds.length === 0;
  emptyEl.hidden = !empty;
  if (empty) {
    emptyText.textContent = loadError || "No videos yet. Tap “Add a video” above to post your first one.";
  }
  moreBtn.hidden = !(loaded && !loadError && orderedIds.length >= listLimit);
  moreBtn.disabled = false;
  moreBtn.textContent = "Show older videos";
}

function onVideos(snapshot) {
  loaded = true;
  loadError = null;
  const seen = new Set();
  orderedIds = [];
  docsById = new Map();
  snapshot.docs.forEach((docSnap) => {
    const data = docSnap.data({ serverTimestamps: "estimate" });
    seen.add(docSnap.id);
    orderedIds.push(docSnap.id);
    docsById.set(docSnap.id, data);
    let card = cards.get(docSnap.id);
    if (!card) {
      card = createCard(docSnap.id);
      cards.set(docSnap.id, card);
    }
    updateCard(card, data);
  });
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
  layoutList();
}

// Why the list couldn't be read. "permission-denied" almost always means the new Firestore rules haven't been published yet.
function listErrorText(error) {
  if (error && error.code === "permission-denied") {
    return "Firebase isn't letting this page read the video list yet. In Firebase, open Firestore Database → Rules, paste in the new firestore.rules file and tap Publish. Then refresh this page.";
  }
  return "Couldn't load the videos. Check your connection, then refresh this page.";
}

function startLibrary() {
  if (unsubscribe) unsubscribe();
  const q = query(collection(db, "videos"), orderBy("order", "desc"), limit(listLimit));
  unsubscribe = onSnapshot(q, onVideos, (error) => {
    console.error("Video list failed:", error);
    loaded = true;
    if (!cards.size) loadError = listErrorText(error);
    else toast("Lost connection to the video list. Refresh the page to reconnect.", "error");
    layoutList();
  });
}
moreBtn.addEventListener("click", () => {
  moreBtn.disabled = true;
  moreBtn.textContent = "Loading…";
  listLimit += PAGE_SIZE;
  startLibrary();
});

// ----- play a posted video -----
let playerSeq = 0;
async function openPlayer(id) {
  const d = docsById.get(id);
  if (!d || typeof d.key !== "string") return;
  const seq = ++playerSeq;
  playerVideo.removeAttribute("src");
  playerVideo.poster = typeof d.poster === "string" && DATA_IMAGE.test(d.poster) ? d.poster : "";
  playerCaption.hidden = false;
  playerCaption.textContent = "Loading video…";
  openDialog(playerDialog);
  try {
    const url = await playLink(d.key);
    if (seq !== playerSeq) return;
    playerVideo.src = url;
    playerCaption.textContent = String(d.title || "").trim();
    playerCaption.hidden = !playerCaption.textContent;
    playerVideo.play().catch(() => {});
  } catch (error) {
    if (seq !== playerSeq) return;
    playerCaption.textContent = `Couldn't load this video: ${error.message || "try again in a moment."}`;
  }
}
function closePlayer() {
  closeDialog(playerDialog);
}
playerDialog.addEventListener("close", () => {
  playerSeq += 1;
  playerVideo.pause();
  playerVideo.removeAttribute("src");
  playerVideo.removeAttribute("poster");
  playerVideo.load();
});
playerVideo.addEventListener("error", () => {
  if (!playerVideo.getAttribute("src")) return;
  playerCaption.hidden = false;
  playerCaption.textContent = "This video couldn't be played. Check your connection and try again.";
});
$("player-close").addEventListener("click", closePlayer);
playerDialog.addEventListener("click", (e) => {
  if (e.target === playerDialog) closePlayer(); // tap outside the video
});

// ----- edit a posted video -----
let editingId = null;
let editCategory = DEFAULT_CATEGORY;
const edTitle = $("ed-title");
const edCaption = $("ed-caption");
const edCounter = $("ed-counter");
const edError = $("ed-error");
const edSave = $("ed-save");
const edCategorySeg = buildSeg($("ed-category"), "ed-cat", CATEGORIES, (v) => {
  editCategory = v;
});
edCaption.addEventListener("input", () => {
  edCounter.textContent = `${edCaption.value.length}/${MAX_CAPTION}`;
  edCounter.classList.toggle("near-limit", edCaption.value.length >= MAX_CAPTION * 0.9);
});
function openEdit(id) {
  const d = docsById.get(id);
  if (!d) return;
  editingId = id;
  edTitle.value = String(d.title || "");
  edCaption.value = String(d.caption || "");
  editCategory = categoryOf(d);
  edCategorySeg.set(editCategory);
  edCounter.textContent = `${edCaption.value.length}/${MAX_CAPTION}`;
  edError.hidden = true;
  edSave.disabled = false;
  openDialog(editDialog);
}
$("ed-cancel").addEventListener("click", () => closeDialog(editDialog));
editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = editingId;
  if (!id) return;
  const title = edTitle.value.trim();
  if (!title) {
    edError.textContent = "Add a short title.";
    edError.hidden = false;
    edTitle.focus();
    return;
  }
  edSave.disabled = true;
  edError.hidden = true;
  try {
    await withTimeout(
      updateDoc(doc(db, "videos", id), { title: title.slice(0, MAX_TITLE), caption: edCaption.value.trim().slice(0, MAX_CAPTION), category: editCategory, updatedAt: serverTimestamp() }),
      25000
    );
    closeDialog(editDialog);
    toast("Saved.");
  } catch (error) {
    console.error("Edit failed:", error);
    edError.textContent = `Couldn't save: ${friendlyError(error)}`;
    edError.hidden = false;
  } finally {
    edSave.disabled = false;
  }
});

// ----- delete a posted video -----
async function deleteVideo(id) {
  const d = docsById.get(id);
  if (!d || deleting.has(id)) return;
  if (!window.confirm(`Delete “${shortText(d.title) || "this video"}”? It will disappear from the public site and the video file will be removed for good.`)) return;
  deleting.add(id);
  const card = cards.get(id);
  if (card) card.root.classList.add("is-saving");
  try {
    try {
      await deleteStored(getToken, d.key); // the server removes the file and every old version of it
    } catch (error) {
      if (!(error instanceof UploadError && error.code === "bad_key")) throw error; // a broken entry can still be removed from the list
    }
    await deleteDoc(doc(db, "videos", id));
    toast("Video deleted.");
    loadStatus();
  } catch (error) {
    console.error("Delete failed:", error);
    toast(`Couldn't delete that video: ${error instanceof UploadError ? error.message : friendlyError(error)}`, "error");
  } finally {
    deleting.delete(id);
    const again = cards.get(id);
    if (again) again.root.classList.remove("is-saving");
  }
}

// ---------- Storage setup & test ----------
const testBtn = $("test-btn");
const testSteps = $("test-steps");
const setupBtn = $("setup-btn");
const setupResult = $("setup-result");
const masterId = $("master-id");
const masterKey = $("master-key");

function stepRow(step) {
  return el("li", { class: step.ok ? "is-ok" : "is-bad" }, icon(step.ok ? "check" : "alert", 16), el("span", { text: step.text }));
}
testBtn.addEventListener("click", async () => {
  testBtn.disabled = true;
  testSteps.replaceChildren(el("li", { class: "is-wait" }, el("span", { class: "spinner" }), el("span", { text: "Testing…" })));
  let first = true;
  try {
    const steps = await runStorageTest(getToken, (step) => {
      if (first) {
        testSteps.replaceChildren();
        first = false;
      }
      testSteps.append(stepRow(step));
    });
    if (first) testSteps.replaceChildren();
    if (steps.some((s) => s.id === "upload" && s.ok)) rememberStorageWorks();
    if (steps.length && steps.every((s) => s.ok) && steps[steps.length - 1].id === "cleanup") toast("Video storage works.");
  } catch (error) {
    console.error("Storage test crashed:", error);
    testSteps.replaceChildren(stepRow({ ok: false, text: error.message || "The test stopped unexpectedly." }));
  } finally {
    testBtn.disabled = false;
    loadStatus();
  }
});

function showSetup(text, kind) {
  setupResult.hidden = false;
  setupResult.className = `form-message${kind ? ` ${kind}` : ""}`;
  setupResult.textContent = text;
}
setupBtn.addEventListener("click", async () => {
  const keyId = masterId.value.trim();
  const key = masterKey.value.trim();
  if (!keyId || !key) {
    showSetup("Paste both the master key ID and the master key.", "error");
    return;
  }
  setupBtn.disabled = true;
  showSetup("Working…", "");
  try {
    const r = await apiPost(getToken, { action: "setup", masterKeyId: keyId, masterKey: key });
    masterKey.value = ""; // used once, never kept
    masterId.value = "";
    const lines = [];
    lines.push(r.corsSaved ? "Uploads from this website are now allowed." : "Backblaze answered, but the upload permission didn't save. Try again.");
    if (r.lifecycleSaved) lines.push("Deleted videos will now free their space.");
    if (r.bucketType && r.bucketType !== "allPrivate") lines.push("Warning: this bucket is not private. Make it private in Backblaze.");
    if (r.endpointMatches === false) lines.push(`Warning: STORAGE_ENDPOINT in Vercel doesn't match this bucket's address (${r.s3Host}). Fix it and redeploy.`);
    lines.push("Last step: in Backblaze, generate a new master key, so the one you just pasted stops working. Then tap “Test storage” above.");
    if (r.corsSaved && job && job.retry) lines.push("Your video is still waiting: scroll up and tap “Try again”.");
    showSetup(lines.join(" "), r.corsSaved ? "success" : "error");
  } catch (error) {
    masterKey.value = "";
    showSetup(error.message || "That didn't work. Try again.", "error");
  } finally {
    setupBtn.disabled = false;
  }
});

// ---------- Start ----------
updatePick();
renderStorage();
requireAuth((user) => {
  $("admin-email").textContent = user.email || "";
  startLibrary();
  loadStatus();
});
