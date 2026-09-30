// work-live.js
// Feeds the full "Recent Work" page (work.html) from the live gallery
// collection in Firestore, drives the tap-to-preview lightbox, the category
// filter tabs, and the like/unlike feature. Visitors are signed in anonymously and silently --
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
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const listEl = document.getElementById("work-list");
const emptyEl = document.getElementById("work-empty");
const filterBar = document.getElementById("work-filter");

const CATEGORY_LABELS = {
  completed: "Completed",
  "in-progress": "Still working",
};

// Only real embedded photos are ever put into an <img>.
const DATA_IMAGE = /^data:image\/(jpe?g|png|webp|gif|avif);base64,/i;

let allItems = [];
let items = []; // visible list after filter
let currentIndex = 0;
let currentUid = null; // set once anonymous (or admin) sign-in resolves
let signInPromise = null;
let activeFilter = "all";

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

function categoryOf(data) {
  return data?.category === "in-progress" ? "in-progress" : "completed";
}

function setFilter(next) {
  activeFilter = next === "in-progress" || next === "completed" ? next : "all";
  paintList();
}

// The tabs only appear when there is something to switch between: a "Still working" tab that
// opens an empty page just makes visitors think the site is broken. Tabs for an empty category
// are hidden, and the whole bar is hidden until BOTH categories have at least one photo.
function updateFilterBar() {
  if (!filterBar) return;
  const counts = { completed: 0, "in-progress": 0 };
  allItems.forEach((item) => {
    counts[item.category] += 1;
  });
  filterBar.style.display = counts.completed > 0 && counts["in-progress"] > 0 ? "" : "none";
  filterBar.querySelectorAll("[data-work-filter]").forEach((btn) => {
    const key = btn.dataset.workFilter;
    const on = key === activeFilter;
    btn.hidden = key !== "all" && counts[key] === 0;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function paintList() {
  // If the tab a visitor is on has just become empty (say the last "Still working" job was marked
  // Completed while they were looking), drop back to All instead of stranding them on an empty tab.
  if (activeFilter !== "all" && !allItems.some((item) => item.category === activeFilter)) {
    activeFilter = "all";
  }
  updateFilterBar();

  items = activeFilter === "all"
    ? allItems.slice()
    : allItems.filter((item) => item.category === activeFilter);

  if (!items.length) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = "No project photos yet — check back soon.";
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
            <span class="work-cat">${escapeHtml(CATEGORY_LABELS[item.category] || "Completed")}</span>
            <span class="work-cat-sep">·</span>
            ${escapeHtml(item.dateLabel)}
          </div>
          ${item.caption ? `<p class="work-item-caption" data-index="${i}">${escapeHtml(item.caption)}</p>` : ""}
          <button type="button" class="like-btn is-loading" data-id="${escapeHtml(item.id)}" aria-pressed="false" aria-label="Like this photo">
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
        watchLikes(btn.dataset.id); // reconnect instead of toggling
        return;
      }
      toggleLike(btn.dataset.id, btn);
    });
  });

  if (window.lucide) lucide.createIcons();
  paintAllLikeButtons(); // from the like state we already have -- no new listeners
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
    paintAllLikeButtons(); // "liked by me" depends on who I am; the counts are already live
  } else {
    if (currentUid) {
      // Signed out somewhere else (e.g. the admin logged out in another tab). Forget the old
      // identity, otherwise ensureSignedIn() would hand back a UID that no longer has a session.
      currentUid = null;
      signInPromise = null;
    }
    ensureSignedIn()
      .then(paintAllLikeButtons)
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

// Toggling just writes the like doc or deletes it -- it does NOT compute the
// new count or flip the color itself. That's deliberate: the live listener
// below is the single source of truth for what the button shows, so this
// can't ever fall out of sync with what's actually in the database, and it
// naturally picks up likes/unlikes from other visitors too, live.
async function toggleLike(imageId, btn) {
  btn.disabled = true;
  try {
    const uid = await ensureSignedIn();
    const ref = likeDocRef(imageId, uid);
    // Authoritative check -- NOT the button's on-screen aria-pressed, which
    // is only ever painted by the live listener and can briefly lag behind
    // the real database state. Deciding from stale UI here was the actual
    // bug: it could try to create a like that already existed, which the
    // rules correctly reject as an illegal edit (allow update: if false).
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await deleteDoc(ref);
    } else {
      await setDoc(ref, { likedAt: serverTimestamp() });
    }
    btn.disabled = false; // the listener re-fires on its own and repaints count + color
  } catch (error) {
    console.error("Like toggle failed:", error);
    btn.disabled = false;
    btn.title = "Couldn't update your like just now — tap to try again";
  }
}

