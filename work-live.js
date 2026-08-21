// work-live.js
// Feeds the full "Recent Work" page (work.html) from the live gallery
// collection in Firestore, drives the tap-to-preview lightbox, and now the
// like/unlike feature. Visitors are signed in anonymously and silently --
// no login UI is ever shown to them -- purely so each browser has a stable
// Firebase UID to hang one like per photo off of. See firestore.rules for
// how that's actually enforced server-side, not just in this file.
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
  setDoc,
  deleteDoc,
  getCountFromServer,
  serverTimestamp,
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
let currentUid = null; // set once anonymous (or admin) sign-in resolves

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return null;
  return timestamp.toDate().toLocaleDateString("en-NG", { month: "long", year: "numeric" });
}

// ---------- Silent anonymous sign-in ----------
// Only signs in anonymously if nobody is signed in at all -- this matters
// specifically so an admin browsing their own public site while logged into
// /admin (same browser, same Firebase Auth session) never gets bumped to an
// anonymous session. No UI, no interruption, either way.
onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUid = user.uid;
    refreshLikeStates();
  } else {
    signInAnonymously(auth).catch((err) => console.warn("Anonymous sign-in failed:", err));
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
  btn.setAttribute("aria-pressed", liked ? "true" : "false");
  btn.querySelector(".like-count").textContent = count;
  btn.disabled = false;
}

async function toggleLike(imageId, btn) {
  if (!currentUid) return; // sign-in hasn't resolved yet
  btn.disabled = true;
  const liked = btn.getAttribute("aria-pressed") === "true";
  const count = Number(btn.querySelector(".like-count").textContent) || 0;
  const ref = likeDocRef(imageId, currentUid);

  // Optimistic update -- feels instant, corrected below if the write fails.
  updateLikeButton(btn, liked ? count - 1 : count + 1, !liked);

  try {
    if (liked) {
      await deleteDoc(ref);
    } else {
      await setDoc(ref, { likedAt: serverTimestamp() });
    }
  } catch (error) {
    console.error("Like toggle failed:", error);
    updateLikeButton(btn, count, liked); // revert
  }
}

async function refreshLikeStates() {
  if (!currentUid || !items.length) return;
  await Promise.all(
    items.map(async (item) => {
      const btn = listEl.querySelector(`.like-btn[data-id="${item.id}"]`);
      if (!btn) return;
      try {
        const likesRef = collection(db, "gallery", item.id, "likes");
        const [countSnap, mineSnap] = await Promise.all([
          getCountFromServer(likesRef),
          getDoc(likeDocRef(item.id, currentUid)),
        ]);
        updateLikeButton(btn, countSnap.data().count, mineSnap.exists());
      } catch (error) {
        console.warn(`Couldn't load like state for ${item.id}:`, error);
      }
    })
  );
}

// ---------- Live gallery list ----------
function render(snapshot) {
  if (snapshot.empty) {
    items = [];
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  items = snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    imageData: docSnap.data().imageData,
    alt: docSnap.data().alt || "N.D. Flow Plumbing Co. completed project",
    caption: docSnap.data().caption || "",
    dateLabel: formatDate(docSnap.data().createdAt) || "Completed project",
  }));

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
          <button type="button" class="like-btn" data-id="${item.id}" aria-pressed="false" aria-label="Like this photo" disabled>
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
  listEl.querySelectorAll(".like-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleLike(btn.dataset.id, btn));
  });

  if (window.lucide) lucide.createIcons();
  refreshLikeStates();
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
