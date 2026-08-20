// work.js
// Shared page chrome (mobile nav, footer year, admin shortcut) for secondary
// pages like work.html. Homepage-only rendering (services, reviews, contact
// form) lives in script.js and isn't needed here — this page doesn't have
// those sections, so loading script.js as-is here would throw immediately.

const iconTag = (name, cls = "icon") => `<i data-lucide="${name}" class="${cls}"></i>`;

// Mobile menu
const toggle = document.getElementById("menu-toggle");
const mobileNav = document.getElementById("mobile-nav");
toggle.addEventListener("click", () => {
  const open = mobileNav.classList.toggle("open");
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  toggle.innerHTML = open ? iconTag("x") : iconTag("menu");
  if (window.lucide) lucide.createIcons();
});
mobileNav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => {
  mobileNav.classList.remove("open");
  toggle.innerHTML = iconTag("menu");
  if (window.lucide) lucide.createIcons();
}));

// Footer year
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Initialize icons
if (window.lucide) lucide.createIcons();

/* ---------------------------------------------------------------
   Hidden admin shortcut: 3 quick taps on the logo -> /admin
   Navigation convenience only. Firebase Auth still guards everything
   behind /admin, so this grants no access on its own.
----------------------------------------------------------------*/
(function adminTapShortcut() {
  const TAPS_REQUIRED = 3;
  const WINDOW_MS = 1200;
  let taps = 0;
  let timer = null;

  const reset = () => {
    taps = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const handleTap = (e) => {
    taps += 1;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reset, WINDOW_MS);

    if (taps >= TAPS_REQUIRED) {
      e.preventDefault();
      reset();
      window.location.href = "/admin";
    }
  };

  document.querySelectorAll(".brand-mark, .brand-mark img").forEach((el) => {
    el.addEventListener("click", handleTap);
  });
})();
