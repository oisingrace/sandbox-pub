// ==UserScript==
// @name         YouTube Tidy
// @description  Mobile YouTube with no Shorts and less jank. Same look, fewer annoyances.
// @version      1.0
// @match        *://m.youtube.com/*
// @match        *://www.youtube.com/*
// @match        *://youtube.com/*
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ---------- 1. Shorts links open as normal videos ----------
  // /shorts/abc123 -> /watch?v=abc123 (full player, seek bar, no endless swiping)
  function shortsToWatch(path) {
    var m = /^\/shorts\/([\w-]{6,})/.exec(path);
    return m ? "/watch?v=" + m[1] : null;
  }

  function checkUrl() {
    var target = shortsToWatch(location.pathname);
    if (target) location.replace(target);
  }
  checkUrl();

  // YouTube changes pages without reloading, so keep an eye on the URL.
  var lastUrl = location.href;
  setInterval(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      checkUrl();
    }
  }, 250);
  window.addEventListener("popstate", checkUrl);

  // Catch taps on Shorts links before YouTube opens the Shorts player.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href*="/shorts/"]');
    if (!a) return;
    var url = new URL(a.href, location.href);
    var target = shortsToWatch(url.pathname);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    location.href = target;
  }, true);

  // ---------- 2. Styles: hide Shorts, promos, fix iOS quirks ----------
  var css = `
    /* --- Shorts shelves, cards and the Shorts tab --- */
    ytm-reel-shelf-renderer,
    ytm-reel-item-renderer,
    ytm-shorts-lockup-view-model,
    ytm-shorts-lockup-view-model-v2,
    ytm-rich-section-renderer:has(ytm-reel-shelf-renderer),
    ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model),
    ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2),
    ytm-item-section-renderer:has(> ytm-reel-shelf-renderer),
    grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
    grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2),
    ytm-rich-item-renderer:has(a[href*="/shorts/"]),
    ytm-video-with-context-renderer:has(a[href*="/shorts/"]),
    ytm-compact-video-renderer:has(a[href*="/shorts/"]),
    ytm-pivot-bar-item-renderer:has(.pivot-shorts),
    ytm-pivot-bar-item-renderer:has(a[href^="/shorts"]),
    [data-yt-tidy-hide] {
      display: none !important;
    }

    /* --- "Open the app" / "Try Premium" nags --- */
    ytm-mealbar-promo-renderer,
    ytm-statement-banner-renderer,
    ytm-app-promo-renderer,
    ytm-upsell-dialog-renderer,
    .mealbar-promo-renderer {
      display: none !important;
    }

    /* --- iOS jank fixes --- */
    html { -webkit-text-size-adjust: 100%; }
    * { -webkit-tap-highlight-color: transparent; }
    /* no 300ms tap delay / accidental double-tap zoom */
    a, button, [role="button"], ytm-pivot-bar-item-renderer { touch-action: manipulation; }
    /* stop Safari zooming the page in when you tap the search box */
    input, textarea, .searchbox-input { font-size: 16px !important; }
    /* stop the header and page rubber-banding against each other */
    html, body { overscroll-behavior-y: none; }
    /* reserve space for thumbnails so the feed doesn't jump while loading */
    .media-item-thumbnail-container,
    .video-thumbnail-container-large,
    .video-thumbnail-container-compact { aspect-ratio: 16 / 9; }
  `;

  function addStyle() {
    if (document.getElementById("yt-tidy-style")) return;
    if (!document.documentElement) {
      // Too early in page load; try again on the next tick.
      setTimeout(addStyle, 0);
      return;
    }
    var style = document.createElement("style");
    style.id = "yt-tidy-style";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  addStyle();

  // ---------- 3. Things CSS can't catch by itself ----------
  // The "Shorts" filter chip, the Shorts tab, and shelves titled "Shorts".
  function isShortsLabel(el) {
    return el && el.textContent && el.textContent.trim().toLowerCase() === "shorts";
  }

  function sweep() {
    addStyle(); // YouTube sometimes rebuilds <head>
    var chips = document.querySelectorAll(
      "ytm-chip-cloud-chip-renderer, yt-chip-cloud-chip-renderer, chip-shape, ytm-pivot-bar-item-renderer"
    );
    for (var i = 0; i < chips.length; i++) {
      if (!chips[i].hasAttribute("data-yt-tidy-hide") && isShortsLabel(chips[i])) {
        chips[i].setAttribute("data-yt-tidy-hide", "");
      }
    }
    var titles = document.querySelectorAll(
      "ytm-shelf-renderer h2, ytm-rich-section-renderer h2, ytm-item-section-renderer h2"
    );
    for (var j = 0; j < titles.length; j++) {
      if (isShortsLabel(titles[j])) {
        var box = titles[j].closest("ytm-shelf-renderer, ytm-rich-section-renderer, ytm-item-section-renderer");
        if (box) box.setAttribute("data-yt-tidy-hide", "");
      }
    }
  }

  // Batch DOM changes into one sweep per frame so it stays smooth.
  var queued = false;
  function queueSweep() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      sweep();
    });
  }

  function start() {
    if (!document.documentElement) return;
    sweep();
    new MutationObserver(queueSweep).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
