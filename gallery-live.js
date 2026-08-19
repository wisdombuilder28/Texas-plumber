// gallery-live.js
// Keeps the public gallery section in sync with Firestore in real time —
// no refresh needed after the admin uploads or deletes a photo.
// If Firebase isn't configured yet, or the live connection fails, the static
// photos already rendered by script.js simply stay on screen. This file never
// blocks or breaks the page.
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

try {
  const galleryQuery = query(collection(db, "gallery"), orderBy("order", "desc"));
  onSnapshot(
    galleryQuery,
    (snapshot) => {
      if (snapshot.empty) return; // nothing uploaded yet — keep the default photos
      const items = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          src: data.imageData,
          alt: data.alt || "N.D. Flow Plumbing Co. completed project",
          caption: data.caption || "",
        };
      });
      window.NDFlow?.renderGallery(items);
    },
    (error) => {
      console.warn("Live gallery unavailable, showing default photos:", error);
    }
  );
} catch (error) {
  console.warn("Live gallery not started:", error);
}
