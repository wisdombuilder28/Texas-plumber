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
  getDocs,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

wireSidebar();
wireLogout("logout-btn");
if (window.lucide) lucide.createIcons();

requireAuth(async (user) => {
  document.getElementById("admin-email").textContent = user.email;
  startCategoryListener();
  startGalleryListener();
  await ensureDefaultCategories();
});

// Photos are stored as base64 image data directly inside each Firestore document.
// Firestore caps a document at 1 MiB total, so the encoded image has to stay
// comfortably under that limit.
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_BYTES = 700 * 1024;
const MAX_RAW_BYTES = Math.floor((MAX_ENCODED_BYTES * 3) / 4);
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DEFAULT_ALT = "N.D. Flow Plumbing Co. completed project";

// Category documents live in /categories. The two defaults are automatically
// created the first time an authorised admin opens this page. Existing gallery
// documents that only have the legacy `category` field continue to work.
const DEFAULT_CATEGORIES = [
  { id: "completed", label: "Completed", order: 1 },
  { id: "in-progress", label: "Still working", order: 2 },
];
const DEFAULT_CATEGORY = "completed";

let categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
let categoryMap = new Map(categories.map((c) => [c.id, c]));

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
const categoryList = document.getElementById("category-list");
const categoryEmpty = document.getElementById("category-empty");
const categoryForm = document.getElementById("category-form");
const categoryNameInput = document.getElementById("category-name");
const adminFilterBar = document.getElementById("admin-filter-bar");

// Files the admin has picked but not yet confirmed --
// { file, previewUrl, caption, featured, category }
let pending = [];
let lastDocs = [];
let adminFilter = "all";

function rebuildCategoryMap() {
  categoryMap = new Map(categories.map((c) => [c.id, c]));
}

function sortedCategories() {
  return categories.slice().sort((a, b) => {
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    if (orderDiff !== 0) return orderDiff;
    return a.label.localeCompare(b.label);
  });
}

function categoryOf(data) {
  const candidate = String(data?.categoryId || data?.category || "").trim();
  return categoryMap.has(candidate) ? candidate : DEFAULT_CATEGORY;
}

function categoryLabel(id) {
  return categoryMap.get(id)?.label || DEFAULT_CATEGORIES.find((c) => c.id === id)?.label || humanizeCategoryId(id);
}

