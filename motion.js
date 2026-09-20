/* N.D. Flow — scroll motion. const/let only. No innerHTML. */
(() => {
  "use strict";

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SELECTORS = [
    ".service-card",
    ".why-item",
    ".review",
    ".work-item",
    ".gallery-fig",
    ".areas-list li",
    ".about-block",
    ".section-header",
    ".emergency-inner",
    ".contact-left",
    ".contact-form",
  ];

  const play = (el) => {
    if (el.dataset.motionPlayed === "1") return;
    el.dataset.motionPlayed = "1";
    el.classList.add("motion-play");
  };

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        play(entry.target);
        io.unobserve(entry.target);
      });
    },
    { threshold: 0.16, rootMargin: "0px 0px -12% 0px" }
  );

  const watch = (root) => {
    SELECTORS.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el, index) => {
        if (el.dataset.motionWatched === "1") return;
        el.dataset.motionWatched = "1";
        el.style.animationDelay = `${(index % 4) * 90}ms`;
        el.classList.add("motion-init");
        io.observe(el);
      });
    });
  };

  const boot = () => {
    watch(document);

    [
      "gallery-grid",
      "reviews-grid",
      "services-grid",
      "why-list",
      "work-list",
      "areas-list",
    ].forEach((id) => {
      const node = document.getElementById(id);
      if (!node) return;
      new MutationObserver(() => watch(node)).observe(node, { childList: true });
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();

/* ---------- Contact channel picker (Call / WhatsApp) ----------
   Deliberately a separate top-level IIFE from the block above: the
   reduced-motion check up there is about decorative motion and must
   not gate this — it's a functional control, everyone needs it. */
(() => {
  "use strict";
  const PHONE_TEL = "tel:+2349016836967";
  const WA_URL =
    "https://wa.me/2349016836967?text=" +
    encodeURIComponent("Hi, I'd like to enquire about a plumbing job.");

  const track = (channel, source) => {
    if (typeof gtag === "function") {
      gtag("event", "contact_choice", { channel, source });
    }
  };

  let openMenu = null;
  const closeOpen = () => {
    if (!openMenu) return;
    openMenu.menu.hidden = true;
    openMenu.trigger.setAttribute("aria-expanded", "false");
    openMenu = null;
  };

  const buildMenu = (source) => {
    const menu = document.createElement("div");
    menu.className = "contact-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    menu.innerHTML =
      `<a href="${PHONE_TEL}" role="menuitem" class="contact-option" data-channel="call">` +
      `<i data-lucide="phone" class="icon-sm"></i><span>Call</span></a>` +
      `<a href="${WA_URL}" role="menuitem" class="contact-option contact-option-wa" data-channel="whatsapp" target="_blank" rel="noopener">` +
      `<i data-lucide="message-circle" class="icon-sm"></i><span>WhatsApp</span></a>`;
    menu.querySelectorAll("[data-channel]").forEach((a) => {
      a.addEventListener("click", () => {
        track(a.dataset.channel, source);
        closeOpen();
      });
    });
    return menu;
  };

  const openTrigger = (trigger, menu) => {
    const wasOpen = openMenu && openMenu.trigger === trigger;
    closeOpen();
    if (wasOpen) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openMenu = { trigger, menu };
  };

  // Upgrade every existing "Call Now"-style button site-wide. Selector
  // is scoped to href^="tel:" so unrelated .btn-accent buttons (e.g.
  // "Request Service" linking to the contact form) are untouched.
  document.querySelectorAll('a.btn-accent[href^="tel:"]').forEach((anchor) => {
    if (anchor.dataset.contactUpgraded === "1") return;
    anchor.dataset.contactUpgraded = "1";

    // Move the ORIGINAL anchor into a new wrapper rather than rebuilding
    // it, so every existing class/inline style/icon is preserved exactly.
    const wrapper = document.createElement("div");
    wrapper.className = "contact-choice";
    anchor.parentNode.insertBefore(wrapper, anchor);
    wrapper.appendChild(anchor);

    anchor.setAttribute("aria-haspopup", "true");
    anchor.setAttribute("aria-expanded", "false");
    anchor.insertAdjacentHTML(
      "beforeend",
      '<i data-lucide="chevron-down" class="contact-chevron"></i>'
    );

    const menu = buildMenu("inline");
    wrapper.appendChild(menu);

    // preventDefault only happens here, after the handler is confirmed
    // attached — so if this script fails to load for any reason, the
    // original tel: link still works exactly as it did before.
    anchor.addEventListener("click", (e) => {
      e.preventDefault();
      openTrigger(anchor, menu);
    });
    anchor.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        anchor.click();
      }
    });
  });

  // Floating contact button, revealed once the visitor has scrolled.
  const fab = document.createElement("div");
  fab.className = "contact-fab";
  fab.innerHTML =
    '<button type="button" class="contact-fab-trigger" aria-haspopup="true" ' +
    'aria-expanded="false" aria-label="Contact us — call or WhatsApp">' +
    '<i data-lucide="message-circle"></i></button>';
  const fabMenu = buildMenu("fab");
  fabMenu.classList.add("contact-fab-menu");
  fab.appendChild(fabMenu);
  document.body.appendChild(fab);

  const fabTrigger = fab.querySelector(".contact-fab-trigger");
  fabTrigger.addEventListener("click", () => openTrigger(fabTrigger, fabMenu));

  document.addEventListener("click", (e) => {
    if (openMenu && !openMenu.trigger.parentNode.contains(e.target)) closeOpen();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOpen();
  });

  if (window.lucide) lucide.createIcons();
})();
