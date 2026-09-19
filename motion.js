/* N.D. Flow — light motion. CSS + Intersection Observer. No library. */
(function () {
  "use strict";
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var SELECTORS = [
    ".service-card",
    ".why-item",
    ".review",
    ".work-item",
    ".gallery-fig",
    ".areas-list li",
    ".about-block",
    ".section-header",
    ".trust-item",
    ".reach-inner",
    ".emergency-inner",
    ".contact-left",
    ".contact-form",
    ".staging-item",
  ];

  function mark(el, i) {
    if (el.classList.contains("reveal")) return;
    el.classList.add("reveal");
    var delay = i % 6;
    if (delay) el.classList.add("reveal-d" + delay);
  }

  function observe(root) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );
    root.querySelectorAll(".reveal").forEach(function (el) {
      io.observe(el);
    });
    return io;
  }

  function scan(scope) {
    var i = 0;
    SELECTORS.forEach(function (sel) {
      scope.querySelectorAll(sel).forEach(function (el) {
        mark(el, i++);
      });
    });
  }

  function boot() {
    scan(document);
    var io = observe(document);

    ["gallery-grid", "reviews-grid", "services-grid", "why-list", "work-list", "areas-list"].forEach(
      function (id) {
        var node = document.getElementById(id);
        if (!node) return;
        var mo = new MutationObserver(function () {
          var n = 0;
          node.querySelectorAll(SELECTORS.join(",")).forEach(function (el) {
            mark(el, n++);
          });
          node.querySelectorAll(".reveal:not(.is-in)").forEach(function (el) {
            io.observe(el);
          });
        });
        mo.observe(node, { childList: true });
      }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
