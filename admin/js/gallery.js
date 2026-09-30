// admin/js/gallery.js
import { db } from "../../firebase-config.js";
import { requireAuth, wireLogout, wireSidebar } from "./auth-guard.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

wireSidebar();
wireLogout("logout-btn");
if (window.lucide) lucide.createIcons();

requireAuth((user) => {
  document.getElementById("admin-email").textContent = user.email || "";
  startGalleryListener();
});

// Photos are stored as base64 image data directly inside each Firestore document --
// no Firebase Storage, no billing account needed. Firestore caps a document at 1 MiB
// total, so the encoded image has to stay comfortably under that.
// KEEP IN SYNC with firestore.rules: MAX_CAPTION and the two category ids are enforced there too.
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_BYTES = 700 * 1024;
const MAX_RAW_BYTES = Math.floor((MAX_ENCODED_BYTES * 3) / 4);
const MAX_CAPTION = 300;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DATA_IMAGE = /^data:image\/(jpe?g|png|webp|gif|avif);base64,/i;
const DEFAULT_ALT = "N.D. Flow Plumbing Co. completed project";
const CATEGORIES = [
  { id: "completed", label: "Completed" },
  { id: "in-progress", label: "Still working" },
];
const DEFAULT_CATEGORY = "completed";
// In the "All" view "Still working" comes first: those are the jobs that still need attention.
const GROUP_ORDER = ["in-progress", "completed"];

const $ = (id) => document.getElementById(id);
const library = $("gallery-library");
const loadingEl = $("gallery-loading");
const emptyState = $("gallery-empty");
const emptyText = $("gallery-empty-text");
const emptyReset = $("gallery-empty-reset");
const filterBtns = document.querySelectorAll("[data-filter]");
const fileInput = $("gallery-input");
const uploadLabel = document.querySelector(".upload-label");
const stagingArea = $("staging-area");
const stagingHeadline = $("staging-headline");
const stagingMeta = $("staging-meta");
const stagingBulk = $("staging-bulk");
const stagingList = $("staging-list");
const stagingCancelBtn = $("staging-cancel");
const stagingConfirmBtn = $("staging-confirm");
const progressWrap = $("upload-progress");
const progressLabel = $("upload-progress-label");
const progressFill = $("upload-progress-fill");
const viewer = $("viewer");
const viewerImg = $("viewer-img");
const viewerCaption = $("viewer-caption");
const toastEl = $("toast");

// ---------- State ----------
let docsById = new Map(); // id -> latest Firestore data
let orderedIds = []; //      ids, newest first (the order Firestore returns)
const cards = new Map(); //  id -> { root, ...refs }  (each card is built once, then updated in place)
let filter = "all";
let loaded = false;
let pending = []; //         photos picked but not posted yet
let pendingSeq = 0;
let busy = false; //         an upload is running
const deleting = new Set();

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

