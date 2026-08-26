// admin/js/gallery.js
import { db } from "../../firebase-config.js";
import { requireAuth, wireLogout, wireSidebar } from "./auth-guard.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

wireSidebar();
wireLogout("logout-btn");
if (window.lucide) lucide.createIcons();

requireAuth((user) => {
  document.getElementById("admin-email").textContent = user.email;
  startGalleryListener();
});

// Photos are stored as base64 image data directly inside each Firestore document --
// no Firebase Storage, no billing account needed. Firestore caps a document at 1 MiB
// total, so the encoded image has to stay comfortably under that. These numbers match
// the check in firestore.rules, so anything rejected here would be rejected there too.
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_BYTES = 700 * 1024;
const MAX_RAW_BYTES = Math.floor((MAX_ENCODED_BYTES * 3) / 4);
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DEFAULT_ALT = "N.D. Flow Plumbing Co. completed project";

const grid = document.getElementById("gallery-grid-admin");
const emptyState = document.getElementById("gallery-empty");
const messageEl = document.getElementById("gallery-message");
const progressWrap = document.getElementById("upload-progress");
const progressLabel = document.getElementById("upload-progress-label");
const progressFill = document.getElementById("upload-progress-fill");
const fileInput = document.getElementById("gallery-input");
const uploadLabel = document.querySelector(".upload-label");
const stagingArea = document.getElementById("staging-area");
const stagingHeadline = document.getElementById("staging-headline");
const stagingMeta = document.getElementById("staging-meta");
const stagingList = document.getElementById("staging-list");
const stagingCount = document.getElementById("staging-count");
const stagingCancelBtn = document.getElementById("staging-cancel");
const stagingConfirmBtn = document.getElementById("staging-confirm");

// Files the admin has picked but not yet confirmed -- { file, previewUrl, caption }
let pending = [];

function showMessage(text, kind = "error") {
  messageEl.textContent = text;
  messageEl.hidden = false;
  messageEl.className = `form-message ${kind}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setProgress(label, pct) {
  progressWrap.hidden = false;
  progressLabel.textContent = label;
  progressFill.style.width = `${pct}%`;
}

function hideProgress() {
  progressWrap.hidden = true;
  progressFill.style.width = "0%";
}

// ---------- Live gallery list ----------
function startGalleryListener() {
  const galleryQuery = query(collection(db, "gallery"), orderBy("order", "desc"));
  onSnapshot(
    galleryQuery,
    (snapshot) => renderGrid(snapshot),
    (error) => {
      console.error("Gallery listener failed:", error);
      showMessage("Couldn't load the gallery. Check your connection and refresh.");
    }
  );
}

function renderGrid(snapshot) {
  if (snapshot.empty) {
    grid.innerHTML = "";
    emptyState.hidden = false;
    if (window.lucide) lucide.createIcons();
    return;
  }
  emptyState.hidden = true;
  grid.innerHTML = snapshot.docs
    .map((docSnap) => {
      const d = docSnap.data();
      return `
      <figure class="gallery-admin-item">
        <img src="${escapeHtml(d.imageData)}" alt="${escapeHtml(d.alt || "")}" loading="lazy" />
        ${d.caption ? `<figcaption>${escapeHtml(d.caption)}</figcaption>` : ""}
        <button type="button" class="btn-danger delete-btn" data-id="${docSnap.id}">
          <i data-lucide="trash-2" class="icon-sm"></i> Delete
        </button>
      </figure>`;
    })
    .join("");

  grid.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deletePhoto(btn.dataset.id, btn));
  });
  if (window.lucide) lucide.createIcons();
}

// ---------- Delete ----------
async function deletePhoto(id, btn) {
  if (!window.confirm("Delete this photo? It will disappear from the public site immediately.")) return;
  btn.disabled = true;
  try {
    await deleteDoc(doc(db, "gallery", id));
    showMessage("Photo deleted.", "success");
  } catch (error) {
    console.error("Delete failed:", error);
    showMessage(`Couldn't delete that photo: ${friendlyFirestoreError(error)}`);
    btn.disabled = false;
  }
}

// Turns a raw Firestore error into something specific enough to act on, instead
// of always saying "check your connection" when the real problem is something
// else entirely (like not being recognized as an admin yet).
function friendlyFirestoreError(error) {
  switch (error?.code) {
    case "permission-denied":
      return "blocked — this account isn't recognized as an admin yet (check the `admins` collection in Firebase Console)";
    case "unauthenticated":
      return "you've been signed out — refresh the page and log in again";
    case "unavailable":
    case "deadline-exceeded":
      return "network issue — check your connection and try again";
    default:
      return error?.code ? `failed (${error.code}) — try again` : "failed — try again";
  }
}

// ---------- Staging: pick photos, add optional captions, then confirm ----------
function stageFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  messageEl.hidden = true;

  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      showMessage(`${file.name}: only JPG, PNG, or WebP images are allowed.`);
      continue;
    }
    if (file.size > MAX_INPUT_BYTES) {
      showMessage(`${file.name}: that file is too large to process (max 20MB).`);
      continue;
    }
    pending.push({ file, previewUrl: URL.createObjectURL(file), caption: "" });
  }
  renderStaging();
}