function humanizeCategoryId(id) {
  const value = String(id || "").replace(/[-_]+/g, " ").trim();
  if (!value) return "Completed";
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function showMessage(text, kind = "error") {
  messageEl.textContent = text;
  messageEl.hidden = false;
  messageEl.className = `form-message ${kind}`;
}

function clearMessage() {
  messageEl.hidden = true;
  messageEl.textContent = "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
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

// ---------- Categories ----------
async function ensureDefaultCategories() {
  try {
    const snapshot = await getDocs(collection(db, "categories"));
    const existingIds = new Set(snapshot.docs.map((docSnap) => docSnap.id));
    const missing = DEFAULT_CATEGORIES.filter((category) => !existingIds.has(category.id));

    if (!missing.length) return;

    await Promise.all(
      missing.map((category) =>
        setDoc(doc(db, "categories", category.id), {
          name: category.label,
          order: category.order,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      )
    );
  } catch (error) {
    console.error("Default category setup failed:", error);
    if (error?.code === "permission-denied") {
      showMessage("Category setup is blocked. Make sure this account is an admin and publish the latest firestore.rules.");
    }
  }
}

function startCategoryListener() {
  onSnapshot(
    collection(db, "categories"),
    (snapshot) => {
      const next = snapshot.docs
        .map((docSnap) => {
          const data = docSnap.data();
          const label = String(data.name || "").trim();
          return {
            id: docSnap.id,
            label: label || humanizeCategoryId(docSnap.id),
            order: Number.isFinite(data.order) ? data.order : 999,
          };
        })
        .filter((category) => category.id !== "all")
        .sort((a, b) => {
          const orderDiff = a.order - b.order;
          return orderDiff || a.label.localeCompare(b.label);
        });

      categories = next.length ? next : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      rebuildCategoryMap();

      if (!categoryMap.has(adminFilter) && adminFilter !== "all") {
        adminFilter = "all";
      }

      paintAdminFilters();
      paintCategoryManager();
      paintAdminGrid();
      if (pending.length) renderStaging();
    },
    (error) => {
      console.error("Category listener failed:", error);
      // Keep the built-in defaults as a graceful fallback so the existing
      // gallery remains usable even if category loading is temporarily down.
      showMessage("Couldn’t load custom categories. Using the default categories for now.");
    }
  );
}

function paintAdminFilters() {
  if (!adminFilterBar) return;
  const allCount = lastDocs.length;
  const buttons = [
    `<button type="button" class="admin-filter-btn ${adminFilter === "all" ? "is-active" : ""}" data-admin-filter="all" role="tab" aria-selected="${adminFilter === "all" ? "true" : "false"}>All <span class="filter-count">${allCount}</span></button>`,
    ...sortedCategories().map((category) => {
      const count = lastDocs.filter((docSnap) => categoryOf(docSnap.data()) === category.id).length;
      const active = adminFilter === category.id;
      return `<button type="button" class="admin-filter-btn ${active ? "is-active" : ""}" data-admin-filter="${escapeHtml(category.id)}" role="tab" aria-selected="${active ? "true" : "false"}>${escapeHtml(category.label)} <span class="filter-count">${count}</span></button>`;
    }),
  ];
  adminFilterBar.innerHTML = buttons.join("");

  adminFilterBar.querySelectorAll("[data-admin-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      adminFilter = btn.dataset.adminFilter || "all";
      paintAdminFilters();
      paintAdminGrid();
    });
  });
}

function paintCategoryManager() {
  if (!categoryList) return;

  const counts = new Map();
  lastDocs.forEach((docSnap) => {
    const id = categoryOf(docSnap.data());
    counts.set(id, (counts.get(id) || 0) + 1);
  });

  const list = sortedCategories();
  categoryEmpty.hidden = Boolean(list.length);
  categoryList.innerHTML = list.map((category) => {
    const count = counts.get(category.id) || 0;
    return `
      <div class="category-manager-row" data-category-id="${escapeHtml(category.id)}">
        <div class="category-manager-main">
          <input type="text" class="category-name-input" value="${escapeHtml(category.label)}" maxlength="40" aria-label="Category name" />
          <span class="category-item-count">${count} ${count === 1 ? "item" : "items"}</span>
        </div>
        <div class="category-manager-actions">
          <button type="button" class="category-save-btn btn-ghost-dark" data-id="${escapeHtml(category.id)}">Save</button>
          <button type="button" class="category-delete-btn btn-danger" data-id="${escapeHtml(category.id)}">Delete</button>
        </div>
      </div>`;
  }).join("");

  categoryList.querySelectorAll(".category-save-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".category-manager-row");
      const input = row?.querySelector(".category-name-input");
      if (input) renameCategory(btn.dataset.id, input.value, btn, input);
    });
  });

  categoryList.querySelectorAll(".category-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteCategory(btn.dataset.id, btn));
  });

  if (window.lucide) lucide.createIcons();
}

