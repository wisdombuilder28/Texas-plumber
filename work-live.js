// work-live.js
// Feeds the full "Recent Work" page (work.html) from the live gallery
// collection in Firestore. Separate from gallery-live.js on purpose --
// that file re-renders the homepage's compact masonry preview, this one
// renders full-size cards with readable captions, which is the whole
// reason this page exists.
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const listEl = document.getElementById("work-list");
const emptyEl = document.getElementById("work-empty");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return null;
  return timestamp.toDate().toLocaleDateString("en-NG", { month: "long", year: "numeric" });
}

function render(snapshot) {
  if (snapshot.empty) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  listEl.innerHTML = snapshot.docs
    .map((docSnap) => {
      const d = docSnap.data();
      const alt = d.alt || "N.D. Flow Plumbing Co. completed project";
      const dateLabel = formatDate(d.createdAt) || "Completed project";
      return `
        <article class="work-item">
          <div class="work-item-media">
            <img src="${escapeHtml(d.imageData)}" alt="${escapeHtml(alt)}" loading="lazy" />
          </div>
          <div class="work-item-body">
            <div class="work-item-label"><span class="dot"></span> ${escapeHtml(dateLabel)}</div>
            ${d.caption ? `<p class="work-item-caption">${escapeHtml(d.caption)}</p>` : ""}
          </div>
        </article>`;
    })
    .join("");
}

try {
  const galleryQuery = query(collection(db, "gallery"), orderBy("order", "desc"));
  onSnapshot(
    galleryQuery,
    render,
    (error) => {
      console.warn("Recent Work listener failed:", error);
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = "Couldn't load projects right now — please check back shortly.";
    }
  );
} catch (error) {
  console.warn("Recent Work not started:", error);
}
