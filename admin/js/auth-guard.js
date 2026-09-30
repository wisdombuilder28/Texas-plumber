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
 * Runs onSignedIn(user) once we know an ADMIN is logged in.
 *
 * Why this checks more than "is anyone signed in":
 * the public site quietly signs every visitor in *anonymously* (that's what powers the like
 * buttons), and that session is shared with /admin because it's the same site. So a plain
 * "user exists" check let any visitor straight into the admin screens -- and it also made the
 * login page bounce real admins to the dashboard before they could type their password.
 * Anonymous visitors are now treated as signed out, and everyone else must have an
 * admins/{uid} document. (firestore.rules is still the real lock on the data; this decides what
 * the screen shows.)
 */
export function requireAuth(onSignedIn) {
  let settled = false;
  let startedFor = null;
  const box = () => document.querySelector(".auth-loading");

  const timer = setTimeout(() => {
    if (settled) return;
    const el = box();
    if (!el) return;
    el.innerHTML =
      'Sign-in is taking too long. <a href="/admin/login.html" style="color:#fff;text-decoration:underline">Try signing in again</a>';
  }, 8000);

  onAuthStateChanged(auth, async (user) => {
    settled = true;
    clearTimeout(timer);
    if (!user || user.isAnonymous) {
      window.location.replace("/admin/login.html");
      return;
    }
    if (startedFor === user.uid) return; // auth state can fire more than once; only start once
    startedFor = user.uid;

    let isAdmin = false;
    try {
      isAdmin = await checkAdminStatus(user);
    } catch (error) {
      console.error("Admin check failed:", error);
      startedFor = null;
      showGuardMessage(
        "Couldn't check your account. Check your connection and try again.",
        { label: "Try again", onClick: () => window.location.reload() }
      );
      return;
    }

    if (!isAdmin) {
      showGuardMessage(
        `You're signed in as ${user.email || "this account"}, but it isn't set up as an admin yet. Give this ID to whoever manages Firebase so they can add it to the admins collection:`,
        {
          label: "Sign out",
          onClick: async () => {
            try {
              await signOut(auth);
            } finally {
              window.location.replace("/admin/login.html");
            }
          },
        },
        user.uid
      );
      return;
    }

    document.body.classList.add("auth-ready");
    onSignedIn(user);
  });
}

// Replaces the "Loading..." screen with a short message and one button.
function showGuardMessage(text, action, code) {
  const box = document.querySelector(".auth-loading");
  if (!box) return;
  const wrap = document.createElement("div");
  wrap.className = "auth-block";
  const p = document.createElement("p");
  p.textContent = text;
  wrap.append(p);
  if (code) {
    const c = document.createElement("code");
    c.textContent = code;
    wrap.append(c);
  }
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", action.onClick);
    wrap.append(b);
  }
  box.replaceChildren(wrap);
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
 * reading its own admins/{uid} document. Any signed-in user may read their OWN
 * admins doc, so "not an admin" normally shows up as exists() === false; a
 * permission-denied rejection is treated the same way.
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