function normaliseCategoryName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function slugifyCategory(value) {
  const slug = normaliseCategoryName(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return slug || "category";
}

async function addCategory(event) {
  event.preventDefault();
  clearMessage();
  const label = normaliseCategoryName(categoryNameInput?.value);
  if (label.length < 2) {
    showMessage("Category name must be at least 2 characters.");
    return;
  }
  if (label.length > 40) {
    showMessage("Category name must be 40 characters or fewer.");
    return;
  }
  if (label.toLowerCase() === "all") {
    showMessage('“All” is reserved for the public filter and cannot be a category name.');
    return;
  }

  const duplicateName = categories.some((category) => category.label.toLowerCase() === label.toLowerCase());
  if (duplicateName) {
    showMessage("That category already exists.");
    return;
  }

  const baseId = slugifyCategory(label);
  let id = baseId;
  let suffix = 2;
  while (categoryMap.has(id) || id === "all") {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  const maxOrder = categories.reduce((max, category) => Math.max(max, Number(category.order) || 0), 0);
  const submitBtn = categoryForm?.querySelector("button[type=submit]");
  if (submitBtn) submitBtn.disabled = true;

  try {
    await setDoc(doc(db, "categories", id), {
      name: label,
      order: maxOrder + 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    categoryNameInput.value = "";
    showMessage(`“${label}” added.`, "success");
  } catch (error) {
    console.error("Category create failed:", error);
    showMessage(`Couldn't create the category: ${friendlyFirestoreError(error)}`);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function renameCategory(id, nextLabel, btn, input) {
  const category = categoryMap.get(id);
  if (!category) return;
  const label = normaliseCategoryName(nextLabel);
  if (label.length < 2 || label.length > 40) {
    showMessage("Category name must be between 2 and 40 characters.");
    if (input) input.value = category.label;
    return;
  }
  if (label.toLowerCase() === "all") {
    showMessage('“All” is reserved for the public filter and cannot be a category name.');
    if (input) input.value = category.label;
    return;
  }

  const duplicate = categories.some(
    (candidate) => candidate.id !== id && candidate.label.toLowerCase() === label.toLowerCase()
  );
  if (duplicate) {
    showMessage("Another category already uses that name.");
    if (input) input.value = category.label;
    return;
  }
  if (label === category.label) {
    showMessage("No name change was made.", "success");
    return;
  }

  btn.disabled = true;
  try {
    await updateDoc(doc(db, "categories", id), {
      name: label,
      updatedAt: serverTimestamp(),
    });
    showMessage(`Category renamed to “${label}”.`, "success");
  } catch (error) {
    console.error("Category rename failed:", error);
    showMessage(`Couldn't rename the category: ${friendlyFirestoreError(error)}`);
    if (input) input.value = category.label;
  } finally {
    btn.disabled = false;
  }
}

async function deleteCategory(id, btn) {
  const category = categoryMap.get(id);
  if (!category) return;
  const inUse = lastDocs.filter((docSnap) => categoryOf(docSnap.data()) === id).length;
  if (inUse > 0) {
    showMessage(`“${category.label}” contains ${inUse} ${inUse === 1 ? "media item" : "media items"}. Reassign those items before deleting this category.`);
    return;
  }

  if (id === DEFAULT_CATEGORY || id === "in-progress") {
    const ok = window.confirm(`Delete the default category “${category.label}”? It can be recreated later, but keeping the standard categories is usually safer.`);
    if (!ok) return;
  } else if (!window.confirm(`Delete the category “${category.label}”?`)) {
    return;
  }

  btn.disabled = true;
  try {
    await deleteDoc(doc(db, "categories", id));
    if (adminFilter === id) adminFilter = "all";
    showMessage(`Category “${category.label}” deleted.`, "success");
  } catch (error) {
    console.error("Category delete failed:", error);
    showMessage(`Couldn't delete the category: ${friendlyFirestoreError(error)}`);
    btn.disabled = false;
  }
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
  lastDocs = snapshot.docs;
  paintAdminFilters();
  paintCategoryManager();
  paintAdminGrid();
}

function categoryOptionsHtml(selected) {
  return sortedCategories().map(
    (category) => `<option value="${escapeHtml(category.id)}" ${category.id === selected ? "selected" : ""}>${escapeHtml(category.label)}</option>`
  ).join("");
}

function paintAdminGrid() {
  const docs = lastDocs.filter((docSnap) => {
    if (adminFilter === "all") return true;
    return categoryOf(docSnap.data()) === adminFilter;
  });

  if (!lastDocs.length) {
    grid.innerHTML = "";
    emptyState.hidden = false;
    emptyState.querySelector("p").textContent = 'No photos yet. Tap "Upload photos" above to add your first one.';
    if (window.lucide) lucide.createIcons();
    return;
  }

  if (!docs.length) {
    grid.innerHTML = "";
    emptyState.hidden = false;
    emptyState.querySelector("p").textContent = "No photos in this category yet.";
    if (window.lucide) lucide.createIcons();
    return;
  }

  emptyState.hidden = true;
  grid.innerHTML = docs
    .map((docSnap) => {
      const d = docSnap.data();
      const featured = d.featured === true;
      const category = categoryOf(d);
      return `
      <figure class="gallery-admin-item${featured ? " is-featured" : ""}">
        <img src="${escapeHtml(d.imageData)}" alt="${escapeHtml(d.alt || "")}" loading="lazy" />
        <span class="cat-badge">${escapeHtml(categoryLabel(category))}</span>
        ${d.caption ? `<figcaption>${escapeHtml(d.caption)}</figcaption>` : ""}
        <button type="button" class="feature-btn" data-id="${docSnap.id}" data-featured="${featured ? "1" : "0"}" aria-pressed="${featured ? "true" : "false"}">
          <i data-lucide="star" class="icon-sm"></i>
          ${featured ? "On homepage" : "Show on homepage"}
        </button>
        <label class="category-select-wrap">
          <span class="visually-hidden">Category</span>
          <select class="category-select" data-id="${docSnap.id}" aria-label="Category">
            ${categoryOptionsHtml(category)}
          </select>
        </label>
        <button type="button" class="btn-danger delete-btn" data-id="${docSnap.id}">
          <i data-lucide="trash-2" class="icon-sm"></i> Delete
        </button>
      </figure>`;
    })
    .join("");

  grid.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deletePhoto(btn.dataset.id, btn));
  });
  grid.querySelectorAll(".feature-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleFeatured(btn.dataset.id, btn.dataset.featured === "1", btn);
    });
  });
  grid.querySelectorAll(".category-select").forEach((select) => {
    select.addEventListener("change", () => setCategory(select.dataset.id, select.value, select));
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

async function setCategory(id, category, select) {
  const next = categoryMap.has(category) ? category : DEFAULT_CATEGORY;
  select.disabled = true;
  try {
    await updateDoc(doc(db, "gallery", id), {
      categoryId: next,
      category: next,
      updatedAt: serverTimestamp(),
    });
    showMessage(`Moved to “${categoryLabel(next)}”.`, "success");
  } catch (error) {
    console.error("Category update failed:", error);
    showMessage(`Couldn't update category: ${friendlyFirestoreError(error)}`);
    select.disabled = false;
  }
}

async function toggleFeatured(id, currentlyFeatured, btn) {
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "gallery", id), {
      featured: !currentlyFeatured,
      updatedAt: serverTimestamp(),
    });
    showMessage(
      currentlyFeatured ? "Removed from the homepage. It stays in Recent Work." : "Now showing on the homepage.",
      "success"
    );
  } catch (error) {
    console.error("Featured toggle failed:", error);
    showMessage(`Couldn't update homepage status: ${friendlyFirestoreError(error)}`);
    btn.disabled = false;
  }
}

