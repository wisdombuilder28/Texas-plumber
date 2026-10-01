/* N.D. Flow - mobile menu. One controller for every page (it used to be copied into script.js and work.js).
   const/let only. No innerHTML. */
(() => {
  const toggle = document.getElementById("menu-toggle");
  const panel = document.getElementById("mobile-nav");
  if (!toggle || !panel) return;

  const header = toggle.closest(".site-header");
  const links = panel.querySelectorAll("nav > a:not(.btn-accent)");
  const norm = (p) => p.replace(/index\.html$/, "").replace(/\.html$/, "").replace(/\/$/, "") || "/";
  const here = norm(location.pathname);

  const scrim = document.createElement("div");
  scrim.className = "nav-scrim";
  document.body.appendChild(scrim);

  // Hamburger/X is three CSS-animated bars, not icon markup swapped on every toggle.
  toggle.replaceChildren(...[0, 1, 2].map(() => {
    const bar = document.createElement("span");
    bar.className = "bar";
    return bar;
  }));
  toggle.setAttribute("aria-controls", "mobile-nav");

  links.forEach((a, i) => {
    a.style.setProperty("--i", i); // stagger order for the open animation
    const url = new URL(a.href, location.href);
    if (!url.hash && norm(url.pathname) === here) a.setAttribute("aria-current", "page");
  });

  const isOpen = () => panel.classList.contains("open");
  const setOpen = (open) => {
    panel.classList.toggle("open", open);
    if (header) header.classList.toggle("nav-open", open);
    document.documentElement.classList.toggle("nav-open", open); // scroll lock (see styles.css)
    document.body.classList.toggle("nav-open", open); // scrim + hides the floating contact button
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };

  setOpen(false);
  toggle.addEventListener("click", () => setOpen(!isOpen()));
  scrim.addEventListener("click", () => setOpen(false));
  links.forEach((a) => a.addEventListener("click", () => setOpen(false)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) { setOpen(false); toggle.focus(); }
  });
  window.matchMedia("(min-width:1440px)").addEventListener("change", (e) => { if (e.matches) setOpen(false); });
})();
