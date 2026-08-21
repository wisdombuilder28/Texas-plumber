// work-live.js
// Feeds the full "Recent Work" page (work.html) from the live gallery
// collection in Firestore, and drives the tap-to-preview lightbox from the
// same in-memory list so next/previous navigation doesn't need another read.
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const listEl = document.getElementById("work-list");
const emptyEl = document.getElementById("work-empty");

const lightbox = document.getElementById("lightbox");
const lightboxImage = document.getElementById("lightbox-image");
const lightboxDate = document.getElementById("lightbox-date");
const lightboxText = document.getElementById("lightbox-text");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");

let items = []; // current photo list, in display order
let currentIndex = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return null;
  return timestamp.toDate().toLocaleDateString("en-NG", { month: "long", year: "numeric" });
}

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

// Tapping the dark backdrop (not the image/caption/buttons) closes it
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});

document.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowRight") showNext();
  if (e.key === "ArrowLeft") showPrev();
});

// Basic swipe support for mobile
let touchStartX = null;
lightbox.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
lightbox.addEventListener("touchend", (e) => {
  if (touchStartX === null || items.length <= 1) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) (dx < 0 ? showNext : showPrev)();
  touchStartX = null;
});

// ---------- Live gallery list ----------
function render(snapshot) {
  if (snapshot.empty) {
    items = [];
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  items = snapshot.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      imageData: d.imageData,
      alt: d.alt || "N.D. Flow Plumbing Co. completed project",
      caption: d.caption || "",
      dateLabel: formatDate(d.createdAt) || "Completed project",
    };
  });

  listEl.innerHTML = items
    .map(
      (item, i) => `
      <article class="work-item">
        <button type="button" class="work-item-media" data-index="${i}" aria-label="View full photo">
          <img src="${escapeHtml(item.imageData)}" alt="${escapeHtml(item.alt)}" loading="lazy" />
          <span class="expand-hint"><i data-lucide="maximize-2" class="icon-sm"></i></span>
        </button>
        <div class="work-item-body">
          <div class="work-item-label"><span class="dot"></span> ${escapeHtml(item.dateLabel)}</div>
          ${item.caption ? `<p class="work-item-caption">${escapeHtml(item.caption)}</p>` : ""}
        </div>
      </article>`
    )
    .join("");

  listEl.querySelectorAll(".work-item-media").forEach((btn) => {
    btn.addEventListener("click", () => openLightbox(Number(btn.dataset.index)));
  });

  if (window.lucide) lucide.createIcons();
}

try {
  const galleryQuery = query(collection(db, "gallery"), orderBy("order", "desc"));
  onSnapshot(
    galleryQuery,
    render,
    (error) => {
      console.warn("Recent Work listener failed:", error);
      items = [];
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = "Couldn't load projects right now — please check back shortly.";
    }
  );
} catch (error) {
  console.warn("Recent Work not started:", error);
}
