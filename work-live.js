// work-live.js
// Feeds the full Recent Work page from the live gallery collection in Firestore,
// dynamically builds the public category filters, drives the lightbox, and handles likes.
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const listEl = document.getElementById("work-list");
const emptyEl = document.getElementById("work-empty");
const filterBar = document.getElementById("work-filter");

const DEFAULT_CATEGORIES = [
  { id: "completed", label: "Completed", order: 1 },
  { id: "in-progress", label: "Still working", order: 2 },
];

let categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
let categoryMap = new Map(categories.map((c) => [c.id, c]));
let allItems = [];
let items = [];
let currentIndex = 0;
let currentUid = null;
let signInPromise = null;
let activeFilter = "all";
let categoriesReady = false;

const lightbox = document.getElementById("lightbox");
const lightboxImage = document.getElementById("lightbox-image");
const lightboxDate = document.getElementById("lightbox-date");
const lightboxText = document.getElementById("lightbox-text");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return null;
  return timestamp.toDate().toLocaleDateString("en-NG", { month: "long", year: "numeric" });
}

function rebuildCategoryMap() {
  categoryMap = new Map(categories.map((c) => [c.id, c]));
}

function sortedCategories() {
  return categories.slice().sort((a, b) => {
    const diff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return diff || a.label.localeCompare(b.label);
  });
}

function humanizeCategoryId(id) {
  const value = String(id || "").replace(/[-_]+/g, " ").trim();
  if (!value) return "Completed";
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function categoryOf(data) {
  const candidate = String(data?.categoryId || data?.category || "").trim();
  return categoryMap.has(candidate) ? candidate : DEFAULT_CATEGORIES.some((c) => c.id === candidate) ? candidate : "completed";
}

function categoryLabel(id) {
  return categoryMap.get(id)?.label || DEFAULT_CATEGORIES.find((c) => c.id === id)?.label || humanizeCategoryId(id);
}

function paintFilterBar() {
  if (!filterBar) return;
  const buttons = [
    `<button type="button" class="work-filter-btn ${activeFilter === "all" ? "is-active" : ""}" data-work-filter="all" role="tab" aria-selected="${activeFilter === "all" ? "true" : "false"}">All</button>`,
    ...sortedCategories().map((category) => {
      const active = activeFilter === category.id;
      return `<button type="button" class="work-filter-btn ${active ? "is-active" : ""}" data-work-filter="${escapeHtml(category.id)}" role="tab" aria-selected="${active ? "true" : "false"}">${escapeHtml(category.label)}</button>`;
    }),
  ];
  filterBar.innerHTML = buttons.join("");
}

function setFilter(next) {
  activeFilter = next === "all" || categoryMap.has(next) ? next : "all";
  paintFilterBar();
  paintList();
}

function paintList() {
  items = activeFilter === "all"
    ? allItems.slice()
    : allItems.filter((item) => item.category === activeFilter);

  if (!allItems.length) {
    clearLikeListeners();
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = "No project photos yet — check back soon.";
    return;
  }

  if (!items.length) {
    clearLikeListeners();
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = `No projects in “${categoryLabel(activeFilter)}” yet.`;
    return;
  }

  emptyEl.hidden = true;
  listEl.innerHTML = items
    .map(
      (item, i) => `
      <article class="work-item">
        <button type="button" class="work-item-media" data-index="${i}" aria-label="View full photo">
          <img src="${escapeHtml(item.imageData)}" alt="${escapeHtml(item.alt)}" loading="lazy" />
          <span class="expand-hint"><i data-lucide="maximize-2" class="icon-sm"></i></span>
        </button>
        <div class="work-item-body">
          <div class="work-item-label">
            <span class="dot"></span>
            <span class="work-cat">${escapeHtml(categoryLabel(item.category))}</span>
            <span class="work-cat-sep">·</span>
            ${escapeHtml(item.dateLabel)}
          </div>
          ${item.caption ? `<p class="work-item-caption" data-index="${i}">${escapeHtml(item.caption)}</p>` : ""}
          <button type="button" class="like-btn is-loading" data-id="${item.id}" aria-pressed="false" aria-label="Like this photo">
            <i data-lucide="heart" class="icon-sm"></i>
            <span class="like-count">–</span>
          </button>
        </div>
      </article>`
    )
    .join("");

  listEl.querySelectorAll(".work-item-media").forEach((btn) => {
    btn.addEventListener("click", () => openLightbox(Number(btn.dataset.index)));
  });
  listEl.querySelectorAll(".work-item-caption").forEach((caption) => {
    caption.addEventListener("click", () => openLightbox(Number(caption.dataset.index)));
  });
  listEl.querySelectorAll(".like-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.retry === "true") {
        const item = items.find((i) => i.id === btn.dataset.id);
        if (item) likeUnsubscribes.push(watchLikesFor(item, btn));
        return;
      }
      toggleLike(btn.dataset.id, btn);
    });
  });

  if (window.lucide) lucide.createIcons();
  watchAllLikes();
}

function ensureSignedIn() {
  if (currentUid) return Promise.resolve(currentUid);
  if (!signInPromise) {
    signInPromise = signInAnonymously(auth)
      .then((result) => {
        currentUid = result.user.uid;
        return currentUid;
      })
      .catch((error) => {
        signInPromise = null;
        throw error;
      });
  }
  return signInPromise;
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUid = user.uid;
    watchAllLikes();
  } else {
    ensureSignedIn()
      .then(watchAllLikes)
      .catch((err) => console.warn("Anonymous sign-in failed:", err));
  }
});

