/* N.D. Flow Admin: put the admin on the phone's home screen, as its own app.
   An installed admin opens straight on the dashboard in one tap (no typing the address, no browser bar), and long-pressing
   its icon offers "Upload videos" / "Upload photos" shortcuts. See admin/admin.webmanifest.

   This script only OFFERS that, once, after sign-in:
     - Chrome / Edge / Samsung Internet: a small card with an "Add" button (it uses the browser's own install prompt).
     - iPhone / iPad Safari has no install button for web pages, so the card explains "Share -> Add to Home Screen" instead.
   It never shows inside the installed app, never again once installed, and "x" (Not now) hides it for 30 days.
   Plain script, no imports. If anything here fails, nothing else on the page is affected. */
(function () {
  "use strict";

  var SNOOZE_KEY = "nd_admin_install_snooze"; // when "Not now" was last pressed
  var DONE_KEY = "nd_admin_installed";        // set once the app has been installed from this browser
  var SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

  function read(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage blocked: the offer just comes back next time */ } }

  // The public site's service worker already ignores everything under /admin. Registering it here only makes sure it exists
  // in a browser that went straight to /admin (some Chrome versions only offer "Install" once a service worker is registered).
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  var insideApp = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  if (insideApp || read(DONE_KEY) === "1") return;
  var snoozedAt = Number(read(SNOOZE_KEY)) || 0;
  if (snoozedAt && Date.now() - snoozedAt < SNOOZE_MS) return;

  var ua = navigator.userAgent || "";
  var onIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var iosSafari = onIos && /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);

  var installOffer = null; // the browser's own install prompt, kept until the person presses "Add"
  var card = null;
  var queued = false;

  function addStyles() {
    var style = document.createElement("style");
    style.textContent = [
      ".ndapp{position:fixed;z-index:70;left:.75rem;right:.75rem;bottom:calc(4.9rem + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:.75rem;padding:.75rem .6rem .75rem .8rem;border-radius:1rem;background:#17171a;color:#f5f1e8;border:1px solid rgba(216,164,56,.45);box-shadow:0 18px 40px rgba(0,0,0,.45);font:500 .85rem/1.35 Inter,system-ui,sans-serif;animation:ndappIn .35s ease both}",
      ".ndapp img{width:2.5rem;height:2.5rem;border-radius:.6rem;flex:none}",
      ".ndapp b{display:block;font-weight:700;font-size:.9rem}",
      ".ndapp span{color:#c9c4b8}",
      ".ndapp-go{margin-left:auto;flex:none;border:0;border-radius:.6rem;padding:.65rem 1rem;background:#d8a438;color:#17120a;font:700 .85rem Inter,system-ui,sans-serif;cursor:pointer}",
      ".ndapp-x{flex:none;border:0;background:transparent;color:#b9b4a8;font:600 1.3rem/1 system-ui,sans-serif;width:2.25rem;height:2.25rem;border-radius:.6rem;cursor:pointer}",
      ".ndapp-x:hover,.ndapp-go:hover{filter:brightness(1.12)}",
      ".ndapp-go:focus-visible,.ndapp-x:focus-visible{outline:2px solid #d8a438;outline-offset:2px}",
      "@media(min-width:900px){.ndapp{left:auto;right:1.25rem;bottom:1.25rem;width:23rem}}",
      "@keyframes ndappIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@media(prefers-reduced-motion:reduce){.ndapp{animation:none}}"
    ].join("\n");
    document.head.appendChild(style);
  }

  function hide() {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  function show(kind) {
    if (card || !document.body) return;
    addStyles();

    card = document.createElement("div");
    card.className = "ndapp";
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Add the admin to your home screen");

    var icon = document.createElement("img");
    icon.src = "/assets/admin-icon-192.png";
    icon.alt = "";
    icon.width = 40;
    icon.height = 40;

    var text = document.createElement("div");
    var title = document.createElement("b");
    title.textContent = "Put the admin on your home screen";
    var hint = document.createElement("span");
    hint.textContent = kind === "ios"
      ? "Tap the Share button, then “Add to Home Screen”."
      : "One tap to open it. No typing, no browser bar.";
    text.appendChild(title);
    text.appendChild(hint);

    card.appendChild(icon);
    card.appendChild(text);

    if (kind === "button") {
      var add = document.createElement("button");
      add.type = "button";
      add.className = "ndapp-go";
      add.textContent = "Add";
      add.addEventListener("click", function () {
        var offer = installOffer;
        installOffer = null;
        if (!offer) { hide(); return; }
        offer.prompt();
        offer.userChoice
          .then(function (choice) {
            write(choice && choice.outcome === "accepted" ? DONE_KEY : SNOOZE_KEY, choice && choice.outcome === "accepted" ? "1" : String(Date.now()));
            hide();
          })
          .catch(hide);
      });
      card.appendChild(add);
    }

    var close = document.createElement("button");
    close.type = "button";
    close.className = "ndapp-x";
    close.setAttribute("aria-label", "Not now");
    close.textContent = "×";
    close.addEventListener("click", function () {
      write(SNOOZE_KEY, String(Date.now()));
      hide();
    });
    card.appendChild(close);

    document.body.appendChild(card);
  }

  // Wait until the dashboard has confirmed the sign-in (it adds "auth-ready" to <body>), then a beat more.
  function afterSignIn(then) {
    if (queued) return;
    queued = true;
    function signedIn() { return document.body.classList.contains("auth-ready"); }
    function soon() { setTimeout(then, 1500); }
    if (signedIn()) { soon(); return; }
    var watcher = new MutationObserver(function () {
      if (signedIn()) { watcher.disconnect(); soon(); }
    });
    watcher.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault(); // keep the browser's own pop-up away; the card above is friendlier
    installOffer = event;
    afterSignIn(function () { show("button"); });
  });

  window.addEventListener("appinstalled", function () {
    write(DONE_KEY, "1");
    hide();
  });

  if (iosSafari) afterSignIn(function () { show("ios"); });
})();
