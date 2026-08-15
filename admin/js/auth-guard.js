// admin/js/auth-guard.js
// Shared helpers reused by every protected admin page (dashboard, gallery, etc).
import { auth } from "../../firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

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