// Inline icons for the controls that have no text label -- they must never depend on the icon CDN.
const ICONS = {
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
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

function categoryOf(data) {
  return data?.category === "in-progress" ? "in-progress" : DEFAULT_CATEGORY;
}
function labelOf(id) {
  return CATEGORIES.find((c) => c.id === id)?.label || "Completed";
}
function shortText(text, max = 40) {
  const t = String(text || "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, kind === "error" ? 8000 : 3500);
}
toastEl.addEventListener("click", () => {
  toastEl.hidden = true;
});

// Turns a raw Firestore error into something specific enough to act on.
function friendlyError(error) {
  switch (error?.code) {
    case "permission-denied":
      return "the server refused it. Sign out and back in; if it keeps happening, this account isn't listed as an admin in Firebase.";
    case "unauthenticated":
      return "you've been signed out. Refresh the page and log in again.";
    case "unavailable":
    case "deadline-exceeded":
      return "network problem. Check your connection and try again.";
    case "resource-exhausted":
      return "Firebase's free daily limit has been reached. Try again later.";
    case "invalid-argument":
      return "Firebase rejected the data (the photo may be too big).";
    default:
      return error?.code ? `something went wrong (${error.code}). Try again.` : "something went wrong. Try again.";
  }
}

// ---------- Library: live list, built once per photo and updated in place ----------
// Photos are big base64 strings. Rebuilding the whole grid on every change (the old approach)
// re-parses megabytes of HTML and flickers every image; here each card is created once and only
// the parts that changed are touched, so changing a category never reloads a single photo.
const groups = {};
for (const cat of GROUP_ORDER) {
  const count = el("span", { class: "g-count", text: "0" });
  const title = el("h3", { class: "g-group-title" }, el("span", { text: labelOf(cat) }), count);
  const grid = el("ul", { class: "g-grid" });
  const section = el("section", { class: "g-group", hidden: true, "aria-label": labelOf(cat) }, title, grid);
  library.append(section);
  groups[cat] = { section, title, grid, count };
}

function createCard(id) {
  const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
  const media = el("button", { type: "button", class: "g-media", onclick: () => openViewer(id) }, img);
  const caption = el("p", { class: "g-caption" });

  const radios = CATEGORIES.map((c) => {
    const input = el("input", { type: "radio", name: `cat-${id}`, value: c.id });
    input.addEventListener("change", () => {
      if (input.checked) setCategory(id, c.id);
    });
    return { id: c.id, input, label: el("label", { class: "seg-opt" }, input, el("span", { text: c.label })) };
  });
  const seg = el("div", { class: "seg", role: "radiogroup" }, radios.map((r) => r.label));

  const homeLabel = el("span");
  const home = el("button", { type: "button", class: "g-home", "aria-pressed": "false", onclick: () => toggleFeatured(id) }, icon("star"), homeLabel);
  const del = el("button", { type: "button", class: "g-delete", onclick: () => deletePhoto(id) }, icon("trash"));
  const body = el("div", { class: "g-body" }, caption, seg, el("div", { class: "g-actions" }, home, del));
  const root = el("li", { class: "g-card" }, media, body);
  return { id, root, img, media, caption, seg, radios, home, homeLabel, del, src: null, text: null, category: null, featured: null };
}

function updateCard(card, d) {
  const category = categoryOf(d);
  const featured = d.featured === true;
  const text = String(d.caption || "").trim();

  if (card.src !== d.imageData) {
    card.src = d.imageData;
    // Only ever show real data-URL photos; anything else stays blank.
    if (typeof d.imageData === "string" && DATA_IMAGE.test(d.imageData)) card.img.src = d.imageData;
    else card.img.removeAttribute("src");
  }
  if (card.text !== text) {
    card.text = text;
    card.caption.textContent = text || "No description";
    card.caption.classList.toggle("is-empty", !text);
    const what = text ? shortText(text) : "this photo";
    card.media.setAttribute("aria-label", `View ${what} full size`);
    card.seg.setAttribute("aria-label", `Category for ${what}`);
    card.del.setAttribute("aria-label", `Delete ${what}`);
  }
  if (card.category !== category) {
    card.category = category;
    card.radios.forEach((r) => {
      r.input.checked = r.id === category;
    });
  }
  if (card.featured !== featured) {
    card.featured = featured;
    card.root.classList.toggle("is-featured", featured);
    card.home.setAttribute("aria-pressed", String(featured));
    card.homeLabel.textContent = featured ? "On homepage" : "Show on homepage";
  }
}

function syncChildren(container, wanted) {
  wanted.forEach((node, i) => {
    const current = container.children[i];
    if (current !== node) container.insertBefore(node, current || null);
  });
  while (container.children.length > wanted.length) container.lastElementChild.remove();
}

function layout() {
  const counts = { all: orderedIds.length, completed: 0, "in-progress": 0 };
  for (const id of orderedIds) counts[categoryOf(docsById.get(id))] += 1;

  filterBtns.forEach((btn) => {
    const key = btn.dataset.filter;
    btn.setAttribute("aria-pressed", String(key === filter));
    btn.querySelector("[data-count]").textContent = counts[key];
  });

  for (const cat of GROUP_ORDER) {
    const g = groups[cat];
    const ids = orderedIds.filter((id) => categoryOf(docsById.get(id)) === cat);
    syncChildren(g.grid, ids.map((id) => cards.get(id).root));
    g.count.textContent = ids.length;
    g.title.hidden = filter !== "all"; // the filter button already says which group this is
    g.section.hidden = !ids.length || (filter !== "all" && filter !== cat);
  }

  loadingEl.hidden = loaded;
  const showEmpty = loaded && (counts.all === 0 || counts[filter] === 0);
  emptyState.hidden = !showEmpty;
  if (showEmpty) {
    emptyReset.hidden = counts.all === 0;
    emptyText.textContent =
      counts.all === 0
        ? "No photos yet. Tap “Add photos” above to post your first one."
        : `No “${labelOf(filter)}” photos yet. Change a photo's category, or add new ones.`;
  }
}

function onGallery(snapshot) {
  loaded = true;
  const seen = new Set();
  orderedIds = [];
  docsById = new Map();
  snapshot.docs.forEach((docSnap) => {
    const data = docSnap.data();
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
  layout();
}

function startGalleryListener() {
  const galleryQuery = query(collection(db, "gallery"), orderBy("order", "desc"));
  onSnapshot(galleryQuery, onGallery, (error) => {
    console.error("Gallery listener failed:", error);
    loaded = true;
    layout();
    if (!cards.size) {
      emptyState.hidden = false;
      emptyReset.hidden = true;
      emptyText.textContent = "Couldn't load the photos. Check your connection, then refresh this page.";
    } else {
      toast("Lost connection to the gallery. Refresh the page to reconnect.", "error");
    }
  });
}

filterBtns.forEach((btn) =>
  btn.addEventListener("click", () => {
    filter = btn.dataset.filter || "all";
    layout();
  })
);
emptyReset.addEventListener("click", () => {
  filter = "all";
  layout();
});

// ---------- Changing a photo ----------
// The card updates instantly (Firestore applies the change locally first). If the server refuses
// it, Firestore rolls the card back on its own and we say why.
async function setCategory(id, next) {
  const current = docsById.get(id);
  if (!current || categoryOf(current) === next) return;
  try {
    await updateDoc(doc(db, "gallery", id), { category: next, updatedAt: serverTimestamp() });
    toast(`Moved to “${labelOf(next)}”.`);
  } catch (error) {
    console.error("Category update failed:", error);
    toast(`Couldn't change the category: ${friendlyError(error)}`, "error");
    const card = cards.get(id);
    if (card && docsById.get(id)) updateCard(card, docsById.get(id));
  }
}

async function toggleFeatured(id) {
  const current = docsById.get(id);
  if (!current) return;
  const next = current.featured !== true;
  try {
    await updateDoc(doc(db, "gallery", id), { featured: next, updatedAt: serverTimestamp() });
    toast(next ? "Now showing on the homepage." : "Removed from the homepage. It stays in Recent Work.");
  } catch (error) {
    console.error("Featured toggle failed:", error);
    toast(`Couldn't update the homepage setting: ${friendlyError(error)}`, "error");
    const card = cards.get(id);
    if (card && docsById.get(id)) updateCard(card, docsById.get(id));
  }
}

async function deletePhoto(id) {
  if (deleting.has(id)) return;
  if (!window.confirm("Delete this photo? It will disappear from the public site immediately.")) return;
  deleting.add(id);
  try {
    await deleteDoc(doc(db, "gallery", id));
    toast("Photo deleted.");
  } catch (error) {
    console.error("Delete failed:", error);
    toast(`Couldn't delete that photo: ${friendlyError(error)}`, "error");
  } finally {
    deleting.delete(id);
  }
}

// ---------- Full-size viewer ----------
function openViewer(id) {
  const d = docsById.get(id);
  if (!d || typeof d.imageData !== "string" || !DATA_IMAGE.test(d.imageData)) return;
  const text = String(d.caption || "").trim();
  viewerImg.src = d.imageData;
  viewerImg.alt = text || "Project photo";
  viewerCaption.textContent = text;
  viewerCaption.hidden = !text;
  if (typeof viewer.showModal === "function") viewer.showModal();
  else viewer.setAttribute("open", "");
}
function closeViewer() {
  if (typeof viewer.close === "function") viewer.close();
  else viewer.removeAttribute("open");
}
viewer.addEventListener("close", () => viewerImg.removeAttribute("src"));
$("viewer-close").addEventListener("click", closeViewer);
viewer.addEventListener("click", (e) => {
  if (e.target === viewer) closeViewer(); // tap outside the photo
});

// ---------- Adding photos: pick, review, post ----------
function stageFiles(fileList) {
  const files = Array.from(fileList || []);
  // Reset the input so picking the very same photo again (after removing it) still fires "change".
  fileInput.value = "";
  if (!files.length) return;

  const skipped = [];
  let added = 0;
  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      skipped.push(`${file.name}: only JPG, PNG or WebP photos can be added.`);
    } else if (file.size > MAX_INPUT_BYTES) {
      skipped.push(`${file.name}: too large to process (max 20 MB).`);
    } else {
      addPending(file);
      added += 1;
    }
  }
  if (skipped.length === 1) toast(skipped[0], "error");
  else if (skipped.length > 1) toast(`${skipped.length} files were skipped. Only JPG, PNG or WebP photos under 20 MB can be added.`, "error");

  renderStagingChrome();
  if (added) stagingArea.scrollIntoView({ behavior: "smooth", block: "start" });
}

function addPending(file) {
  const p = { pid: ++pendingSeq, file, previewUrl: URL.createObjectURL(file), caption: "", featured: false, category: DEFAULT_CATEGORY };
  buildStagingRow(p);
  pending.push(p);
  stagingList.append(p.row);
}

function buildStagingRow(p) {
  const name = p.file.name;
  const thumb = el("div", { class: "s-thumb" }, el("img", { src: p.previewUrl, alt: "" }));
  const fileInfo = el("div", { class: "s-file" }, el("span", { class: "s-name", text: name }), el("span", { class: "s-size", text: formatFileSize(p.file.size) }));
  const remove = el("button", { type: "button", class: "s-remove", "aria-label": `Remove ${name}`, onclick: () => removePending(p) }, icon("x"));

  const counter = el("span", { class: "s-counter", text: `0/${MAX_CAPTION}` });
  const textarea = el("textarea", {
    class: "s-caption",
    maxlength: MAX_CAPTION,
    rows: 3,
    autocomplete: "off",
    placeholder: "Describe the job (optional), e.g. Bathroom pipe replacement, Lekki",
  });
  textarea.addEventListener("input", () => {
    p.caption = textarea.value;
    counter.textContent = `${textarea.value.length}/${MAX_CAPTION}`;
    counter.classList.toggle("near-limit", textarea.value.length >= MAX_CAPTION * 0.9);
  });
  const desc = el("label", { class: "s-desc" }, el("span", { class: "visually-hidden", text: `Description for ${name} (optional)` }), textarea, counter);

  const radios = CATEGORIES.map((c) => {
    const input = el("input", { type: "radio", name: `scat-${p.pid}`, value: c.id });
    input.checked = c.id === p.category;
    input.addEventListener("change", () => {
      if (input.checked) p.category = c.id;
    });
    return { id: c.id, input, label: el("label", { class: "seg-opt" }, input, el("span", { text: c.label })) };
  });
  const cat = el("div", { class: "seg s-cat", role: "radiogroup", "aria-label": `Category for ${name}` }, radios.map((r) => r.label));

  const featuredInput = el("input", { type: "checkbox" });
  featuredInput.addEventListener("change", () => {
    p.featured = featuredInput.checked;
  });
  const home = el("label", { class: "s-home" }, featuredInput, el("span", { text: "Show on homepage" }));
  const error = el("p", { class: "s-error", role: "alert", hidden: true });

  p.radios = radios;
  p.errorEl = error;
  p.row = el("li", { class: "s-row" }, thumb, fileInfo, remove, desc, cat, home, error);
}

function setRowError(p, message) {
  p.errorEl.textContent = message;
  p.errorEl.hidden = !message;
}

function removePending(p) {
  if (busy) return;
  URL.revokeObjectURL(p.previewUrl);
  p.row.remove();
  pending = pending.filter((x) => x !== p);
  renderStagingChrome();
}

function clearStaging() {
  if (busy) return;
  pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
  pending = [];
  stagingList.replaceChildren();
  renderStagingChrome();
}

function renderStagingChrome() {
  const n = pending.length;
  stagingArea.hidden = n === 0;
  document.body.classList.toggle("has-staging", n > 0);
  if (!n) return;
  stagingHeadline.textContent = n === 1 ? "1 photo ready to post" : `${n} photos ready to post`;
  stagingMeta.textContent = `${formatFileSize(pending.reduce((sum, p) => sum + p.file.size, 0))} total`;
  stagingConfirmBtn.textContent = n === 1 ? "Post photo" : `Post ${n} photos`;
  stagingBulk.hidden = n < 2;
}

document.querySelectorAll("[data-bulk]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const next = btn.dataset.bulk;
    pending.forEach((p) => {
      p.category = next;
      p.radios.forEach((r) => {
        r.input.checked = r.id === next;
      });
    });
    toast(`All ${pending.length} photos set to “${labelOf(next)}”.`);
  })
);

