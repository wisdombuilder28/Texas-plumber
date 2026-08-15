// admin/js/login.js
import { auth } from "../../firebase-config.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const form = document.getElementById("login-form");
const messageEl = document.getElementById("login-message");
const submitBtn = document.getElementById("login-submit");
const forgotBtn = document.getElementById("forgot-btn");

// Already signed in? Skip straight to the dashboard.
onAuthStateChanged(auth, (user) => {
  if (user) window.location.replace("/admin/dashboard.html");
});

function showMessage(text, kind) {
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
    await signInWithEmailAndPassword(auth, email, password);
    window.location.replace("/admin/dashboard.html");
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
