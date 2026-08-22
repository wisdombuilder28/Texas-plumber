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
  setDoc,
  deleteDoc,
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
let signInPromise = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return null;
  return timestamp.toDate().toLocaleDateString("en-NG", { month: "long", year: "numeric" });
}

// Returns a UID, signing in anonymously if needed. Safe to call from a tap
// handler even if the background sign-in below never completed -- this is
// the retry path, not just a one-shot attempt made silently on page load.
function ensureSignedIn() {
  if (currentUid) return Promise.resolve(currentUid);
  if (!signInPromise) {
    signInPromise = signInAnonymously(auth)
      .then((result) => {
        currentUid = result.user.uid;
        return currentUid;
      })
      .catch((error) => {
        signInPromise = null; // let the next attempt try again instead of staying stuck
        throw error;
      });
  }
  return signInPromise;
}

// ---------- Silent anonymous sign-in ----------
// Only signs in anonymously if nobody is signed in at all -- this matters
// specifically so an admin browsing their own public site while logged into
// /admin (same browser, same Firebase Auth session) never gets bumped to an
// anonymous session. No UI, no interruption, either way.
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

// Toggling just writes the like doc or deletes it -- it does NOT compute the
// new count or flip the color itself. That's deliberate: the live listener
// below is the single source of truth for what the button shows, so this
// can't ever fall out of sync with what's actually in the database, and it
// naturally picks up likes/unlikes from other visitors too, live.
async function toggleLike(imageId, btn) {
  const wasLiked = btn.getAttribute("aria-pressed") === "true";
  btn.disabled = true;
  try {
    const uid = await ensureSignedIn();
    const ref = likeDocRef(imageId, uid);
    if (wasLiked) {
      await deleteDoc(ref);
    } else {
      await setDoc(ref, { likedAt: serverTimestamp() });
    }
    btn.disabled = false; // the listener re-fires on its own and repaints count + color
  } catch (error) {
    console.error("Like toggle failed:", error);
    btn.disabled = false;
    btn.title = "Couldn't connect just now — tap to try again";
  }
}

// One live listener per photo's likes subcollection. Fires immediately with
// the locally-applied change the instant you tap (before the server even
// confirms it), and fires again -- on its own, no refresh needed -- whenever
// anyone else, on any other device, likes or unlikes that same photo.
//
// If the listener can't connect (most commonly: firestore.rules edited but
// not actually published yet), this used to fail silently into the browser
// console where nobody would ever see it. Now it retries a few times with a
// growing delay (covers the ordinary case of rules still propagating right
// after publishing), and if it's still failing after that, it says so
// directly on the button instead of leaving it stuck on "–" forever.
function watchLikesFor(item, btn, attempt = 0) {
  const likesRef = collection(db, "gallery", item.id, "likes");
  const unsub = onSnapshot(
    likesRef,
    (snapshot) => {
      const liked = currentUid ? snapshot.docs.some((d) => d.id === currentUid) : false;
      updateLikeButton(btn, snapshot.size, liked);
    },
    (error) => {
      console.error(`Likes listener failed for ${item.id} (attempt ${attempt + 1}):`, error);
      const stillCurrent = likeUnsubscribes.includes(unsub);
      if (!stillCurrent) return; // page moved on (re-render/cleanup) -- drop this attempt

      if (attempt < 3) {
        setTimeout(() => {
          const idx = likeUnsubscribes.indexOf(unsub);
          if (idx === -1) return; // cleared during the wait -- don't resurrect it
          likeUnsubscribes[idx] = watchLikesFor(item, btn, attempt + 1);
        }, 1500 * (attempt + 1));
        return;
      }

      btn.classList.remove("is-loading");
      const countEl = btn.querySelector(".like-count");
      countEl.textContent = error.code === "permission-denied" ? "setup?" : "offline";
      btn.title = error.code === "permission-denied"
        ? "Likes aren't set up yet -- firestore.rules needs to be published in Firebase Console"
        : "Couldn't connect -- check your connection and reload";
      btn.disabled = true;
    }
  );
  return unsub;
}

let likeUnsubscribes = [];

function clearLikeListeners() {
  likeUnsubscribes.forEach((unsub) => unsub());
  likeUnsubscribes = [];
}

async function watchAllLikes() {
  clearLikeListeners();
  try {
    await ensureSignedIn();
  } catch (error) {
    console.warn("Sign-in not ready -- likes will show once it connects:", error);
  }
  items.forEach((item) => {
    const btn = listEl.querySelector(`.like-btn[data-id="${item.id}"]`);
    if (!btn) return;
    likeUnsubscribes.push(watchLikesFor(item, btn));
  });
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
  listEl.querySelectorAll(".like-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleLike(btn.dataset.id, btn));
  });

  if (window.lucide) lucide.createIcons();
  watchAllLikes();
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
