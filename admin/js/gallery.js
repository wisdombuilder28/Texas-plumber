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
const MAX_INPUT_BYTES = 20 * 1024 * 1024;               // sanity ceiling on what we'll even try to process
const MAX_ENCODED_BYTES = 700 * 1024;                    // final base64 string budget
const MAX_RAW_BYTES = Math.floor((MAX_ENCODED_BYTES * 3) / 4); // ~525KB of image bytes before base64 inflates it ~33%
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const grid = document.getElementById("gallery-grid-admin");
const emptyState = document.getElementById("gallery-empty");
const messageEl = document.getElementById("gallery-message");
const progressWrap = document.getElementById("upload-progress");
const progressLabel = document.getElementById("upload-progress-label");
const progressFill = document.getElementById("upload-progress-fill");
const fileInput = document.getElementById("gallery-input");

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
// No Storage file to clean up anymore -- the photo lives inside the Firestore
// document itself, so deleting the document deletes the photo. One call, done.
async function deletePhoto(id, btn) {
  if (!window.confirm("Delete this photo? It will disappear from the public site immediately.")) return;
  btn.disabled = true;
  try {
    await deleteDoc(doc(db, "gallery", id));
    showMessage("Photo deleted.", "success");
  } catch (error) {
    console.error("Delete failed:", error);
    showMessage("Couldn't delete that photo. Please try again.");
    btn.disabled = false;
  }
}

// ---------- Compression ----------
// Iteratively re-encodes the photo, shrinking quality first, then dimensions, until
// it fits MAX_RAW_BYTES. Real phone photos usually converge in 1-2 passes; the loop
// is the safety net for the rare very-detailed image that doesn't compress easily.
// Bounded at 8 attempts so this can never hang.
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

// ---------- Upload ----------
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  messageEl.hidden = true;

  for (let i = 0; i < files.length; i++) {
    const original = files[i];
    const label = `(${i + 1}/${files.length}) ${original.name}`;

    if (!ALLOWED_TYPES.includes(original.type)) {
      showMessage(`${original.name}: only JPG, PNG, or WebP images are allowed.`);
      continue;
    }
    if (original.size > MAX_INPUT_BYTES) {
      showMessage(`${original.name}: that file is too large to process (max 20MB).`);
      continue;
    }

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
      await addDoc(collection(db, "gallery"), {
        imageData: dataUrl,
        alt: "N.D. Flow Plumbing Co. completed project",
        sizeBytes: compressed.size,
        order: Date.now(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setProgress(`Saved ${label}`, 100);
    } catch (error) {
      console.error("Upload failed:", error);
      showMessage(`${original.name}: upload failed. Check your connection and try again.`);
    }
  }

  hideProgress();
  fileInput.value = "";
  if (messageEl.hidden) showMessage("Upload complete. The public gallery updates automatically.", "success");
}

fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
