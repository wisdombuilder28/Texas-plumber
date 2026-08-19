/* N.D. Flow Plumbing Co. — PWA registration + install experience */
(function () {
  "use strict";

  var isLocalDev =
    location.protocol === "file:" ||
    ["localhost", "127.0.0.1", "[::1]"].indexOf(location.hostname) !== -1;

  // 1. Register the service worker (https only, not on local dev).
  if ("serviceWorker" in navigator && !isLocalDev && location.protocol === "https:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function (err) {
        console.warn("Service worker registration failed:", err);
      });
    });
  }

  // 2. Install button handling.
  var deferredPrompt = null;
  var buttons = [];

  function collectButtons() {
    buttons = Array.prototype.slice.call(document.querySelectorAll("[data-install-app]"));
  }

  function showButtons(show) {
    collectButtons();
    buttons.forEach(function (btn) {
      btn.hidden = !show;
      btn.style.display = show ? "" : "none";
    });
  }

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  showButtons(false);

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone()) showButtons(true);
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-install-app]") : null;
    if (!btn) return;
    e.preventDefault();
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        showButtons(false);
      });
    } else {
      showIosTip();
    }
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    showButtons(false);
    hideIosTip();
  });

  // 3. iOS "Add to Home Screen" tip (Safari has no install prompt API).
  var IOS_TIP_KEY = "ndflow-ios-tip-dismissed";

  function isIos() {
    return (
      /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  function isSafari() {
    var ua = window.navigator.userAgent;
    return /safari/i.test(ua) && !/crios|fxios|edgios|chrome/i.test(ua);
  }

  function hideIosTip() {
    var tip = document.getElementById("ios-install-tip");
    if (tip) tip.hidden = true;
  }

  function showIosTip() {
    var tip = document.getElementById("ios-install-tip");
    if (tip) tip.hidden = false;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var tip = document.getElementById("ios-install-tip");
    var close = document.getElementById("ios-install-tip-close");
    if (close) {
      close.addEventListener("click", function () {
        hideIosTip();
        try {
          localStorage.setItem(IOS_TIP_KEY, "1");
        } catch (err) {}
      });
    }
    if (!tip || isStandalone()) return;

    var dismissed = false;
    try {
      dismissed = localStorage.getItem(IOS_TIP_KEY) === "1";
    } catch (err) {}

    if (isIos() && isSafari() && !dismissed) {
      setTimeout(function () {
        tip.hidden = false;
      }, 2500);
    }
    // On iOS the button is the only way in, so show it there too.
    if (isIos() && !dismissed) showButtons(true);
  });
})();
