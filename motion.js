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