function friendlyFirestoreError(error) {
  switch (error?.code) {
    case "permission-denied":
      return "blocked — this account isn't recognised as an admin yet, or the latest Firestore rules haven't been published";
    case "unauthenticated":
      return "you've been signed out — refresh the page and log in again";
    case "unavailable":
    case "deadline-exceeded":
      return "network issue — check your connection and try again";
    default:
      return error?.code ? `failed (${error.code}) — try again` : "failed — try again";
  }
}

// ---------- Staging: pick photos, add optional captions, category and homepage flag ----------
function stageFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  clearMessage();

  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      showMessage(`${file.name}: only JPG, PNG, or WebP images are allowed.`);
      continue;
    }
    if (file.size > MAX_INPUT_BYTES) {
      showMessage(`${file.name}: that file is too large to process (max 20MB).`);
      continue;
    }
    pending.push({
      file,
      previewUrl: URL.createObjectURL(file),
      caption: "",
      featured: false,
      category: DEFAULT_CATEGORY,
    });
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
            <span class="staging-counter" id="staging-counter-${i}">${p.caption.length}/300</span>
          </label>
          <textarea id="staging-caption-${i}" class="staging-caption-input" data-index="${i}" maxlength="300"
            autocomplete="off" autocorrect="off" spellcheck="false"
            placeholder="e.g. Bathroom pipe replacement — Lekki">${escapeHtml(p.caption)}</textarea>
        </div>
        <label class="staging-featured">
          <input type="checkbox" class="staging-featured-input" data-index="${i}" ${p.featured ? "checked" : ""} />
          <span>Show on homepage</span>
        </label>
        <label class="staging-category-select-field">
          <span>Category</span>
          <select class="staging-category-select-input" data-index="${i}" aria-label="Category for ${escapeHtml(p.file.name)}">
            ${categoryOptionsHtml(p.category)}
          </select>
        </label>
      </div>`
    )
    .join("");

  stagingList.querySelectorAll(".staging-caption-input").forEach((textarea) => {
    textarea.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.index);
      pending[i].caption = e.target.value;
      const counter = document.getElementById(`staging-counter-${i}`);
      counter.textContent = `${e.target.value.length}/300`;
      counter.classList.toggle("near-limit", e.target.value.length >= 260);
    });
  });
  stagingList.querySelectorAll(".staging-featured-input").forEach((checkbox) => {
    checkbox.addEventListener("change", (e) => {
      const i = Number(e.target.dataset.index);
      pending[i].featured = e.target.checked;
    });
  });
  stagingList.querySelectorAll(".staging-category-select-input").forEach((select) => {
    select.addEventListener("change", (e) => {
      const i = Number(e.target.dataset.index);
      pending[i].category = categoryMap.has(e.target.value) ? e.target.value : DEFAULT_CATEGORY;
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
  return blob;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "client-timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Upload ----------
async function uploadStaged() {
  if (!pending.length) return;
  const items = pending.splice(0);
  renderStaging();

  fileInput.disabled = true;
  uploadLabel.classList.add("disabled");
  stagingConfirmBtn.disabled = true;

  for (let i = 0; i < items.length; i++) {
    const { file: original, previewUrl, caption, featured, category } = items[i];
    const label = `(${i + 1}/${items.length}) ${original.name}`;
    const trimmedCaption = caption.trim();
    const savedCategory = categoryMap.has(category) ? category : DEFAULT_CATEGORY;

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
          featured: featured === true,
          categoryId: savedCategory,
          category: savedCategory,
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
  stagingConfirmBtn.disabled = false;
  fileInput.value = "";
  if (messageEl.hidden) showMessage("Upload complete. Recent Work updates automatically. Homepage only shows photos marked “Show on homepage”.", "success");
}

categoryForm?.addEventListener("submit", addCategory);
stagingConfirmBtn.addEventListener("click", uploadStaged);
fileInput.addEventListener("change", (e) => stageFiles(e.target.files));

paintAdminFilters();
paintCategoryManager();
paintAdminGrid();
