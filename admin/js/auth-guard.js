// admin/js/auth-guard.js
// Shared helpers reused by every protected admin page (dashboard, gallery, etc).
import { auth, db } from "../../firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

/**
 * Runs onSignedIn(user) once we know someone is logged in.
 * Anyone not logged in gets sent straight back to the login page.
 */
export function requireAuth(onSignedIn) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.replace("/admin/login.html");
      return;
    }
    document.body.classList.add("auth-ready");
    onSignedIn(user);
  });
}

/** Wires a logout button by id. */
export function wireLogout(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await signOut(auth);
      window.location.replace("/admin/login.html");
    } catch (err) {
      console.error("Sign out failed:", err);
      btn.disabled = false;
    }
  });
}

/** Wires the mobile sidebar drawer (hamburger button + backdrop + auto-close on nav). */
export function wireSidebar() {
  const sidebar = document.getElementById("admin-sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  const toggle = document.getElementById("sidebar-toggle");
  if (!sidebar || !backdrop || !toggle) return;

  const close = () => {
    sidebar.classList.remove("open");
    backdrop.classList.remove("show");
  };
  toggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    backdrop.classList.toggle("show");
  });
  backdrop.addEventListener("click", close);
  sidebar.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
}

/** Populates "signed in as" + UID display and wires the copy-UID button, if present on the page. */
export function wireAccountInfo(user) {
  const emailEl = document.getElementById("account-email");
  const uidEl = document.getElementById("account-uid");
  const copyBtn = document.getElementById("copy-uid-btn");
  if (emailEl) emailEl.textContent = user.email;
  if (uidEl) uidEl.textContent = user.uid;
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(user.uid);
        copyBtn.innerHTML = '<i data-lucide="check" class="icon-sm"></i>';
      } catch (err) {
        console.error("Copy failed:", err);
      } finally {
        if (window.lucide) lucide.createIcons();
        setTimeout(() => {
          copyBtn.innerHTML = '<i data-lucide="copy" class="icon-sm"></i>';
          if (window.lucide) lucide.createIcons();
        }, 1800);
      }
    });
  }
}

/**
 * Directly checks whether the signed-in account is recognized as an admin, by
 * attempting to read its own admins/{uid} document. firestore.rules only allows
 * that read if the document exists -- so a permission-denied rejection here IS
 * the answer ("not an admin yet"), not a failure to hide from the caller.
 */
export async function checkAdminStatus(user) {
  try {
    const snap = await getDoc(doc(db, "admins", user.uid));
    return snap.exists();
  } catch (error) {
    if (error?.code === "permission-denied") return false;
    throw error; // something else went wrong (offline, etc.) -- let the caller show that
  }
}