function setBusy(on) {
  busy = on;
  stagingArea.classList.toggle("is-busy", on);
  stagingConfirmBtn.disabled = on;
  stagingCancelBtn.disabled = on;
  fileInput.disabled = on;
  uploadLabel.classList.toggle("disabled", on);
  if (!on) {
    progressWrap.hidden = true;
    progressFill.style.width = "0%";
  }
}

function setProgress(label, pct) {
  progressWrap.hidden = false;
  progressLabel.textContent = label;
  progressFill.style.width = `${Math.round(pct)}%`;
}

// ---------- Compression ----------
// Re-encodes the photo, shrinking quality first, then dimensions, until it fits MAX_RAW_BYTES.
// Bounded at 8 attempts so this can never hang.
async function compressToFit(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    throw Object.assign(new Error("unreadable"), { code: "unreadable" });
  }
  try {
    let dimension = 1600;
    let quality = 0.82;
    let blob = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const scale = Math.min(1, dimension / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      canvas.width = canvas.height = 0; // hand the canvas memory back right away (matters on phones)
      if (blob && blob.size <= MAX_RAW_BYTES) return blob;
      if (quality > 0.5) {
        quality = Math.max(0.5, quality - 0.1);
      } else if (dimension > 500) {
        dimension = Math.max(500, Math.round(dimension * 0.8));
        quality = 0.7;
      }
    }
    return blob; // best effort after 8 attempts
  } finally {
    if (bitmap.close) bitmap.close(); // the decoded photo can be ~50 MB of memory; the old code never freed it
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Races a promise against a timer so a slow connection can never leave the UI frozen on "Saving...".
// This only stops the client from *waiting* -- it can't cancel the request already in flight, so on a
// very slow connection the photo can still appear moments later. The live list reflects reality either way.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "client-timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function uploadErrorText(error) {
  switch (error?.code) {
    case "unreadable":
      return "This file couldn't be read as a photo. Try a different one.";
    case "too-detailed":
      return "This photo is too detailed to shrink small enough. Crop it or try another.";
    case "client-timeout":
      return "This is taking too long on your connection. It may still post, so check the list below before trying again.";
    default:
      return `Not posted: ${friendlyError(error)}`;
  }
}