// ---------- Lightbox ----------
function showLightboxItem() {
  const item = items[currentIndex];
  if (!item) return;
  lightboxImage.src = item.imageData;
  lightboxImage.alt = item.alt;
  lightboxDate.textContent = item.dateLabel;
  lightboxText.textContent = item.caption;
  lightboxText.hidden = !item.caption;
  const multiple = items.length > 1;
  lightboxPrev.hidden = !multiple;
  lightboxNext.hidden = !multiple;
}

function openLightbox(index) {
  currentIndex = index;
  showLightboxItem();
  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
  if (window.lucide) lucide.createIcons();
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.style.overflow = "";
}

function showNext() {
  currentIndex = (currentIndex + 1) % items.length;
  showLightboxItem();
}

function showPrev() {
  currentIndex = (currentIndex - 1 + items.length) % items.length;
  showLightboxItem();
}

lightboxClose.addEventListener("click", closeLightbox);
lightboxNext.addEventListener("click", showNext);
lightboxPrev.addEventListener("click", showPrev);
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowRight") showNext();
  if (e.key === "ArrowLeft") showPrev();
});

let touchStartX = null;
lightbox.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
lightbox.addEventListener("touchend", (e) => {
  if (touchStartX === null || items.length <= 1) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) (dx < 0 ? showNext : showPrev)();
  touchStartX = null;
});

// ---------- Likes ----------
function likeDocRef(imageId, uid) {
  return doc(db, "gallery", imageId, "likes", uid);
}

function updateLikeButton(btn, count, liked) {
  btn.classList.remove("is-loading");
  btn.setAttribute("aria-pressed", liked ? "true" : "false");
  btn.querySelector(".like-count").textContent = count;
  btn.disabled = false;
  btn.title = "";
}

async function toggleLike(imageId, btn) {
  btn.disabled = true;
  try {
    const uid = await ensureSignedIn();
    const ref = likeDocRef(imageId, uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await deleteDoc(ref);
    } else {
      await setDoc(ref, { likedAt: serverTimestamp() });
    }
    btn.disabled = false;
  } catch (error) {
    console.error("Like toggle failed:", error);
    btn.disabled = false;
    btn.title = "Couldn't update your like just now — tap to try again";
  }
}

let likeUnsubscribes = [];
const likeListenerMap = new Map();

function clearLikeListeners() {
  likeUnsubscribes.forEach((unsubscribe) => unsubscribe());
  likeUnsubscribes = [];
  likeListenerMap.clear();
}

function watchLikesFor(item, btn) {
  const likesQuery = query(collection(db, "gallery", item.id, "likes"));
  return onSnapshot(
    likesQuery,
    (snapshot) => {
      const count = snapshot.size;
      const liked = currentUid ? snapshot.docs.some((d) => d.id === currentUid) : false;
      btn.dataset.retry = "false";
      updateLikeButton(btn, count, liked);
    },
    (error) => {
      console.warn(`Likes unavailable for ${item.id}:`, error);
      btn.classList.remove("is-loading");
      btn.disabled = false;
      btn.title = "Likes are temporarily unavailable — tap to try again";
      btn.dataset.retry = "true";
    }
  );
}

function watchAllLikes() {
  if (!currentUid || !items.length) return;
  clearLikeListeners();
  listEl.querySelectorAll(".like-btn").forEach((btn) => {
    const item = items.find((i) => i.id === btn.dataset.id);
    if (!item) return;
    const unsubscribe = watchLikesFor(item, btn);
    likeUnsubscribes.push(unsubscribe);
    likeListenerMap.set(item.id, unsubscribe);
  });
}

// ---------- Live category + gallery data ----------
function startCategoryListener() {
  onSnapshot(
    collection(db, "categories"),
    (snapshot) => {
      const next = snapshot.docs
        .map((docSnap) => {
          const data = docSnap.data();
          return {
            id: docSnap.id,
            label: String(data.name || "").trim() || humanizeCategoryId(docSnap.id),
            order: Number.isFinite(data.order) ? data.order : 999,
          };
        })
        .filter((category) => category.id !== "all")
        .sort((a, b) => ((a.order - b.order) || a.label.localeCompare(b.label)));

      categories = next.length ? next : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      rebuildCategoryMap();
      categoriesReady = true;
      if (activeFilter !== "all" && !categoryMap.has(activeFilter)) activeFilter = "all";
      paintFilterBar();
      paintList();
    },
    (error) => {
      console.warn("Category listener unavailable:", error);
      categoriesReady = false;
      paintFilterBar();
      paintList();
    }
  );
}

function startGalleryListener() {
  const galleryQuery = query(collection(db, "gallery"), orderBy("order", "desc"));
  onSnapshot(
    galleryQuery,
    (snapshot) => {
      allItems = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        const created = data.createdAt || data.updatedAt;
        return {
          id: docSnap.id,
          ...data,
          category: categoryOf(data),
          dateLabel: formatDate(created) || "",
          alt: data.alt || "N.D. Flow Plumbing Co. project",
        };
      });
      paintList();
    },
    (error) => {
      console.warn("Live Recent Work gallery unavailable:", error);
      clearLikeListeners();
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = "We couldn't load the project gallery right now — please try again shortly.";
    }
  );
}

if (filterBar) {
  filterBar.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-work-filter]");
    if (!btn) return;
    setFilter(btn.dataset.workFilter || "all");
  });
}

paintFilterBar();
startCategoryListener();
startGalleryListener();
