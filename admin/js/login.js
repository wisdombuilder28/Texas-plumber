// admin/js/login.js
//
// This page has three looks, set as data-auth on <html> (the rules at the top of login.html and admin.css draw them):
//   "checking"    -> "Checking your session…", the form hidden. The starting point.
//   "redirecting" -> "Signing you in…", on its way to the dashboard.
//   "form"        -> the sign-in form. Only once we KNOW nobody is signed in.
// So an admin who is already signed in never sees the form: Firebase restores the saved login, and
// we move on to the dashboard without asking for the email and password again.
// (The head script of login.html goes one step further for a browser with a confirmed admin session: it
// skips this page entirely. This file is the safety net for everyone else, and for a stale shortcut.)
import { auth } from "../../firebase-config.js";
import {
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  sendPasswordResetEmail,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { forgetAdmin } from "./admin-hint.js";

// Lets the head script of login.html word its failsafe message ("still connecting" vs "taking longer").
window.ndLoginReady = true;

const root = document.documentElement;
const form = document.getElementById("login-form");
const messageEl = document.getElementById("login-message");
const submitBtn = document.getElementById("login-submit");
const forgotBtn = document.getElementById("forgot-btn");
const passwordInput = document.getElementById("password-input");
const passwordToggle = document.getElementById("password-toggle");

// The head script is already sending this tab to the dashboard; leave the deciding to the dashboard.
const alreadyLeaving = root.dataset.auth === "redirecting";

// The icon library loads async so it can never hold up the sign-in check: draw the icons now if it is
// here already, otherwise once the page (and so the library) has finished loading.
const drawIcons = () => { if (window.lucide) lucide.createIcons(); };
drawIcons();
window.addEventListener("load", drawIcons, { once: true });

passwordToggle.addEventListener("click", () => {
  const showing = passwordInput.type === "text";
  passwordInput.type = showing ? "password" : "text";
  passwordToggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  passwordToggle.innerHTML = showing
    ? '<i data-lucide="eye" class="icon-sm"></i>'
    : '<i data-lucide="eye-off" class="icon-sm"></i>';
  drawIcons();
});

// The timer in login.html may have left a note ("still connecting" / "taking longer"). Once we are connected
// and know the answer, it is out of date.
function clearFailsafeNote() {
  if (!messageEl.hasAttribute("data-failsafe")) return;
  messageEl.hidden = true;
  messageEl.removeAttribute("data-failsafe");
}
if (messageEl.getAttribute("data-failsafe") === "unreachable") clearFailsafeNote(); // we got here after all

let leaving = false;

function goToDashboard() {
  if (leaving) return;
  leaving = true;
  root.dataset.auth = "redirecting";
  window.location.replace("/admin/dashboard.html");
}

function showForm() {
  if (leaving) return;
  root.dataset.auth = "form";
}

// Already signed in as a real account? Go straight to the dashboard. Otherwise show the form.
// The public site signs every visitor in anonymously (for the like buttons), so an anonymous
// session must NOT count -- it used to bounce people off this page before they could log in.
// The first answer only arrives once Firebase has restored (and re-checked) the saved login, which is
// why the form waits for it. Later answers matter too: signing in from another tab moves this one on.
onAuthStateChanged(auth, (user) => {
  if (alreadyLeaving) return;
  clearFailsafeNote();
  if (user && !user.isAnonymous) {
    goToDashboard();
    return;
  }
  forgetAdmin(); // nobody is signed in, so a leftover "admin on this browser" note is stale
  showForm();
});

function showMessage(text, kind) {
  messageEl.removeAttribute("data-failsafe");
  messageEl.textContent = text;
  messageEl.hidden = false;
  messageEl.className = `form-message ${kind}`;
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.querySelector(".btn-label").textContent = isLoading ? "Signing in…" : "Sign in";
}

function friendlyAuthError(err) {
  switch (err && err.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "That email or password isn't right. Please try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few minutes and try again.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/network-request-failed":
      return "Network error — check your connection and try again.";
    default:
      return "Something went wrong signing you in. Please try again.";
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  messageEl.hidden = true;
  const email = form.email.value.trim();
  const password = form.password.value;
  if (!email || !password) return;

  setLoading(true);
  try {
    // Keep the admin signed in across app launches / reloads. This is already the browser default, so if a
    // particular browser refuses the explicit request, sign in anyway rather than lock the admin out.
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch (err) {
      console.warn("Could not set sign-in persistence:", err);
    }
    await signInWithEmailAndPassword(auth, email, password);
    goToDashboard();
  } catch (err) {
    console.error("Sign-in failed:", err);
    showMessage(friendlyAuthError(err), "error");
    setLoading(false);
  }
});

forgotBtn.addEventListener("click", async () => {
  const email = form.email.value.trim();
  if (!email) {
    showMessage('Enter your email above, then tap "Forgot password?" again.', "error");
    return;
  }
  forgotBtn.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    showMessage("Password reset email sent — check your inbox.", "success");
  } catch (err) {
    console.error("Reset email failed:", err);
    showMessage(friendlyAuthError(err), "error");
  } finally {
    forgotBtn.disabled = false;
  }
});