// ---------- Upload ----------
// Photos that post successfully leave the review list. Any that fail STAY there, with their
// description and category intact and a red note, so one tap on Post retries just those.
async function uploadStaged() {
  if (busy || !pending.length) return;
  setBusy(true);
  const queue = [...pending];
  let posted = 0;
  let failed = 0;

  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    setRowError(p, "");
    const step = (label, fraction) => setProgress(`Photo ${i + 1} of ${queue.length}: ${label}`, ((i + fraction) / queue.length) * 100);
    try {
      step("shrinking…", 0.1);
      const blob = await compressToFit(p.file);
      if (!blob || blob.size > MAX_RAW_BYTES) throw Object.assign(new Error("too-detailed"), { code: "too-detailed" });

      step("preparing…", 0.5);
      const dataUrl = await blobToDataURL(blob);

      step("saving…", 0.7);
      const caption = p.caption.trim().slice(0, MAX_CAPTION);
      await withTimeout(
        addDoc(collection(db, "gallery"), {
          imageData: dataUrl,
          caption,
          alt: caption || DEFAULT_ALT,
          sizeBytes: blob.size,
          order: Date.now(),
          featured: p.featured === true,
          category: p.category === "in-progress" ? "in-progress" : DEFAULT_CATEGORY,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        25000
      );

      posted += 1;
      URL.revokeObjectURL(p.previewUrl);
      p.row.remove();
      pending = pending.filter((x) => x !== p);
    } catch (error) {
      failed += 1;
      console.error("Upload failed:", error);
      setRowError(p, uploadErrorText(error));
    }
  }

  setBusy(false);
  renderStagingChrome();

  if (posted) {
    filter = "all"; // make sure the new photos are visible
    layout();
  }
  if (!failed) {
    toast(posted === 1 ? "Photo posted. It's live on Recent Work." : `${posted} photos posted. They're live on Recent Work.`);
    library.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    const first = pending.find((p) => !p.errorEl.hidden);
    toast(`${posted} posted, ${failed} didn't go through. See the red notes below.`, "error");
    if (first) first.row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

stagingConfirmBtn.addEventListener("click", uploadStaged);
stagingCancelBtn.addEventListener("click", clearStaging);
fileInput.addEventListener("change", (e) => stageFiles(e.target.files));

// Don't lose typed descriptions (or an upload in progress) to an accidental back-swipe.
window.addEventListener("beforeunload", (e) => {
  if (busy || pending.length) {
    e.preventDefault();
    e.returnValue = "";
  }
});
