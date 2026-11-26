/* N.D. Flow - site menus. One controller for every page (it used to be copied into script.js and work.js).
   1. The mobile menu (hamburger -> dark card).
   2. The "Recent Work" choice between Images and Videos: a drop-down under the desktop nav (1280px and up),
      and an expanding group inside the mobile menu. Both are plain disclosure buttons (aria-expanded) over real links.
   const/let only. No innerHTML. */
(() => {
  const toggle = document.getElementById("menu-toggle");
  const panel = document.getElementById("mobile-nav");
  if (!toggle || !panel) return;

  const header = toggle.closest(".site-header");
  const norm = (p) => p.replace(/index\.html$/, "").replace(/\.html$/, "").replace(/\/$/, "") || "/";
  const here = norm(location.pathname);
  const isHere = (a) => {
    const url = new URL(a.href, location.href);
    return !url.hash && norm(url.pathname) === here;
  };

  // Rows of the mobile menu, top to bottom: the plain links and the Recent Work group.
  const rows = panel.querySelectorAll("nav > a:not(.btn-accent), nav > .mnav-dd");
  // Every link that should mark the page you are on (and close the menu when tapped).
  const links = panel.querySelectorAll("nav > a:not(.btn-accent), nav > .mnav-dd .mnav-dd-link");

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

  rows.forEach((row, i) => row.style.setProperty("--i", i)); // stagger order for the open animation
  links.forEach((a) => {
    if (isHere(a)) a.setAttribute("aria-current", "page");
  });

  // ---------- Recent Work: Images / Videos, in the mobile menu ----------
  const group = panel.querySelector(".mnav-dd");
  const groupBtn = group && group.querySelector(".mnav-dd-btn");
  const groupInner = group && group.querySelector(".mnav-dd-inner");
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const setGroup = (open) => {
    if (!group) return;
    group.classList.toggle("is-open", open);
    groupBtn.setAttribute("aria-expanded", String(open));
  };

  // On a short phone the menu card scrolls: once the group is open, bring its last row into view.
  const revealGroup = () => {
    const bottom = group.offsetTop + groupBtn.offsetHeight + groupInner.scrollHeight; // where the group ends once fully open
    const overflow = bottom + 12 - (panel.scrollTop + panel.clientHeight);
    if (overflow > 0) panel.scrollTo({ top: panel.scrollTop + overflow, behavior: reduceMotion() ? "auto" : "smooth" });
  };

  if (group) {
    if (group.querySelector('.mnav-dd-link[aria-current="page"]')) group.classList.add("is-current");
    groupBtn.addEventListener("click", () => {
      const open = !group.classList.contains("is-open");
      setGroup(open);
      if (open) revealGroup();
    });
  }

  // ---------- Recent Work: Images / Videos, under the desktop nav ----------
  const dd = document.querySelector(".nav-desktop .nav-dd");
  const ddBtn = dd && dd.querySelector(".nav-dd-btn");
  const ddLinks = dd ? Array.from(dd.querySelectorAll(".nav-dd-link")) : [];
  const ddOpen = () => !!dd && dd.classList.contains("is-open");

  const setDd = (open) => {
    if (!dd) return;
    dd.classList.toggle("is-open", open);
    ddBtn.setAttribute("aria-expanded", String(open));
  };

  if (dd) {
    ddLinks.forEach((a) => {
      if (isHere(a)) a.setAttribute("aria-current", "page");
    });
    if (ddLinks.some((a) => a.getAttribute("aria-current") === "page")) dd.classList.add("is-current");

    ddBtn.addEventListener("click", () => setDd(!ddOpen()));
    // Arrow keys: Down opens the card and lands on the first choice; Up/Down/Home/End move between choices.
    ddBtn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      setDd(true);
      ddLinks[0].focus();
    });
    dd.addEventListener("keydown", (e) => {
      const at = ddLinks.indexOf(e.target); // -1 when the key was pressed on the button itself (its own handler above)
      if (!ddOpen() || at === -1) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        ddLinks[(at + (e.key === "ArrowDown" ? 1 : -1) + ddLinks.length) % ddLinks.length].focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        ddLinks[0].focus();
      } else if (e.key === "End") {
        e.preventDefault();
        ddLinks[ddLinks.length - 1].focus();
      }
    });
    // Esc folds the card (and hands the keyboard back to the button if it was inside).
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !ddOpen()) return;
      const inside = dd.contains(document.activeElement);
      setDd(false);
      if (inside) ddBtn.focus();
    });
    // Tabbing out of the card, or tapping anywhere else on the page, closes it.
    dd.addEventListener("focusout", (e) => {
      if (ddOpen() && e.relatedTarget && !dd.contains(e.relatedTarget)) setDd(false);
    });
    document.addEventListener("click", (e) => {
      if (ddOpen() && !dd.contains(e.target)) setDd(false);
    });
    ddLinks.forEach((a) => a.addEventListener("click", () => setDd(false)));
  }

  // ---------- the mobile menu itself ----------
  const isOpen = () => panel.classList.contains("open");
  const setOpen = (open) => {
    panel.classList.toggle("open", open);
    if (header) header.classList.toggle("nav-open", open);
    document.documentElement.classList.toggle("nav-open", open); // scroll lock (see styles.css)
    document.body.classList.toggle("nav-open", open); // scrim + hides the floating contact button
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (!open) setGroup(false); // the menu always opens with Recent Work folded
  };

  setOpen(false);
  toggle.addEventListener("click", () => setOpen(!isOpen()));
  scrim.addEventListener("click", () => setOpen(false));
  links.forEach((a) => a.addEventListener("click", () => setOpen(false)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) { setOpen(false); toggle.focus(); }
  });
  window.matchMedia("(min-width:1280px)").addEventListener("change", (e) => { // same width as the full-header rule in styles.css
    if (e.matches) setOpen(false);
    setDd(false); // whichever menu is now hidden starts folded again
  });
})();

/* Admin shortcut: a small "Admin" button that takes the admin straight to the dashboard.
   It is only drawn in a browser where an admin is already signed in -- admin/js/admin-hint.js keeps that note in
   localStorage under "nd_admin_hint" -- so visitors never see it. It grants nothing: the dashboard still checks the
   real sign-in. Change SHOW_ADMIN_BUTTON to false to switch it off. */
(() => {
  const SHOW_ADMIN_BUTTON = true;
  if (!SHOW_ADMIN_BUTTON || location.pathname.startsWith("/admin")) return;

  let adminHere = false;
  try { adminHere = localStorage.getItem("nd_admin_hint") === "1"; } catch (e) { /* storage blocked: no button */ }
  if (!adminHere) return;

  const NS = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(NS, "svg"); // the "layout-dashboard" icon, drawn here so it never waits for the icon library
  [["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"],
   ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]
    .forEach(([k, v]) => icon.setAttribute(k, v));
  [[3, 3, 7, 9], [14, 3, 7, 5], [14, 12, 7, 9], [3, 16, 7, 5]].forEach(([x, y, w, h]) => {
    const r = document.createElementNS(NS, "rect");
    [["x", x], ["y", y], ["width", w], ["height", h], ["rx", 1]].forEach(([k, v]) => r.setAttribute(k, v));
    icon.appendChild(r);
  });

  const chip = document.createElement("a");
  chip.className = "admin-chip";
  chip.href = "/admin/dashboard.html";
  chip.rel = "nofollow";
  chip.setAttribute("aria-label", "Open the admin dashboard");
  const label = document.createElement("span");
  label.textContent = "Admin";
  chip.append(icon, label);
  document.body.appendChild(chip);
})();
