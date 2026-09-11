// gallery-live.js
// Homepage "Featured work" sample. Only photos the admin has marked featured
// appear here. The full gallery lives on /work.html (work-live.js).
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const HOME_LIMIT = 6;

function setFeaturedSection(items) {
  const section = document.getElementById("gallery");
  if (!section) return;
  if (!items.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  window.NDFlow?.renderGallery(items);
  if (window.lucide) lucide.createIcons();
}

try {
  // Equality-only query — no composite index required. Older documents that
  // never got a `featured` field are excluded until the admin turns it on.
  const featuredQuery = query(
    collection(db, "gallery"),
    where("featured", "==", true)
  );
  onSnapshot(
    featuredQuery,
    (snapshot) => {
      const items = snapshot.docs
        .map((docSnap) => {
          const data = docSnap.data();
          return {
            src: data.imageData,
            alt: data.alt || "N.D. Flow Plumbing Co. completed project",
            caption: data.caption || "",
            order: typeof data.order === "number" ? data.order : 0,
          };
        })
        .sort((a, b) => b.order - a.order)
        .slice(0, HOME_LIMIT);
      setFeaturedSection(items);
    },
    (error) => {
      console.warn("Live featured gallery unavailable:", error);
      setFeaturedSection([]);
    }
  );
} catch (error) {
  console.warn("Live featured gallery not started:", error);
  setFeaturedSection([]);
}