// One live listener per photo's likes subcollection, created ONCE when the photo first appears
// and kept until the photo is deleted. It fires immediately with the locally-applied change the
// instant you tap (before the server even confirms it), and again -- no refresh needed -- whenever
// anyone else, on any other device, likes or unlikes that same photo.
//
// The listeners used to be torn down and rebuilt on every filter-tab tap and on every gallery
// change, which re-read every photo's likes from Firestore each time -- an easy way to burn through
// the free daily read quota. Now the like state is cached here and the buttons are simply repainted
// from it, so switching tabs costs nothing.
//
// If a listener can't connect (most commonly: firestore.rules edited but not actually published
// yet) it retries a few times with a growing delay (covers rules still propagating), and if it is
// still failing after that it says so on the button instead of sitting on "–" forever.
const likeWatch = new Map(); // photoId -> { unsub, timer, ids: Set<uid> | null, failed: null | "permission-denied" | "offline" }

function paintLikeButton(btn) {
  const entry = likeWatch.get(btn.dataset.id);
  const countEl = btn.querySelector(".like-count");

  if (entry?.failed) {
    btn.classList.remove("is-loading");
    btn.setAttribute("aria-pressed", "false");
    countEl.textContent = entry.failed === "permission-denied" ? "setup?" : "offline";
    btn.title = entry.failed === "permission-denied"
      ? "Likes aren't set up yet -- tap to retry, or check firestore.rules is published"
      : "Couldn't connect -- tap to retry";
    btn.dataset.retry = "true"; // clicking now retries the connection instead of toggling a like
    btn.disabled = false;
    return;
  }

  delete btn.dataset.retry;
  if (!entry || !entry.ids) {
    btn.classList.add("is-loading");
    btn.setAttribute("aria-pressed", "false");
    countEl.textContent = "–";
    return;
  }
  btn.classList.remove("is-loading");
  btn.setAttribute("aria-pressed", currentUid && entry.ids.has(currentUid) ? "true" : "false");
  countEl.textContent = entry.ids.size;
  btn.disabled = false;
  btn.title = "";
}

function paintAllLikeButtons() {
  listEl.querySelectorAll(".like-btn").forEach(paintLikeButton);
}

function paintLikeButtonsFor(id) {
  listEl.querySelectorAll(".like-btn").forEach((btn) => {
    if (btn.dataset.id === id) paintLikeButton(btn);
  });
}

function watchLikes(id, attempt = 0) {
  let entry = likeWatch.get(id);
  if (!entry) {
    entry = { unsub: null, timer: null, ids: null, failed: null };
    likeWatch.set(id, entry);
  }
  if (entry.unsub) entry.unsub();
  clearTimeout(entry.timer);
  entry.failed = null;
  paintLikeButtonsFor(id);

  entry.unsub = onSnapshot(
    collection(db, "gallery", id, "likes"),
    (snapshot) => {
      entry.ids = new Set(snapshot.docs.map((d) => d.id));
      entry.failed = null;
      paintLikeButtonsFor(id);
    },
    (error) => {
      console.error(`Likes listener failed for ${id} (attempt ${attempt + 1}):`, error);
      if (likeWatch.get(id) !== entry) return; // photo was removed meanwhile -- drop this attempt
      if (attempt < 3) {
        entry.timer = setTimeout(() => {
          if (likeWatch.get(id) === entry) watchLikes(id, attempt + 1);
        }, 1500 * (attempt + 1));
        return;
      }
      entry.failed = error.code === "permission-denied" ? "permission-denied" : "offline";
      paintLikeButtonsFor(id);
    }
  );
}

// Keeps exactly one listener per photo that currently exists.
function syncLikeWatchers() {
  const live = new Set(allItems.map((item) => item.id));
  for (const [id, entry] of likeWatch) {
    if (live.has(id)) continue;
    if (entry.unsub) entry.unsub();
    clearTimeout(entry.timer);
    likeWatch.delete(id);
  }
  live.forEach((id) => {
    if (!likeWatch.has(id)) watchLikes(id);
  });
}

// ---------- Live gallery list ----------
function render(snapshot) {
  allItems = snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        imageData: data.imageData,
        alt: data.alt || "N.D. Flow Plumbing Co. completed project",
        caption: data.caption || "",
        category: categoryOf(data),
        dateLabel: formatDate(data.createdAt) || "Project",
      };
    })
    .filter((item) => typeof item.imageData === "string" && DATA_IMAGE.test(item.imageData));
  syncLikeWatchers();
  paintList();
}

try {
  const galleryQuery = query(collection(db, "gallery"), orderBy("order", "desc"));
  onSnapshot(
    galleryQuery,
    render,
    (error) => {
      console.warn("Recent Work listener failed:", error);
      allItems = [];
      items = [];
      syncLikeWatchers();
      updateFilterBar();
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = "Couldn't load projects right now — please check back shortly.";
    }
  );
} catch (error) {
  console.warn("Recent Work not started:", error);
}

if (filterBar) {
  filterBar.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-work-filter]");
    if (!btn) return;
    setFilter(btn.dataset.workFilter);
  });
}
