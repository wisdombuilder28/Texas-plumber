// admin/js/gallery.js
import { db, storage } from "../../firebase-config.js";
import { requireAuth, wireLogout, wireSidebar } from "./auth-guard.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-storage.js";

wireSidebar();
wireLogout("logout-btn");
if (window.lucide) lucide.createIcons();

requireAuth((user) => {
  document.getElementById("admin-email").textContent = user.email;
  startGalleryListener();
});

const MAX_FILE_BYTES = 8 * 1024 * 1024; // must match storage.rules
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
        <img src="${escapeHtml(d.url)}" alt="${escapeHtml(d.alt || "")}" loading="lazy" />
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
    const docRef = doc(db, "gallery", id);
    const snap = await getDoc(docRef);
    const data = snap.data();
    if (data?.storagePath) {
      try {
        await deleteObject(ref(storage, data.storagePath));
      } catch (storageErr) {
        // File already gone from Storage for some reason — still remove the record.
        console.warn("Storage file missing, removing record anyway:", storageErr);
      }
    }
    await deleteDoc(docRef);
    showMessage("Photo deleted.", "success");
  } catch (error) {
    console.error("Delete failed:", error);
    showMessage("Couldn't delete that photo. Please try again.");
    btn.disabled = false;
  }
}

// ---------- Compression (shrinks typical phone photos before upload) ----------
async function compressImage(file, { maxDimension = 2000, quality = 0.82 } = {}) {
  if (file.size < 400 * 1024) return file; // already small, not worth touching
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file; // compression didn't help — keep original
    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } catch (error) {
    console.warn("Compression skipped, uploading original:", error);
    return file;
  }
}

// ---------- Upload ----------
function uploadOne(file, path, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), file, { contentType: file.type });
    task.on(
      "state_changed",
      (snap) => onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      reject,
      () => resolve(task.snapshot)
    );
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  messageEl.hidden = true;

  for (let i = 0; i < files.length; i++) {
    let file = files[i];
    const label = `(${i + 1}/${files.length}) ${file.name}`;

    if (!ALLOWED_TYPES.includes(file.type)) {
      showMessage(`${file.name}: only JPG, PNG, or WebP images are allowed.`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      showMessage(`${file.name}: that photo is too large (max 8MB).`);
      continue;
    }

    try {
      setProgress(`Preparing ${label}…`, 0);
      file = await compressImage(file);

      const safeName = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      const storagePath = `gallery/${Date.now()}-${crypto.randomUUID()}-${safeName}`;

      await uploadOne(file, storagePath, (pct) => setProgress(`Uploading ${label}`, pct));

      const url = await getDownloadURL(ref(storage, storagePath));
      await addDoc(collection(db, "gallery"), {
        url,
        storagePath,
        alt: "N.D. Flow Plumbing Co. completed project",
        contentType: file.type,
        size: file.size,
        order: Date.now(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("Upload failed:", error);
      showMessage(`${file.name}: upload failed. Check your connection and try again.`);
    }
  }

  hideProgress();
  fileInput.value = "";
  if (messageEl.hidden) showMessage("Upload complete. The public gallery updates automatically.", "success");
}

fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
