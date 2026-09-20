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
   not gate this — it's a functional control, everyone needs it.
   Built with createElement/textContent throughout — no innerHTML,
   matching the note at the top of this file. */
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

  const icon = (name, cls) => {
    const el = document.createElement("i");
    el.setAttribute("data-lucide", name);
    if (cls) el.className = cls;
    return el;
  };

  const makeOption = (channel, href, label) => {
    const a = document.createElement("a");
    a.href = href;
    a.setAttribute("role", "menuitem");
    a.className = channel === "whatsapp" ? "contact-option contact-option-wa" : "contact-option";
    a.dataset.channel = channel;
    if (channel === "whatsapp") {
      a.target = "_blank";
      a.rel = "noopener";
    }
    a.appendChild(icon(channel === "call" ? "phone" : "message-circle", "icon-sm"));
    const span = document.createElement("span");
    span.textContent = label;
    a.appendChild(span);
    return a;
  };

  const buildMenu = (source) => {
    const menu = document.createElement("div");
    menu.className = "contact-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    [makeOption("call", PHONE_TEL, "Call"), makeOption("whatsapp", WA_URL, "WhatsApp")].forEach((a) => {
      menu.appendChild(a);
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
    anchor.appendChild(icon("chevron-down", "contact-chevron"));

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

  // Floating contact button, always visible.
  const fab = document.createElement("div");
  fab.className = "contact-fab";
  const fabTrigger = document.createElement("button");
  fabTrigger.type = "button";
  fabTrigger.className = "contact-fab-trigger";
  fabTrigger.setAttribute("aria-haspopup", "true");
  fabTrigger.setAttribute("aria-expanded", "false");
  fabTrigger.setAttribute("aria-label", "Contact us — call or WhatsApp");
  fabTrigger.appendChild(icon("message-circle"));
  fab.appendChild(fabTrigger);

  const fabMenu = buildMenu("fab");
  fabMenu.classList.add("contact-fab-menu");
  fab.appendChild(fabMenu);
  document.body.appendChild(fab);

  fabTrigger.addEventListener("click", () => openTrigger(fabTrigger, fabMenu));

  document.addEventListener("click", (e) => {
    if (openMenu && !openMenu.trigger.parentNode.contains(e.target)) closeOpen();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOpen();
  });

  if (window.lucide) lucide.createIcons();
})();