function renderStaging() {
  if (!pending.length) {
    stagingArea.hidden = true;
    stagingList.innerHTML = "";
    return;
  }
  stagingArea.hidden = false;

  stagingHeadline.textContent = pending.length === 1
    ? "1 photo ready to post"
    : `${pending.length} photos ready to post`;
  const totalBytes = pending.reduce((sum, p) => sum + p.file.size, 0);
  stagingMeta.textContent = `${formatFileSize(totalBytes)} total`;
  stagingCount.textContent = pending.length;

  stagingList.innerHTML = pending
    .map(
      (p, i) => `
      <div class="staging-item">
        <div class="staging-media-wrap">
          <img src="${p.previewUrl}" alt="" class="staging-media" />
          <button type="button" class="staging-remove" data-index="${i}" aria-label="Remove photo">
            <i data-lucide="x" class="icon-sm"></i>
          </button>
        </div>
        <div class="staging-file-info">
          <i data-lucide="image" class="icon-sm"></i>
          <span>${escapeHtml(p.file.name)}</span>
          <span class="staging-file-size">${formatFileSize(p.file.size)}</span>
        </div>
        <div class="staging-desc-field">
          <label for="staging-caption-${i}">
            <span>Description (optional)</span>
            <span class="staging-counter" id="staging-counter-${i}">${p.caption.length}/140</span>
          </label>
          <textarea id="staging-caption-${i}" class="staging-caption-input" data-index="${i}" maxlength="140"
            autocomplete="off" autocorrect="off" spellcheck="false"
            placeholder="e.g. Bathroom pipe replacement — Lekki">${escapeHtml(p.caption)}</textarea>
        </div>
      </div>`
    )
    .join("");

  stagingList.querySelectorAll(".staging-caption-input").forEach((textarea) => {
    textarea.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.index);
      pending[i].caption = e.target.value;
      const counter = document.getElementById(`staging-counter-${i}`);
      counter.textContent = `${e.target.value.length}/140`;
      counter.classList.toggle("near-limit", e.target.value.length >= 120);
    });
  });
  stagingList.querySelectorAll(".staging-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.index);
      URL.revokeObjectURL(pending[i].previewUrl);
      pending.splice(i, 1);
      renderStaging();
    });
  });
  if (window.lucide) lucide.createIcons();
}

function clearStaging() {
  pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
  pending = [];
  renderStaging();
}

stagingCancelBtn.addEventListener("click", clearStaging);

// ---------- Compression ----------
// Iteratively re-encodes the photo, shrinking quality first, then dimensions, until
// it fits MAX_RAW_BYTES. Bounded at 8 attempts so this can never hang.
async function compressToFit(file) {
  const bitmap = await createImageBitmap(file);
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
    if (blob && blob.size <= MAX_RAW_BYTES) return blob;

    if (quality > 0.5) {
      quality = Math.max(0.5, quality - 0.1);
    } else if (dimension > 500) {
      dimension = Math.max(500, Math.round(dimension * 0.8));
      quality = 0.7;
    }
  }
  return blob; // best effort after 8 attempts
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Races a promise against a timer so a slow connection can never leave the UI
// frozen on "Saving..." with no feedback. Note this only stops the client from
// *waiting* -- it can't cancel the network request already in flight, so on a
// very slow connection the photo can still appear moments later even after a
// timeout message shows. The live gallery listener reflects reality either way.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "client-timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Upload (runs on the confirmed staged files) ----------
async function uploadStaged() {
  if (!pending.length) return;
  const items = pending.splice(0);
  renderStaging(); // staging area closes immediately; the progress bar takes over

  fileInput.disabled = true;
  uploadLabel.classList.add("disabled");

  for (let i = 0; i < items.length; i++) {
    const { file: original, previewUrl, caption } = items[i];
    const label = `(${i + 1}/${items.length}) ${original.name}`;
    const trimmedCaption = caption.trim();

    try {
      setProgress(`Compressing ${label}…`, 30);
      const compressed = await compressToFit(original);

      if (!compressed || compressed.size > MAX_RAW_BYTES) {
        showMessage(`${original.name}: too detailed to shrink small enough. Try a simpler photo or crop it first.`);
        continue;
      }

      setProgress(`Encoding ${label}…`, 65);
      const dataUrl = await blobToDataURL(compressed);

      setProgress(`Saving ${label}…`, 90);
      await withTimeout(
        addDoc(collection(db, "gallery"), {
          imageData: dataUrl,
          caption: trimmedCaption,
          alt: trimmedCaption || DEFAULT_ALT,
          sizeBytes: compressed.size,
          order: Date.now(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        25000
      );

      setProgress(`Saved ${label}`, 100);
    } catch (error) {
      console.error("Upload failed:", error);
      if (error?.code === "client-timeout") {
        showMessage(`${original.name}: this is taking too long on the current connection. It may still finish in the background — check the gallery below in a moment before retrying.`);
      } else {
        showMessage(`${original.name}: ${friendlyFirestoreError(error)}`);
      }
    } finally {
      URL.revokeObjectURL(previewUrl);
    }
  }

  hideProgress();
  fileInput.disabled = false;
  uploadLabel.classList.remove("disabled");
  fileInput.value = "";
  if (messageEl.hidden) showMessage("Upload complete. The public gallery updates automatically.", "success");
}

stagingConfirmBtn.addEventListener("click", uploadStaged);
fileInput.addEventListener("change", (e) => stageFiles(e.target.files));
