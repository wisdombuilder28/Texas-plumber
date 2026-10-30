// admin/js/admin-hint.js
// A small "this browser already has an admin signed in" note, kept in localStorage.
//
// It only decides where /admin sends you FIRST: straight to the dashboard instead of the sign-in
// form (see the script at the top of admin/login.html). It never grants access -- the dashboard
// still checks the real Firebase session and the admins/{uid} document, and firestore.rules is the
// real lock. A stale note is harmless: the dashboard clears it and sends you back to the sign-in form.
//
// KEEP IN SYNC with the inline script at the top of admin/login.html -- it reads the same two keys.
const HINT_KEY = "nd_admin_hint"; // localStorage: a verified admin session exists in this browser
const FASTPATH_KEY = "nd_admin_fp"; // sessionStorage: login.html already sent this tab to the dashboard once

/** Call once the dashboard has confirmed a real admin is signed in. */
export function rememberAdmin() {
  try { localStorage.setItem(HINT_KEY, "1"); } catch {}
  // The shortcut worked (we are on an admin page, not bounced back), so it may be used again next time.
  // If it hadn't worked, this stays set and login.html refuses to send the tab on a second time,
  // which is what makes a redirect loop between the two pages impossible.
  try { sessionStorage.removeItem(FASTPATH_KEY); } catch {}
}

/** Call when there is no admin session any more (signed out, expired, or never real). */
export function forgetAdmin() {
  try { localStorage.removeItem(HINT_KEY); } catch {}
}
