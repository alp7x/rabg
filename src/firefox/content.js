/*
 * RABG: Add Beaten Badges to RetroAchievements — content script
 * ------------------------------------------------------------------
 * Reorganizes the "Game Awards" box on a RetroAchievements profile into
 * two labeled groups (Mastered / Beaten) and adds settings to the site
 * footer (under "Theme"):
 *
 *   Game Awards
 *   Mastered   👑 (hardcore mastered)   🎖 (softcore completed)
 *   ─────────── divider ───────────
 *   Beaten     silver-crown (hardcore)   🎖 (softcore)
 *
 * Footer settings: Beaten Sort (select), Beaten Size + Beaten Color
 * (sliders), Manual Order (toggle — own profile only), Export and Import.
 *
 * * Manual Order (own profile only): when enabled, the owner's beaten
 *   badges render in a personally arranged order. "Edit Badges" starts an
 *   edit mode: press-and-hold-drag to reorder (mouse + touch), ✕ hides a
 *   badge (hidden badges sit at the end, half-transparent, restorable via
 *   ＋), "Save" keeps it, "Discard" leaves, "Reset" restores the default. New beaten games append at the end,
 *   visible. Data is per-profile: {order:[gameIds], hidden:[gameIds]}.
 *
 * Storage: all RABG settings live in the extension's storage.local
 * (shared with the popup and across tabs). Settings previously kept in
 * the page's localStorage are migrated automatically, once.
 *
 * - Mastered/Completed counters keep RA's own hover descriptions.
 * - Beaten counters show true hardcore/softcore totals from Progression
 *   Status; the hover notes "(N hidden)" = true total − badges shown.
 * - Creates a Game Awards box for profiles that have none.
 * - Games already mastered are excluded from Beaten.
 * - Complete beaten list: the profile's Completion Progress only lists the
 *   games with the highest completion %, so the Beaten section is always
 *   built from the user's progress pages (filtered to "beaten", 100 games
 *   per page): read in the background, shown as they arrive and cached per
 *   profile (refreshed when the beaten totals change, or via the Sync
 *   button). The same pages carry time-to-beat and the last-unlock date,
 *   which power the extra sort options.
 */
(function () {
  "use strict";

  /* ---------- constants ---------------------------------------------- */

  var crownUrls = { gold: "", silver: "" };
  var SORT_KEY = "ra-beaten-sort-v1";
  var SIZE_KEY = "rabg-beaten-size";    // "50"–"100" (% of full size)
  var COLOR_KEY = "rabg-beaten-color";  // "0"–"100" (% color; 0 = grayscale)
  var MANUAL_ENABLED_KEY = "rabg-manual-enabled"; // "1" / "0"
  var MANUAL_KEY_PREFIX = "rabg-manual-";         // + username → {order, hidden}
  var MANUAL_USER_PREFIX = "rabg-manual-u-";   // + lowercased username → {order, hidden}
  var POPUP_THEME_KEY = "rabg-popup-theme";
  var CACHE_PREFIX = "rabg-cache-";            // + lowercased username → complete beaten list
  var CACHE_INDEX_KEY = "rabg-cache-index";    // LRU list of cached usernames
  var CACHE_VERSION = 2;           // written as 2 (short image form); 1 (v1.4.0) is still readable
  var FLASH_MS = 4000;             // how long "Synced ✓" stays next to the Beaten label
  var CACHE_MAX_PROFILES = 20;     // other people's profiles (your own never counts)
  var SYNC_PAGE_DELAY_MS = 400;                // politeness delay between progress pages
  var SYNC_MAX_PAGES = 60;                     // safety cap (6,000 beaten games)
  var SYNC_RETRIES = 2;                        // extra attempts per page after a network/server hiccup
  var SYNC_RETRY_DELAY_MS = 1500;              // wait before retry 1 (doubled for retry 2)
  var SYNC_TIMEOUT_MS = 20000;                 // give up on a page that doesn't answer
  var QUICK_MAX_PAGES = 3;                     // quick refresh: newest pages looked at before a full reload
  var LEGACY_KEYS = [SORT_KEY, SIZE_KEY, COLOR_KEY];
  var GRID_CLASSES =
    "component w-full place-content-center bg-embed gap-2 grid " +
    "grid-cols-[repeat(auto-fill,minmax(52px,52px))] xl:rounded xl:py-2";
  var SORT_OPTIONS = [
    ["pct-desc", "Percentage (highest)"],
    ["pct-asc", "Percentage (lowest)"],
    ["title-asc", "Game Title (A-Z)"],
    ["title-desc", "Game Title (Z-A)"],
    ["ttb-asc", "Time to Beat (shortest)"],
    ["ttb-desc", "Time to Beat (longest)"],
    ["unl-desc", "Last Unlock (newest)"],
    ["unl-asc", "Last Unlock (oldest)"]
  ];
  var HOLD_MS = 150; // press-and-hold time before a badge can be dragged

  /* ---------- storage layer (extension storage.local, with fallback) -- */

  var STORE = {};          // in-memory mirror of all RABG settings
  var usingExtStorage = false;

  function getStorageApi() {
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) return browser.storage;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) return chrome.storage;
    return null;
  }

  function storageGetAll(area, cb) {
    var done = false;
    function finish(items) { if (!done) { done = true; cb(items || {}); } }
    try {
      var p = area.get(null);
      if (p && typeof p.then === "function") { p.then(finish, function () { finish({}); }); return; }
    } catch (e) { /* callback-style API — try below */ }
    try { area.get(null, function (items) { finish(items); }); }
    catch (e) { finish({}); }
  }

  // `onFail` (optional) runs when the browser refuses the write (storage full).
  function storageSetItems(area, obj, onFail) {
    function failed(err) {
      console.info("[RABG] storage write failed:", err);
      if (onFail) { try { onFail(err); } catch (e2) {} }
    }
    try {
      var p = area.set(obj);
      if (p && typeof p.catch === "function") p.catch(failed);
    } catch (e) { failed(e); }
  }

  function persistStore() {
    if (usingExtStorage) {
      storageSetItems(getStorageApi().local, STORE);
    } else {
      try { localStorage.setItem("rabg-store", JSON.stringify(STORE)); } catch (e) {}
    }
  }

  function storeSet(key, value, onFail) {
    STORE[key] = value;
    if (usingExtStorage) {
      var obj = {};
      obj[key] = value;
      storageSetItems(getStorageApi().local, obj, onFail);
    } else {
      persistStore();
    }
  }

  function storeRemove(key) {
    delete STORE[key];
    if (usingExtStorage) {
      try {
        var area = getStorageApi().local;
        var p = area.remove(key);
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) {}
    } else {
      persistStore();
    }
  }

  // One-time migration: settings that used to live in the page's
  // localStorage are copied into extension storage on first run.
  function migrateLegacy() {
    var changed = false;
    for (var i = 0; i < LEGACY_KEYS.length; i++) {
      var k = LEGACY_KEYS[i];
      if (STORE[k] === undefined) {
        try {
          var v = localStorage.getItem(k);
          if (v !== null) { STORE[k] = v; changed = true; }
        } catch (e) {}
      }
    }
    if (changed) persistStore();
  }

  function loadAllPrefs(after) {
    var storage = getStorageApi();
    if (storage && storage.local) {
      usingExtStorage = true;
      var fired = false;
      var go = function (items) {
        if (fired) return;
        fired = true;
        STORE = items || {};
        migrateLegacy();
        after();
      };
      storageGetAll(storage.local, go);
      setTimeout(function () { go(STORE); }, 2000); // safety net
    } else {
      // Fallback (no storage API): keep using the page's localStorage.
      usingExtStorage = false;
      try {
        var raw = localStorage.getItem("rabg-store");
        STORE = raw ? JSON.parse(raw) : {};
      } catch (e) { STORE = {}; }
      migrateLegacy();
      after();
    }
  }

  function sameValue(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  // Keeps this page in sync with changes made in the popup or in other tabs.
  // Every write this page makes itself also comes back through here (the
  // "echo"); those carry nothing new — the page was already updated when the
  // value was set — so they are skipped instead of redrawing everything twice.
  function startStorageListener() {
    var storage = getStorageApi();
    if (!storage || !storage.onChanged || !storage.onChanged.addListener) return;
    storage.onChanged.addListener(function (changes, area) {
      if (area && area !== "local") return;
      var structural = false, changed = false;
      for (var key in changes) {
        var nv = changes[key].newValue;
        var isCache = key === CACHE_INDEX_KEY || key.indexOf(CACHE_PREFIX) === 0;
        if (!isCache && sameValue(STORE[key], nv)) continue;   // our own write, echoed back
        if (nv === undefined) delete STORE[key];
        else STORE[key] = nv;
        if (isCache) continue;   // cached lists never change what is on screen
        changed = true;
        if (key === SORT_KEY || key === MANUAL_ENABLED_KEY ||
            key.indexOf(MANUAL_KEY_PREFIX) === 0) structural = true;
      }
      if (!changed) return;
      // Turning Manual Order off (from the popup or another tab) must also
      // exit an in-progress edit mode on this page.
      if (changes[MANUAL_ENABLED_KEY] && changes[MANUAL_ENABLED_KEY].newValue !== "1") {
        cancelEditModeIfActive();
      }
      applyBeatenStyles();
      syncFooterControls(); // keep footer widgets (select/sliders/switch) in sync
      if (structural) {
        refreshBeatenSection();
      }
      if (changes[SORT_KEY]) maybeQuickCheck();
    });
  }

  /* ---------- preference accessors (read from STORE) ------------------ */

  function getSortPref() {
    var v = STORE[SORT_KEY];
    for (var i = 0; i < SORT_OPTIONS.length; i++) if (SORT_OPTIONS[i][0] === v) return v;
    return "pct-desc";
  }
  function setSortPref(v) { storeSet(SORT_KEY, v); }

  function getRangePref(key, def, min, max) {
    var v = parseInt(STORE[key], 10);
    if (!isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
  }
  function setRangePref(key, v) { storeSet(key, String(v)); }
  function getBeatenSize() { return getRangePref(SIZE_KEY, 100, 50, 100); }
  function getBeatenColor() { return getRangePref(COLOR_KEY, 100, 0, 100); }

  function isManualEnabled() { return STORE[MANUAL_ENABLED_KEY] === "1"; }
  function setManualEnabled(on) { storeSet(MANUAL_ENABLED_KEY, on ? "1" : "0"); }

  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  // RA usernames are case-insensitive (/user/Alp7 and /user/alp7 are the same
  // profile), so every comparison and every storage key uses lowercase.
  function sameUser(a, b) {
    return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  }

  // Game-ID list → array of unique digit strings (anything else is dropped).
  function cleanIdList(v) {
    var out = [], seen = Object.create(null);
    if (!Array.isArray(v)) return out;
    for (var i = 0; i < v.length; i++) {
      var id = String(v[i]);
      if (/^\d+$/.test(id) && !seen[id]) { seen[id] = true; out.push(id); }
    }
    return out;
  }

  // Validates manual-order data ({order:[…], hidden:[…]}); null if unusable.
  // Corrupt or hand-edited data must never be able to break the page.
  function cleanManual(v) {
    if (typeof v === "string") v = safeParse(v);
    if (!v || typeof v !== "object" || !Array.isArray(v.order) || !Array.isArray(v.hidden)) return null;
    return { order: cleanIdList(v.order), hidden: cleanIdList(v.hidden) };
  }

  // Keys saved by v1.3.x look like "rabg-manual-<name as spelled in the URL>".
  function isLegacyManualKey(k) {
    return k.indexOf(MANUAL_KEY_PREFIX) === 0 && k !== MANUAL_ENABLED_KEY &&
           k.indexOf(MANUAL_USER_PREFIX) !== 0;
  }

  function getManualData(username) {
    var lower = String(username || "").toLowerCase();
    if (!lower) return null;
    var d = cleanManual(STORE[MANUAL_USER_PREFIX + lower]);
    if (d) return d;
    for (var k in STORE) { // data saved by v1.3.x, whatever spelling it used
      if (isLegacyManualKey(k) && k.slice(MANUAL_KEY_PREFIX.length).toLowerCase() === lower) {
        d = cleanManual(STORE[k]);
        if (d) return d;
      }
    }
    return null;
  }
  function setManualData(username, data) {
    storeSet(MANUAL_USER_PREFIX + String(username).toLowerCase(), data);
  }
  // Deletes the saved arrangement (current and v1.3.x keys) → default order.
  function clearManualData(username) {
    var lower = String(username || "").toLowerCase();
    if (!lower) return;
    var doomed = [MANUAL_USER_PREFIX + lower];
    for (var k in STORE) {
      if (isLegacyManualKey(k) && k.slice(MANUAL_KEY_PREFIX.length).toLowerCase() === lower) doomed.push(k);
    }
    for (var i = 0; i < doomed.length; i++) storeRemove(doomed[i]);
  }

  // Applies the saved size/grayscale to all beaten tiles via CSS variables.
  function applyBeatenStyles() {
    var size = getBeatenSize() / 100;
    var gray = (100 - getBeatenColor()) / 100;
    var root = document.documentElement;
    root.style.setProperty("--rabg-size", String(size));
    root.style.setProperty("--rabg-gray", String(gray));
  }

  /* ---------- generic helpers ----------------------------------------- */

  function runtime() {
    if (typeof browser !== "undefined" && browser.runtime) return browser.runtime;
    if (typeof chrome !== "undefined" && chrome.runtime) return chrome.runtime;
    return null;
  }

  // The profile being viewed: /user/<name> → <name>
  function getUsername() {
    var parts = location.pathname.split("/").filter(Boolean);
    var name = parts[0] === "user" && parts[1] ? parts[1] : "";
    try { return decodeURIComponent(name); } catch (e) { return name; }
  }

  // The logged-in user, from the navbar account dropdown (absent when
  // logged out). Desktop: trigger itself is <a href="/user/NAME">.
  // Mobile: trigger is a <button>, profile link lives inside the dropdown
  // menu (which also contains the logout form — unique to the account
  // dropdown, so we can scope safely and avoid other users' profile links
  // in notification dropdowns). Cached after first success so mobile
  // re-renders / closed menus don't cause intermittent failures.
  var _cachedViewer = null;
  function getViewerUsername() {
    if (_cachedViewer) return _cachedViewer;
    // Desktop path — original, still fastest.
    try {
      var links = document.querySelectorAll("div.dropdown a.nav-link[href*='/user/']");
      for (var i = 0; i < links.length; i++) {
        var mm1 = (links[i].getAttribute("href") || "").match(/\/user\/([^\/?#]+)/);
        if (mm1) {
          try { _cachedViewer = decodeURIComponent(mm1[1]); } catch (e) { _cachedViewer = mm1[1]; }
          return _cachedViewer;
        }
      }
    } catch (e) {}
    // Mobile fallback: find the logout form first (unique to account
    // dropdown), then walk up to its dropdown container and read the
    // profile link inside. Works even when the trigger is a <button>.
    try {
      var lf = document.querySelector("form[action*='logout']");
      if (lf) {
        var dd = null;
        try { dd = lf.closest("div.dropdown"); } catch (e) {}
        if (!dd) {
          var p = lf.parentElement;
          while (p) {
            if (p.classList && p.classList.contains("dropdown")) { dd = p; break; }
            p = p.parentElement;
          }
        }
        if (dd) {
          var menuLinks = dd.querySelectorAll("a[href*='/user/']");
          for (var j = 0; j < menuLinks.length; j++) {
            var href = menuLinks[j].getAttribute("href") || "";
            var mm2 = href.match(/\/user\/([^\/?#]+)/);
            if (mm2) {
              try { _cachedViewer = decodeURIComponent(mm2[1]); } catch (e2) { _cachedViewer = mm2[1]; }
              return _cachedViewer;
            }
          }
        }
      }
      // Broader scan if closest failed (some RA builds nest differently)
      var dds = document.querySelectorAll("div.dropdown");
      for (var di = 0; di < dds.length; di++) {
        var d = dds[di];
        if (!d.querySelector("form[action*='logout']")) continue;
        var mls = d.querySelectorAll("a[href*='/user/']");
        for (var k = 0; k < mls.length; k++) {
          var hf = mls[k].getAttribute("href") || "";
          var mm3 = hf.match(/\/user\/([^\/?#]+)/);
          if (mm3) {
            try { _cachedViewer = decodeURIComponent(mm3[1]); } catch (e3) { _cachedViewer = mm3[1]; }
            return _cachedViewer;
          }
        }
      }
    } catch (e) {}
    // Inertia fallback (some RA pages like Settings are Inertia-rendered).
    try {
      var sp = document.querySelector("script[data-page]");
      if (sp) {
        var raw = sp.textContent || sp.innerHTML || "";
        var data = JSON.parse(raw);
        if (data && data.props && data.props.auth && data.props.auth.user) {
          var u = data.props.auth.user.username || data.props.auth.user.displayName || "";
          if (u) { _cachedViewer = u; return _cachedViewer; }
        }
      }
    } catch (e2) {}
    return "";
  }

  function completionOf(row) {
    var pb = row.querySelector('[role="progressbar"]');
    if (pb) {
      var now = parseFloat(pb.getAttribute("aria-valuenow"));
      var max = parseFloat(pb.getAttribute("aria-valuemax"));
      if (isFinite(now) && isFinite(max) && max > 0) return now / max;
    }
    var titled = row.querySelector('[title*="Progress:"]');
    if (titled) {
      var m = titled.getAttribute("title").match(/Progress:\s*([\d.]+)\s*\/\s*([\d.]+)/);
      if (m) { var n = parseFloat(m[1]), d = parseFloat(m[2]); if (d > 0) return n / d; }
    }
    var txt = row.textContent.match(/([\d.]+)\s*of\s*([\d.]+)/);
    if (txt) { var nn = parseFloat(txt[1]), dd = parseFloat(txt[2]); if (dd > 0) return nn / dd; }
    return 0;
  }

  // Completion is kept to 4 decimals everywhere (tiles, cache, sorting), so
  // a freshly loaded list and a cached one always sort identically.
  function round4(n) { return Math.round((+n || 0) * 10000) / 10000; }

  /* ---------- RA page data -------------------------------------------- */

  function readMasteryCounts(awards) {
    var hc = 0, sc = 0, hcTitle = "", scTitle = "";
    var nodes = awards.querySelectorAll("h3 .cursor-help, h3 div[title]");
    for (var i = 0; i < nodes.length; i++) {
      var div = nodes[i];
      var rawTitle = div.getAttribute("title") || "";
      var title = rawTitle.toLowerCase();
      var numEl = div.querySelector(".numitems");
      var num = numEl ? (parseInt(numEl.textContent, 10) || 0) : 0;
      if (title.indexOf("mastered") !== -1 && num) { hc = num; hcTitle = rawTitle; }
      else if (title.indexOf("completed") !== -1 && num) { sc = num; scTitle = rawTitle; }
    }
    var grid = awards.querySelector(".grid");
    if (grid) {
      if (!hc) { hc = grid.querySelectorAll("img.goldimage").length; hcTitle = hc + " games mastered"; }
      if (!sc) { sc = grid.querySelectorAll("img.siteawards").length; scTitle = sc + " games completed"; }
    }
    return { hc: hc, sc: sc, hcTitle: hcTitle, scTitle: scTitle };
  }

  // TRUE beaten totals (hardcore + softcore) from the Progression Status
  // "Total" row. Filled dot (bg-) = hardcore; hollow dot = softcore.
  function getBeatenTotals() {
    var rows = document.querySelectorAll(".progression-status-row");
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i].querySelector("p");
      if (label && /total/i.test(label.textContent)) {
        var cell = rows[i].querySelector('a[href*="any-beaten"]');
        if (!cell) return null;
        var tallies = cell.querySelectorAll(".tally");
        if (!tallies.length) return null;
        var hc = 0, sc = 0;
        for (var j = 0; j < tallies.length; j++) {
          var n = parseInt(tallies[j].textContent.replace(/[^0-9]/g, ""), 10) || 0;
          var dot = tallies[j].querySelector(".dot");
          if (dot && dot.className.indexOf("bg-") !== -1) hc += n;
          else sc += n;
        }
        return { hc: hc, sc: sc };
      }
    }
    return null;
  }

  // Game IDs already mastered/completed in the grid — excluded from Beaten.
  function computeMasteredIds(awards) {
    var ids = Object.create(null);
    var tiles = awards.querySelectorAll("[data-gameid]");
    for (var k = 0; k < tiles.length; k++) {
      if (tiles[k].getAttribute("data-beaten") !== "true") {
        ids[tiles[k].getAttribute("data-gameid")] = true;
      }
    }
    return ids;
  }

  // Beaten games (hardcore + softcore) from the "hide completed games" view,
  // sorted by completion % (highest first), de-duplicated by game ID.
  function getBeatenGames(excludeIds) {
    var scope =
      document.querySelector("#completion-progress-incomplete") ||
      document.querySelector("#completion-progress-all") ||
      document.querySelector("#usercompletedgamescomponent") ||
      document;
    var rows = scope.querySelectorAll("tr");
    var map = Object.create(null);
    var list = [];

    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var awardEl = tr.querySelector("[data-award]");
      if (!awardEl) continue;
      var award = awardEl.getAttribute("data-award");
      var type = null;
      if (award === "beaten-hardcore") type = "hc";
      else if (award === "beaten-softcore") type = "sc";
      else if (award === "beaten") type = "hc";
      else continue;

      var link = tr.querySelector('a[href*="/game/"]');
      var img = tr.querySelector("img");
      if (!link || !img) continue;

      var m = link.getAttribute("href").match(/\/game\/(\d+)/);
      if (!m) continue;

      var gameId = m[1];
      if (excludeIds && excludeIds[gameId]) continue;

      var pct = round4(completionOf(tr));
      if (map[gameId]) {
        if (pct > map[gameId].pct) map[gameId].pct = pct;
        continue;
      }
      var title = (img.getAttribute("alt") || "").replace(/\s*game badge\s*$/i, "").trim();
      map[gameId] = { gameId: gameId, imgSrc: img.getAttribute("src"), pct: pct, type: type, title: title };
      list.push(map[gameId]);
    }

    list.sort(function (a, b) { return b.pct - a.pct; });
    return list;
  }

  /* ---------- complete beaten list: progress pages, cache, sync -------- */

  // The profile's Completion Progress only lists the games with the highest
  // completion %. The user's dedicated progress page, filtered to "beaten",
  // lists every beaten game (100 per page) and also shows, per game, the
  // time-to-beat and the date of the last achievement unlock. (That date is
  // NOT the beaten date — RA only shows that in the hover tooltip.)
  //
  // Flow: the Beaten section is always built from the user's complete list on
  // the progress pages (not from the shorter list printed on the profile).
  // If this profile's list is cached and its signature (the Progression Status
  // totals) still matches, the cache is used with no network access at all.
  // Otherwise the pages are fetched in the background, one by one, and the
  // section is refreshed as they arrive; the finished list is cached. The Sync
  // button forces a refetch. The profile's own short list is only a fallback
  // for when nothing else is available (e.g. the sync failed).

  var beatenExtra = emptyExtra();
  var syncToken = 0;

  function isProfilePage() { return /^\/user\/[^\/]+\/?$/.test(location.pathname); }

  var MONTHS = {   // by the first three letters ("October", "Oct", "Oct.")
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6,
    aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  function cleanText(el) { return (el.textContent || "").replace(/\s+/g, " ").trim(); }
  function isSafeImg(src) { return typeof src === "string" && /^(https:\/\/|\/)[^\s"'<>]+$/.test(src); }

  function unitSeconds(u) {
    u = u.toLowerCase();
    if (u.indexOf("mo") === 0) return 2592000;
    if (u.charAt(0) === "s") return 1;
    if (u.charAt(0) === "m") return 60;
    if (u.charAt(0) === "h") return 3600;
    if (u.charAt(0) === "d") return 86400;
    if (u.charAt(0) === "w") return 604800;
    return 31536000; // y
  }

  // "34 hours, 52 minutes" (also "34h 52m", "34 hrs 52 mins") → seconds;
  // null if nothing recognizable.
  function parseDuration(text) {
    var re = /(\d[\d,]*)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|[smhdwy])(?![a-z])/gi;
    var m, total = 0, found = false;
    while ((m = re.exec(text))) {
      found = true;
      total += parseInt(m[1].replace(/,/g, ""), 10) * unitSeconds(m[2]);
    }
    return found ? total : null;
  }

  // "October 19 2026" (also "Oct 19, 2026" or "19 October 2026") → UTC
  // timestamp; null if it isn't a date.
  function parseDateText(text) {
    var day, monName, year;
    var m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(text);
    if (m) { monName = m[1]; day = m[2]; year = m[3]; }
    else {
      m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(text);
      if (!m) return null;
      day = m[1]; monName = m[2]; year = m[3];
    }
    var mon = MONTHS[monName.toLowerCase().slice(0, 3)];
    var d = parseInt(day, 10);
    if (mon === undefined || d < 1 || d > 31) return null;
    return Date.UTC(parseInt(year, 10), mon, d);
  }

  // Reads one progress page (already parsed into a document).
  // → { games:[…], total:<filtered game count or null>, hasNext:bool }
  function parseProgressDoc(doc) {
    var games = [];
    var roots = doc.querySelectorAll(".cprogress-pmeta__root");
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      var li = root.closest ? root.closest("li") : null;
      if (!li) continue;
      var awardEl = li.querySelector("[data-award]");
      var award = awardEl ? awardEl.getAttribute("data-award") : "";
      var type = award === "beaten-hardcore" ? "hc"
               : award === "beaten-softcore" ? "sc"
               : award === "beaten" ? "hc" : null;
      if (!type) continue;
      var link = root.querySelector('a[href*="/game/"]') || li.querySelector('a[href*="/game/"]');
      var img = li.querySelector("img");
      if (!link || !img) continue;
      var m = (link.getAttribute("href") || "").match(/\/game\/(\d+)/);
      var src = img.getAttribute("src") || "";
      if (!m || !isSafeImg(src)) continue;

      var pct = 0, ttb = null, unl = null;
      var ps = root.querySelectorAll("p");
      for (var j = 0; j < ps.length; j++) {
        var t = cleanText(ps[j]);
        var am = /(\d[\d,]*)\s+of\s+(\d[\d,]*)\s+achievements/i.exec(t);
        if (am) {
          var n = parseInt(am[1].replace(/,/g, ""), 10), d = parseInt(am[2].replace(/,/g, ""), 10);
          if (d > 0) pct = n / d;
        } else if (/beaten/i.test(t)) {
          // "Beaten in 34 hours, 52 minutes over 7 days, 22 hours" — only the
          // part after "in" (play time) is the time to beat.
          var bm = /beaten\s+in\s+(.*?)(?:\s+over\s+|$)/i.exec(t);
          if (bm) ttb = parseDuration(bm[1]);
        } else {
          var dt = parseDateText(t);
          if (dt !== null) unl = dt;
        }
      }
      if (!pct) pct = completionOf(li);

      games.push({
        gameId: m[1], imgSrc: src, pct: round4(pct), type: type,
        title: cleanText(link), ttb: ttb, unl: unl
      });
    }

    var total = null;
    var allP = doc.querySelectorAll("p");
    for (var k = 0; k < allP.length; k++) {
      var vm = /^Viewing\s+([\d,]+)\s+of\s+[\d,]+/i.exec(cleanText(allP[k]));
      if (vm) { total = parseInt(vm[1].replace(/,/g, ""), 10); break; }
    }
    return { games: games, total: total, hasNext: !!doc.querySelector('a[title="Next"][href]') };
  }

  function fetchProgressPage(user, page, useSort) {
    var url = location.origin + "/user/" + encodeURIComponent(user) +
      "/progress?filter%5Bstatus%5D=any-beaten" +
      (useSort ? "&sort=game_title" : "") +        // stable order across pages
      "&page%5Bnumber%5D=" + page;
    var opts = { credentials: "same-origin", cache: "no-store" };
    // A page that never answers must not leave the sync stuck on "Loading…".
    var ctrl = null, timer = null, timedOut = false;
    if (typeof AbortController === "function") {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, SYNC_TIMEOUT_MS);
    }
    function settle() { if (timer) { clearTimeout(timer); timer = null; } }
    return fetch(url, opts)
      .then(function (r) {
        if (!r.ok) {
          var err = new Error("HTTP " + r.status);
          err.status = r.status;
          throw err;
        }
        return r.text();
      })
      .then(function (html) {
        settle();
        return parseProgressDoc(new DOMParser().parseFromString(html, "text/html"));
      }, function (err) {
        settle();
        if (timedOut) { err = new Error("timed out"); err.timedOut = true; }
        throw err;
      });
  }

  /* --- cache (storage.local, one entry per profile; see CACHE_MAX_PROFILES) --- */

  function cacheKeyFor(user) { return CACHE_PREFIX + String(user).toLowerCase(); }

  // Badge images all live at the same address on RA's media server, so only
  // the file number is stored ("085573"); anything else is stored in full.
  var IMG_PREFIX = "https://media.retroachievements.org/Images/";
  var IMG_SUFFIX = ".png";
  function packImg(src) {
    var m = /^https:\/\/media\.retroachievements\.org\/Images\/(\d+)\.png$/.exec(src || "");
    return m ? m[1] : src;
  }
  function unpackImg(v) {
    return (typeof v === "string" && /^\d+$/.test(v)) ? IMG_PREFIX + v + IMG_SUFFIX : v;
  }

  // Compact on-disk form: [id, title, img, pct, hardcore(1/0), ttb, unl]
  function packGame(g) {
    return [g.gameId, g.title, packImg(g.imgSrc), round4(g.pct),
            g.type === "hc" ? 1 : 0,
            typeof g.ttb === "number" ? g.ttb : null,
            typeof g.unl === "number" ? g.unl : null];
  }
  function unpackGame(a) {
    if (!Array.isArray(a) || a.length < 7) return null;
    var id = String(a[0]);
    var img = unpackImg(a[2]);
    if (!/^\d+$/.test(id) || !isSafeImg(img)) return null;
    return {
      gameId: id, title: String(a[1] || ""), imgSrc: img, pct: round4(a[3]),
      type: a[4] ? "hc" : "sc",
      ttb: typeof a[5] === "number" ? a[5] : null,
      unl: typeof a[6] === "number" ? a[6] : null
    };
  }

  function readCache(user) {
    var c = STORE[cacheKeyFor(user)];
    if (!c || typeof c !== "object" || (c.v !== CACHE_VERSION && c.v !== 1) ||
        typeof c.sig !== "string" || !Array.isArray(c.g)) return null;
    var games = Object.create(null), n = 0;
    for (var i = 0; i < c.g.length; i++) {
      var g = unpackGame(c.g[i]);
      if (g && !games[g.gameId]) { games[g.gameId] = g; n++; }
    }
    return { sig: c.sig, t: +c.t || 0, games: games, count: n };
  }

  function writeCache(user, sig, games) {
    var lower = String(user).toLowerCase();
    var arr = [];
    for (var id in games) arr.push(packGame(games[id]));
    var entry = { v: CACHE_VERSION, sig: sig, t: Date.now(), g: arr };
    storeSet(cacheKeyFor(lower), entry, function () {
      // The browser refused the write — most likely the extension's storage
      // is full. Drop every other remembered list and try once more.
      var me0 = String(getViewerUsername() || "").toLowerCase();
      var list = Array.isArray(STORE[CACHE_INDEX_KEY]) ? STORE[CACHE_INDEX_KEY] : [];
      var keep = [];
      for (var j = 0; j < list.length; j++) {
        if (list[j] === lower || list[j] === me0) keep.push(list[j]);
        else storeRemove(CACHE_PREFIX + list[j]);
      }
      storeSet(CACHE_INDEX_KEY, keep);
      storeSet(cacheKeyFor(lower), entry);
    });
    var idx = Array.isArray(STORE[CACHE_INDEX_KEY]) ? STORE[CACHE_INDEX_KEY].slice() : [];
    idx = idx.filter(function (u) { return u !== lower; });
    idx.push(lower);
    // Keep the newest CACHE_MAX_PROFILES profiles of OTHER people. The
    // viewer's own profile is never evicted and doesn't count toward the limit.
    var me = String(getViewerUsername() || "").toLowerCase();
    var others = idx.filter(function (u) { return u !== me; });
    var drop = others.slice(0, Math.max(0, others.length - CACHE_MAX_PROFILES));
    for (var i = 0; i < drop.length; i++) storeRemove(CACHE_PREFIX + drop[i]);
    if (drop.length) idx = idx.filter(function (u) { return drop.indexOf(u) === -1; });
    storeSet(CACHE_INDEX_KEY, idx);
  }

  // Signature of what a cache must match: the profile's true beaten totals.
  function currentSig(totals) { return totals ? (totals.hc + "-" + totals.sc) : ""; }

  function emptyExtra() {
    return { user: "", sig: "", games: null, state: "idle", loaded: 0, total: 0,
             at: 0, error: "", flashUntil: 0 };
  }

  // Before the first render: reuse the cached complete list when it is current.
  function prepareBeatenData(totals) {
    if (!isProfilePage()) return;
    var user = getUsername().toLowerCase();
    var sig = currentSig(totals);
    if (!user || !sig) return;
    if (beatenExtra.user && beatenExtra.user !== user) { // moved to another profile
      syncToken++;
      beatenExtra = emptyExtra();
    }
    if (beatenExtra.state === "loading") return;
    if (beatenExtra.state === "done" && beatenExtra.user === user && beatenExtra.sig === sig) return;
    var c = readCache(user);
    if (c && c.sig === sig) {
      beatenExtra = { user: user, sig: sig, games: c.games, state: "done",
                      loaded: c.count, total: c.count, at: c.t, error: "", flashUntil: 0 };
    }
  }

  // Orders a list of games like the Sort setting does (used for the default
  // order of Manual Order, and by the Sort select via sortBeatenTiles).
  function compareStr(a, b) {
    a = a || ""; b = b || "";
    try { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); }
    catch (e) { return a < b ? -1 : (a > b ? 1 : 0); }
  }
  function sortGames(list, key) {
    var m = /^(pct|ttb|unl)-(asc|desc)$/.exec(key);
    var field = m ? m[1] : (key === "title-asc" || key === "title-desc" ? "title" : "pct");
    var dir = (m ? m[2] : (key === "title-desc" ? "desc" : "asc")) === "asc" ? 1 : -1;
    if (!m && key !== "title-asc" && key !== "title-desc") { field = "pct"; dir = -1; }
    list.sort(function (a, b) {
      if (field === "title") return dir * compareStr(a.title, b.title);
      var va = typeof a[field] === "number" ? a[field] : null;
      var vb = typeof b[field] === "number" ? b[field] : null;
      if (va === null && vb === null) return compareStr(a.title, b.title);
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va !== vb) return dir * (va - vb);
      return compareStr(a.title, b.title);
    });
    return list;
  }

  // The beaten games to show: the user's complete list from the progress pages
  // (cache or a running/finished sync), minus games shown as Mastered.
  // Only if that list isn't available at all (the sync failed and nothing is
  // cached, or the page layout changed) fall back to the shorter list that
  // RetroAchievements prints on the profile itself.
  function getAllBeaten(excludeIds) {
    var out = [];
    var extra = beatenExtra.user === getUsername().toLowerCase() ? beatenExtra.games : null;
    if (extra) {
      for (var id in extra) {
        if (excludeIds && excludeIds[id]) continue;
        var e = extra[id];
        out.push({ gameId: e.gameId, imgSrc: e.imgSrc, pct: e.pct, type: e.type,
                   title: e.title, ttb: e.ttb, unl: e.unl });
      }
    }
    if (!out.length && beatenExtra.state !== "loading") out = getBeatenGames(excludeIds);
    return sortGames(out, getSortPref());
  }

  function countKeys(o) { var n = 0; for (var k in o) n++; return n; }

  function unionMaps(primary, secondary) {
    var out = Object.create(null), k;
    if (secondary) for (k in secondary) out[k] = secondary[k];
    for (k in primary) out[k] = primary[k];
    return out;
  }

  // Fetches every page of the user's beaten list. `manual` = the Sync button
  // (shows a confirmation when it is done, because the list often looks the
  // same afterwards).
  //
  // While the pages load, the list that is already known for this profile
  // (the one on screen, or an older remembered one) stays visible, so a
  // refresh never empties the section; it is swapped for the new list at the
  // end. Without any known list the section fills up page by page.
  //
  // `check` = a silent look at the newest page only (see maybeQuickCheck): it
  // shows nothing unless it finds a change, and never reports an error.
  function startSync(manual, check) {
    if (!isProfilePage() || beatenExtra.state === "loading") return false;
    var user = getUsername();
    if (!user || typeof fetch !== "function") return false;
    var sig = currentSig(getBeatenTotals());
    var token = ++syncToken;
    var lower = user.toLowerCase();
    var previous = beatenExtra.user === lower ? beatenExtra.games : null;
    var fromStale = false;
    if (!previous) {                     // an older remembered list is better than nothing
      var stale = readCache(lower);
      if (stale && stale.count) { previous = stale.games; fromStale = true; }
    }
    var fresh = Object.create(null);
    var page = 1, useSort = true, attempts = 0, pageSize = 0, probing = false;
    // Quick refresh (automatic refreshes only, when an older list of this
    // profile is remembered): RA's progress page lists games by their latest
    // unlock, newest first, and beating a game IS an unlock — so new or
    // changed games sit at the top. Read from the top until a game shows up
    // that is exactly as remembered, merge, and accept the result only if the
    // number of games then equals RA's own count. Anything else (a game
    // missing, one too many, an error) falls back to the full reload below.
    // The Sync button always does the full reload.
    var silent = !!check && !manual && !fromStale && !!previous && beatenExtra.state === "done";
    if (check && !silent) return false;
    var quick = !manual && (fromStale || silent);
    var merged = null, changedAny = false;
    quickChecked = lower;                // any sync covers the "is it current?" check
    function showLoading() {
      beatenExtra = { user: lower, sig: sig, games: previous,
                      state: "loading", loaded: 0, total: 0, at: 0, error: "", flashUntil: 0 };
      if (fromStale) refreshBeatenSection(); // show it right away (no-op before the first render)
      updateFooterEditButton();            // also refreshes the Sync row / hint
    }
    if (!silent) showLoading();

    function fail(err) {
      if (token !== syncToken) return;
      if (silent) return;                  // the list on screen stays as it is
      console.info("[RABG] Sync failed on page " + page + ":", err);
      beatenExtra.retrying = false;
      beatenExtra.state = "error";
      beatenExtra.error = String((err && err.message) || err).slice(0, 60);
      beatenExtra.games = unionMaps(fresh, previous);
      refreshBeatenSection();
      updateFooterEditButton();
      flashSyncError();
    }

    function finish() {
      if (token !== syncToken) return;
      beatenExtra.games = fresh;
      beatenExtra.loaded = countKeys(fresh);
      beatenExtra.state = "done";
      beatenExtra.retrying = false;
      beatenExtra.at = Date.now();
      if (manual) beatenExtra.flashUntil = Date.now() + FLASH_MS;
      if (sig) writeCache(user, sig, fresh);
      console.info("[RABG] Synced " + beatenExtra.loaded + " beaten games in " + page + " page(s).");
      refreshBeatenSection();
      updateFooterEditButton();
    }

    function onPage(res) {
      if (token !== syncToken) return;
      if (!res.games.length && page === 1) {
        if (useSort) { useSort = false; step(); return; }   // retry once without the sort hint
        fail(new Error("no games found on the progress page"));
        return;
      }
      attempts = 0;
      beatenExtra.retrying = false;
      var added = 0, novel = false;
      for (var i = 0; i < res.games.length; i++) {
        var g = res.games[i];
        if (!fresh[g.gameId]) {
          fresh[g.gameId] = g;
          added++;
          if (!previous || !previous[g.gameId]) novel = true;
        }
      }
      if (page === 1) pageSize = res.games.length;
      if (res.total !== null && !beatenExtra.total) beatenExtra.total = res.total;
      beatenExtra.loaded = countKeys(fresh);
      var complete = !!beatenExtra.total && beatenExtra.loaded >= beatenExtra.total;
      // Normally the "Next" link says whether more pages follow. If it is
      // missing although the page was full and RA's own count says there are
      // more games, look at the next page anyway (once) — otherwise a small
      // change to RA's page layout would silently cut the list short.
      probing = !res.hasNext && !complete && added > 0 && !!beatenExtra.total &&
                pageSize > 0 && res.games.length >= pageSize;
      if (added === 0 || page >= SYNC_MAX_PAGES || complete || (!res.hasNext && !probing)) {
        finish();
        return;
      }
      beatenExtra.games = unionMaps(fresh, previous);
      // Redraw only when this page brought games that weren't on screen yet:
      // after every page at first, for very large lists only every third page
      // (the final result is always drawn by finish()).
      if (novel && (page <= 5 || page % 3 === 0)) refreshBeatenSection();
      updateSyncUI();
      page++;
      setTimeout(step, SYNC_PAGE_DELAY_MS);
    }

    function fullReload() {
      if (silent) { silent = false; showLoading(); }
      quick = false;
      merged = null;
      fresh = Object.create(null);
      page = 1; attempts = 0;
      beatenExtra.loaded = 0; beatenExtra.total = 0;
      updateSyncUI();
      step();
    }

    function sameGame(a, b) {
      return a.unl === b.unl && a.pct === b.pct && a.ttb === b.ttb && a.type === b.type;
    }

    function onQuickPage(res) {
      if (token !== syncToken) return;
      if (!res.games.length || res.total === null) {
        if (!silent) fullReload();       // unreadable page: a silent check just gives up
        return;
      }
      if (!merged) merged = unionMaps(previous, null);
      var sawKnown = false;
      for (var i = 0; i < res.games.length; i++) {
        var g = res.games[i], old = previous[g.gameId];
        if (old && sameGame(old, g)) sawKnown = true;
        else changedAny = true;
        merged[g.gameId] = g;
      }
      if (!silent) beatenExtra.total = res.total;
      if (sawKnown || !res.hasNext) {
        var n = countKeys(merged);
        if (silent && !changedAny) return;           // everything is as remembered
        // A silent check started from a list that was complete, so "no game
        // added" is good enough there even if RA counts differently.
        if (n === res.total || (silent && n === countKeys(previous))) {
          fresh = merged;
          console.info("[RABG] Quick refresh: " + page + " page(s) were enough.");
          finish();
        } else {
          fullReload();   // the numbers don't add up — read everything
        }
        return;
      }
      if (page >= QUICK_MAX_PAGES) { fullReload(); return; }
      page++;
      setTimeout(step, SYNC_PAGE_DELAY_MS);
    }

    function onFetchError(err) {
      if (token !== syncToken) return;
      if (silent) return;                                   // a silent check just gives up
      if (quick) { fullReload(); return; }
      if (probing) { page--; finish(); return; }            // there was no further page after all
      var st = err && err.status;
      if (st && page === 1 && useSort && !countKeys(fresh)) { // the server rejected it: retry once without the sort hint
        useSort = false;
        step();
        return;
      }
      // A network hiccup, a timeout, "too many requests" or a server error is
      // worth another try (a timeout only one — each already took a while);
      // anything else (e.g. 404) is not.
      var limit = err && err.timedOut ? 1 : SYNC_RETRIES;
      if ((!st || st === 429 || st >= 500) && attempts < limit) {
        attempts++;
        beatenExtra.retrying = true;
        updateSyncUI();
        setTimeout(step, SYNC_RETRY_DELAY_MS * attempts);
        return;
      }
      fail(err);
    }

    function step() {
      if (token !== syncToken) return;
      // No connection at all: say so right away instead of waiting for
      // requests that can never be answered.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        var off = new Error("you are offline");
        // After a press on Sync, leave "Loading…" up for a moment — an error
        // that replaces it instantly looks as if the button did nothing.
        if (manual) setTimeout(function () { fail(off); }, 700);
        else fail(off);
        return;
      }
      // Errors inside onPage (our own code) go straight to fail(), never to
      // the retry logic. The quick refresh uses RA's default order (latest
      // unlock first), i.e. no sort parameter.
      fetchProgressPage(user, page, quick ? false : useSort)
        .then(quick ? onQuickPage : onPage, onFetchError).catch(fail);
    }
    step();
    return true;
  }

  // Runs when a profile is shown: use the cached list if it is current,
  // otherwise load the complete list from the progress pages. Nothing is
  // fetched when the cache matches (until the user presses Sync).
  function maybeAutoSync() {
    if (!isProfilePage()) return;
    var user = getUsername().toLowerCase();
    if (!user) return;
    var totals = getBeatenTotals();
    var sig = currentSig(totals);
    if (!sig || totals.hc + totals.sc === 0) return;   // nothing to load
    prepareBeatenData(totals);                          // adopts a current cache
    if (beatenExtra.state === "loading") return;
    if (beatenExtra.user === user && beatenExtra.sig === sig &&
        (beatenExtra.state === "done" || beatenExtra.state === "error")) { // error: retry = Sync button
      maybeQuickCheck();
      return;
    }
    startSync(false);
  }

  // The remembered list is used while the beaten totals stay the same — but
  // a lot can change without touching those totals: more achievements in an
  // already-beaten game (percentage, last unlock), or a beaten game getting
  // mastered on the same day another one is beaten. So the newest progress
  // page is checked once on every profile visit (one request, silent). New
  // and changed games are at its top; if a game was added or left, the count
  // no longer fits and the full list is reloaded.
  var quickChecked = "";
  function maybeQuickCheck() {
    if (!isProfilePage() || beatenExtra.state !== "done") return;
    var user = getUsername().toLowerCase();
    if (!user || beatenExtra.user !== user || quickChecked === user) return;
    startSync(false, true);
  }

  function formatSyncTime(t) {
    try {
      return new Date(t).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      });
    } catch (e) { return new Date(t).toISOString(); }
  }

  function syncStatusText() {
    var s = beatenExtra;
    if (s.state === "loading") {
      return "Loading beaten games… " + s.loaded + (s.total ? "/" + s.total : "") +
             (s.retrying ? " (no answer — retrying)" : "");
    }
    if (s.state === "error") return "Sync failed (" + (s.error || "unknown error") + ") — try again";
    if (s.state === "done" && s.at) return s.loaded + " games synced · " + formatSyncTime(s.at);
    return "";
  }

  function syncInfo() {
    var awards = document.getElementById("gameawards");
    var can = isProfilePage() && !!awards && !!awards.querySelector(".ra-beaten-section") &&
              beatenExtra.state !== "loading";
    return { state: beatenExtra.state, text: syncStatusText(), can: can };
  }

  var flashTimer = null;

  // Makes a failed sync noticeable even when the same message was already
  // there: the red status texts blink once (footer and beside the Beaten label).
  function flashSyncError() {
    var els = document.querySelectorAll(".ra-sync-status.ra-sync-error, .ra-loading.ra-sync-error");
    for (var i = 0; i < els.length; i++) {
      els[i].classList.remove("ra-sync-blink");
      void els[i].offsetWidth;            // restart the animation
      els[i].classList.add("ra-sync-blink");
    }
  }

  // Keeps the footer Sync row and the little status hint next to the Beaten
  // label ("Loading… 100/208", then "Synced ✓" for a few seconds) in step with
  // the sync state.
  function updateSyncUI() {
    var info = syncInfo();
    var btn = document.querySelector(".ra-sync-btn");
    if (btn) {
      btn.disabled = !info.can;
      btn.title = info.can ? "Reload the full beaten list from RetroAchievements"
                           : "Open a RetroAchievements profile to sync";
    }
    var st = document.querySelector(".ra-sync-status");
    if (st) {
      if (st.classList) st.classList.toggle("ra-sync-error", info.state === "error");
      if (st.textContent !== info.text) {
        st.textContent = info.text;
        fixFooterHeight(); // the text can wrap on narrow screens and make the footer taller
      }
    }
    var label = document.querySelector("#gameawards .ra-beaten-section .ra-grouplabel");
    if (label) {
      var hint = label.querySelector(".ra-loading");
      var text = "";
      if (beatenExtra.state === "loading") {
        text = "Loading… " + beatenExtra.loaded + (beatenExtra.total ? "/" + beatenExtra.total : "") +
               (beatenExtra.retrying ? " (retrying)" : "");
      } else if (beatenExtra.state === "done" && Date.now() < beatenExtra.flashUntil) {
        text = "Synced " + beatenExtra.loaded + " games ✓";
        if (!flashTimer) {
          flashTimer = setTimeout(function () { flashTimer = null; updateSyncUI(); }, FLASH_MS + 100);
        }
      } else if (beatenExtra.state === "error") {
        text = "Sync failed";
      }
      if (text) {
        if (!hint) {
          hint = document.createElement("span");
          hint.className = "ra-loading";
          var lbl = label.querySelector(".ra-lbl");
          label.insertBefore(hint, lbl ? lbl.nextSibling : label.firstChild);
        }
        if (hint.textContent !== text) hint.textContent = text;
        hint.classList.toggle("ra-sync-error", beatenExtra.state === "error");
      } else if (hint && hint.parentNode) {
        hint.parentNode.removeChild(hint);
      }
    }
  }

  /* ---------- manual ordering ----------------------------------------- */

  function manualIsActive(username, viewer) {
    return !!(sameUser(viewer, username) && isManualEnabled());
  }

  // Splits beaten games per manual data: `visible` in the saved order (with
  // unreferenced "new" games appended at the end, visible) and `hiddenGames`.
  // Stale IDs (e.g. games mastered later) simply drop out.
  function applyManualOrder(beaten, manual) {
    var byId = {};
    beaten.forEach(function (g) { byId[g.gameId] = g; });
    var seen = {};
    var visible = [], hiddenGames = [];
    var order = (manual && manual.order) || [];
    var hidden = (manual && manual.hidden) || [];

    order.forEach(function (id) {
      if (seen[id] || !byId[id]) return;
      seen[id] = true;
      if (hidden.indexOf(id) !== -1) hiddenGames.push(byId[id]);
      else visible.push(byId[id]);
    });
    hidden.forEach(function (id) {
      if (seen[id] || !byId[id]) return;
      seen[id] = true;
      hiddenGames.push(byId[id]);
    });
    beaten.forEach(function (g) {           // new games → end, visible
      if (!seen[g.gameId]) visible.push(g);
    });
    return { visible: visible, hiddenGames: hiddenGames };
  }

  /* ---------- DOM builders -------------------------------------------- */

  function crownImg(which) {
    var img = document.createElement("img");
    img.className = "ra-crown-icon";
    img.src = crownUrls[which];
    img.alt = "";
    return img;
  }

  function makeCrownCounter(which, count, title) {
    var c = document.createElement("span");
    c.className = "ra-counter";
    c.setAttribute("title", title);
    var ic = document.createElement("span");
    ic.className = "ra-counter-icon";
    ic.appendChild(crownImg(which));
    var num = document.createElement("span");
    num.className = "numitems";
    num.textContent = String(count);
    c.appendChild(ic);
    c.appendChild(num);
    return c;
  }

  function makeMedalCounter(count, title) {
    var c = document.createElement("span");
    c.className = "ra-counter";
    c.setAttribute("title", title);
    var medal = document.createElement("span");
    medal.className = "ra-medal";
    medal.textContent = "🎖";
    var num = document.createElement("span");
    num.className = "numitems";
    num.textContent = String(count);
    c.appendChild(medal);
    c.appendChild(num);
    return c;
  }

  function makeBeatenTile(game, username) {
    var wrap = document.createElement("div");
    wrap.className = "ra-tile";
    wrap.setAttribute("data-gameid", game.gameId);
    wrap.setAttribute("data-beaten", "true");
    wrap.setAttribute("data-pct", game.pct.toFixed(4));
    wrap.setAttribute("data-tier", game.type);
    wrap.setAttribute("data-title", game.title || "");
    wrap.setAttribute("data-ttb", typeof game.ttb === "number" ? String(game.ttb) : "");
    wrap.setAttribute("data-unl", typeof game.unl === "number" ? String(game.unl) : "");

    // The username ends up inside an Alpine expression: only pass it on when
    // it is a plain RA-style name (letters, digits, _ . -).
    var ctxName = /^[A-Za-z0-9_.\-]+$/.test(username || "") ? username : "";
    var span = document.createElement("span");
    span.className = "inline";
    span.setAttribute(
      "x-data",
      "tooltipComponent($el, { dynamicType: 'game', dynamicId: '" + game.gameId + "'" +
        (ctxName ? ", dynamicContext: '" + ctxName + "'" : "") + " })"
    );
    span.setAttribute("x-on:mouseover", "showTooltip($event)");
    span.setAttribute("x-on:mouseleave", "hideTooltip");
    span.setAttribute("x-on:mousemove", "trackMouseMovement($event)");

    var a = document.createElement("a");
    a.className = "inline-block";
    a.href = "/game/" + game.gameId;
    if (game.title) a.setAttribute("aria-label", game.title); // the badge image has no text

    var img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.width = 48;
    img.height = 48;
    img.src = game.imgSrc;
    img.alt = "";
    img.className = game.type === "hc" ? "silverimage" : "plainimage";

    a.appendChild(img);
    span.appendChild(a);
    wrap.appendChild(span);
    return wrap;
  }

  function buildGroupLabel(text, first) {
    var d = document.createElement("div");
    d.className = "ra-grouplabel" + (first ? " ra-grouplabel-first" : "");
    var lbl = document.createElement("span");
    lbl.className = "ra-lbl";
    lbl.textContent = text;
    d.appendChild(lbl);
    return d;
  }

  function buildTitle() {
    var h3 = document.createElement("h3");
    h3.className = "flex justify-between gap-2";
    var span = document.createElement("span");
    span.className = "grow";
    span.textContent = "Game Awards";
    h3.appendChild(span);
    return h3;
  }

  function compareTitles(a, b) {
    var ta = a.getAttribute("data-title") || "";
    var tb = b.getAttribute("data-title") || "";
    try { return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: "base" }); }
    catch (e) { return ta < tb ? -1 : (ta > tb ? 1 : 0); }
  }

  function tileNumber(el, attr) {
    var v = el.getAttribute(attr);
    if (v === null || v === "") return null;
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  // Sorts the tiles of a beaten grid. Ties fall back to the title so the
  // order is always deterministic; games without time-to-beat / unlock data
  // always go last, whatever the direction.
  function sortBeatenTiles(grid, key) {
    var tiles = Array.prototype.slice.call(grid.children);
    var m = /^(pct|ttb|unl)-(asc|desc)$/.exec(key);
    var field = m ? m[1] : (key === "title-asc" || key === "title-desc" ? "title" : "pct");
    var dir = (m ? m[2] : (key === "title-desc" ? "desc" : "asc")) === "asc" ? 1 : -1;
    if (!m && key !== "title-asc" && key !== "title-desc") { field = "pct"; dir = -1; } // default: pct-desc
    var attr = field === "pct" ? "data-pct" : (field === "ttb" ? "data-ttb" : "data-unl");

    tiles.sort(function (a, b) {
      if (field === "title") return dir * compareTitles(a, b);
      var va = tileNumber(a, attr), vb = tileNumber(b, attr);
      if (va === null && vb === null) return compareTitles(a, b);
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va !== vb) return dir * (va - vb);
      return compareTitles(a, b);
    });
    tiles.forEach(function (t) { grid.appendChild(t); });
  }

  /* ---------- footer settings (sort / size / color / manual) ---------- */

  function buildFooterRow(extraClass) {
    var row = document.createElement("div");
    row.className = "flex mb-3 items-center" + (extraClass ? " " + extraClass : "");
    var label = document.createElement("div");
    var controls = document.createElement("div");
    // items-center (NOT "align-center", which has no CSS anywhere) so every
    // control — buttons, sliders, and the import hint text — lines up.
    controls.className = "flex items-center ml-2 gap-2";
    row.appendChild(label);
    row.appendChild(controls);
    return { row: row, label: label, controls: controls };
  }

  // Keeps the custom-drawn slider fill (the Chromium track gradient) in
  // sync with the input's value.
  function syncRangeFill(input) {
    if (!input) return;
    var min = parseFloat(input.min), max = parseFloat(input.max);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 100;
    var pct = max > min ? ((parseFloat(input.value) - min) / (max - min)) * 100 : 0;
    if (!isFinite(pct)) pct = 0;
    input.style.setProperty("--ra-fill", Math.max(0, Math.min(100, pct)) + "%");
  }

  // `onLive` runs on every tick of the drag (page-only, nothing is stored);
  // `onCommit` runs once when the value is released and is what gets saved.
  // Saving on every tick made the storage "echo" snap the slider back.
  function buildRangeRow(rowClass, labelText, srText, min, max, step, value, onLive, onCommit) {
    var r = buildFooterRow(rowClass);
    r.label.textContent = labelText;
    var range = document.createElement("input");
    range.type = "range";
    range.setAttribute("aria-label", srText);
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.className = "ra-range";
    var val = document.createElement("span");
    val.className = "ra-range-value";
    val.textContent = value + "%";
    range.addEventListener("input", function () { syncRangeFill(range); });
    syncRangeFill(range); // paint the correct fill before first display
    function current() {
      var v = parseInt(range.value, 10);
      return isFinite(v) ? v : min;
    }
    range.addEventListener("input", function () {
      val.textContent = range.value + "%";
      onLive(current());
    });
    range.addEventListener("change", function () { onCommit(current()); });
    // Mark the slider while a pointer drag is in progress (see syncFooterControls).
    range.addEventListener("pointerdown", function () {
      range.setAttribute("data-dragging", "1");
      var release = function () {
        range.removeAttribute("data-dragging");
        window.removeEventListener("pointerup", release);
        window.removeEventListener("pointercancel", release);
      };
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
    });
    r.controls.appendChild(range);
    r.controls.appendChild(val);
    return r.row;
  }

  function buildSwitchRow(rowClass, labelText, srText, checked, onToggle) {
    var r = buildFooterRow(rowClass);
    r.label.textContent = labelText;
    r.row.title = "Arrange and hide beaten badges on your own profile";
    var wrap = document.createElement("label");
    wrap.className = "ra-switch";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", srText);
    input.checked = !!checked;
    var slider = document.createElement("span");
    slider.className = "ra-switch-slider";
    wrap.appendChild(input);
    wrap.appendChild(slider);
    // Robust toggle: change + explicit click/touch on the slider.
    // Some mobile browsers don't fire change when the input is
    // visually hidden (opacity 0, 0x0), and rapid taps can be swallowed.
    var toggling = false;
    function fireToggle(state) {
      if (toggling) return;
      toggling = true;
      try { onToggle(state); } catch (e) {}
      setTimeout(function () { toggling = false; }, 150);
    }
    input.addEventListener("change", function () { fireToggle(input.checked); });
    // Click on the visible slider should always toggle, even if the
    // hidden input didn't receive the event (touch quirk).
    slider.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      input.checked = !input.checked;
      fireToggle(input.checked);
    });
    // Touch devices: treat a tap (touchend) as a toggle as well, which avoids
    // missed taps. A finger that moved is a scroll, not a tap — ignore it.
    var touchX = 0, touchY = 0, touchMoved = false;
    slider.addEventListener("touchstart", function (e) {
      var t = e.touches && e.touches[0];
      touchX = t ? t.clientX : 0;
      touchY = t ? t.clientY : 0;
      touchMoved = false;
    }, { passive: true });
    slider.addEventListener("touchmove", function (e) {
      var t = e.touches && e.touches[0];
      if (t && (Math.abs(t.clientX - touchX) > 10 || Math.abs(t.clientY - touchY) > 10)) touchMoved = true;
    }, { passive: true });
    slider.addEventListener("touchend", function (e) {
      if (touchMoved) return; // a scroll that happened to end here
      e.preventDefault();
      input.checked = !input.checked;
      fireToggle(input.checked);
    }, { passive: false });
    r.controls.appendChild(wrap);
    return r;
  }

  /* ---------- settings backup (export / import) ------------------------ */

  // Which stored keys count as user settings (exported / imported). The
  // beaten-list cache, theme capture and fallback blob are internal data.
  function knownSettingsKey(k) {
    if (LEGACY_KEYS.indexOf(k) !== -1) return true;
    if (k.indexOf("rabg-") !== 0) return false;
    if (k === "rabg-store" || k === "rabg-site-theme" || k === "rabg-scheme") return false;
    if (k === CACHE_INDEX_KEY || k.indexOf(CACHE_PREFIX) === 0) return false;
    return true;
  }

  // Validates one imported setting. Returns { key, value } to store, or null
  // to skip it — a settings file can never put unusable data in storage.
  function sanitizeImported(k, v) {
    var i;
    if (k === SORT_KEY) {
      for (i = 0; i < SORT_OPTIONS.length; i++) if (SORT_OPTIONS[i][0] === v) return { key: k, value: v };
      return null;
    }
    if (k === SIZE_KEY || k === COLOR_KEY) {
      var n = parseInt(v, 10);
      if (!isFinite(n)) return null;
      var lo = k === SIZE_KEY ? 50 : 0;
      return { key: k, value: String(Math.min(100, Math.max(lo, n))) };
    }
    if (k === MANUAL_ENABLED_KEY) return (v === "1" || v === "0") ? { key: k, value: v } : null;
    if (k === POPUP_THEME_KEY) {
      return (v === "auto" || v === "dark" || v === "black" || v === "light") ? { key: k, value: v } : null;
    }
    if (k.indexOf(MANUAL_KEY_PREFIX) === 0) {
      // Manual order for one profile. Older exports used the name as spelled
      // in the URL; everything is now stored under the lowercase name.
      var name = k.indexOf(MANUAL_USER_PREFIX) === 0
        ? k.slice(MANUAL_USER_PREFIX.length) : k.slice(MANUAL_KEY_PREFIX.length);
      var d = cleanManual(v);
      if (!name || !d) return null;
      return { key: MANUAL_USER_PREFIX + name.toLowerCase(), value: d };
    }
    return null;
  }

  function buildExportPayload() {
    var payload = {};
    for (var k in STORE) if (knownSettingsKey(k)) payload[k] = STORE[k];
    return payload;
  }

  function doExport() {
    try {
      var json = JSON.stringify(buildExportPayload(), null, 2);
      var d = new Date();
      var stamp = d.getFullYear() + "-" +
        ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "rabg-settings-" + stamp + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      console.info("[RABG] Export failed: " + e);
    }
  }

  // Small status line next to the Export / Import buttons.
  var backupMsgTimer = null;
  function showBackupMessage(text) {
    var row = document.querySelector(".ra-footer-backup");
    if (!row) return;
    var box = row.querySelector(".ra-backup-msg");
    if (!box) {
      box = document.createElement("span");
      box.className = "ra-backup-msg";
      (row.lastElementChild || row).appendChild(box); // the controls container
    }
    box.textContent = text;
    fixFooterHeight();
    if (backupMsgTimer) clearTimeout(backupMsgTimer);
    backupMsgTimer = setTimeout(function () {
      if (box.parentNode) box.parentNode.removeChild(box);
      fixFooterHeight();
    }, 8000);
  }

  function doImport(file) {
    try {
      var reader = new FileReader();
      reader.onload = function () {
        var data = safeParse(String(reader.result));
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          showBackupMessage("Import failed: not a RABG settings file.");
          return;
        }
        var count = 0, skipped = 0;
        for (var k in data) {
          if (!knownSettingsKey(k)) { skipped++; continue; }
          var clean = sanitizeImported(k, data[k]);
          if (clean) { storeSet(clean.key, clean.value); count++; }
          else skipped++;
        }
        if (!count) {
          showBackupMessage("Nothing imported: no valid RABG settings found.");
          return;
        }
        cancelEditModeIfActive();
        applyBeatenStyles();
        syncFooterControls();
        refreshBeatenSection();
        showBackupMessage("Imported " + count + " setting" + (count === 1 ? "" : "s") +
          (skipped ? " (" + skipped + " skipped)" : "") + ".");
      };
      reader.readAsText(file);
    } catch (e) {
      console.info("[RABG] Import failed: " + e);
      showBackupMessage("Import failed.");
    }
  }

  // Used when Import is triggered from the popup: browsers only allow the
  // file picker from a real in-page click, so we scroll to the footer's
  // Import button, pulse it, and hint at it — one familiar click there runs
  // the proven footer-import flow.
  function highlightFooterImport() {
    var btn = document.querySelector(".ra-footer-import-btn");
    if (!btn) return;
    try { btn.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (e) { try { btn.scrollIntoView(); } catch (e2) {} }
    var oldHint = document.querySelector(".ra-import-hint-text");
    if (oldHint && oldHint.parentNode) oldHint.parentNode.removeChild(oldHint);
    var hint = document.createElement("span");
    hint.className = "ra-import-hint-text";
    hint.textContent = "← Click here to import";
    // Insert AFTER the Import button (btn.nextSibling is the hidden file
    // input), so the row reads: [Export] [Import] ← Click here to import.
    btn.parentNode.insertBefore(hint, btn.nextSibling);
    btn.classList.add("ra-import-hint");
    var clear = function () {
      btn.classList.remove("ra-import-hint");
      if (hint.parentNode) hint.parentNode.removeChild(hint);
    };
    btn.addEventListener("click", clear, { once: true });
    setTimeout(clear, 15000);
  }

  /* ---------- footer sync helpers -------------------------------------- */

  // Edit-mode controls:
  //  - "Edit Badges" in the footer, next to the Manual Order switch (shown as
  //    "Save" while an edit is in progress).
  //  - A bar under the Beaten label while editing: [Reset]  …  [Discard] [Save].
  // Both appear only on the viewer's own profile with manual order on.
  function barButton(text, title, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn-base btn-base--default btn-base--size-sm ra-bar-btn";
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function buildEditBar() {
    var bar = document.createElement("div");
    bar.className = "ra-edit-bar";

    var main = document.createElement("div");
    main.className = "ra-bar-main";
    main.appendChild(barButton("Reset", "Back to the default order, with every badge shown",
      function () { bar.setAttribute("data-confirm", "1"); }));
    var spacer = document.createElement("span");
    spacer.className = "ra-bar-spacer";
    main.appendChild(spacer);
    main.appendChild(barButton("Discard", "Leave without saving your changes", discardEditMode));
    main.appendChild(barButton("Save", "Save this arrangement", saveEditMode));

    var confirm = document.createElement("div");
    confirm.className = "ra-bar-confirm";
    var msg = document.createElement("span");
    msg.className = "ra-bar-msg";
    msg.textContent = "Reset to the default order? Your saved order and hidden badges will be deleted.";
    confirm.appendChild(msg);
    confirm.appendChild(barButton("Yes, reset", "", resetEditMode));
    confirm.appendChild(barButton("Cancel", "", function () { bar.removeAttribute("data-confirm"); }));

    bar.appendChild(main);
    bar.appendChild(confirm);
    return bar;
  }

  function updateFooterEditButton() {
    var row = document.querySelector(".ra-footer-manual");
    var fslot = row ? row.querySelector(".ra-edit-slot") : null;
    var bLabel = document.querySelector("#gameawards .ra-beaten-section .ra-grouplabel");
    var ctx = buildContext();
    var editing = !!document.querySelector(".ra-beaten-grid.ra-editing");
    var active = ctx.manualActive && !!bLabel;

    // Footer: "Edit Badges" is ALWAYS visible next to the switch, but it'll be
    // disabled unless this is the viewer's own profile with Manual Order on
    // (and, to avoid editing a half-loaded list, not while the list loads).
    if (fslot) {
      var btn = fslot.querySelector(".ra-edit-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-base btn-base--default btn-base--size-sm ra-edit-btn";
        btn.addEventListener("click", toggleEditMode);
        fslot.appendChild(btn);
      }
      btn.disabled = !active || (beatenExtra.state === "loading" && !editing);
      btn.textContent = editing ? "Save" : "Edit Badges";
    }

    // Beaten section: the Reset / Discard / Save bar (only while editing).
    var section = bLabel ? bLabel.parentNode : null;
    var bar = section ? section.querySelector(".ra-edit-bar") : null;
    if (active && editing) {
      if (!bar && section) {
        var g = section.querySelector(".ra-beaten-grid");
        if (g) section.insertBefore(buildEditBar(), g);
      }
    } else if (bar && bar.parentNode) {
      bar.parentNode.removeChild(bar);
    }
    updateSyncUI();
  }

  // Re-syncs the footer widgets with STORE (after import / storage changes).
  function syncFooterControls() {
    var sel = document.querySelector(".ra-footer-sort-select");
    if (sel) sel.value = getSortPref();
    // A slider the user is dragging right now is the source of truth — never
    // overwrite it from storage.
    var size = document.querySelector(".ra-footer-size .ra-range");
    if (size && !size.hasAttribute("data-dragging")) {
      size.value = String(getBeatenSize());
      syncRangeFill(size);
      var lbl = size.parentNode.querySelector(".ra-range-value");
      if (lbl) lbl.textContent = getBeatenSize() + "%";
    }
    var color = document.querySelector(".ra-footer-color .ra-range");
    if (color && !color.hasAttribute("data-dragging")) {
      color.value = String(getBeatenColor());
      syncRangeFill(color);
      var lbl2 = color.parentNode.querySelector(".ra-range-value");
      if (lbl2) lbl2.textContent = getBeatenColor() + "%";
    }
    var sw = document.querySelector(".ra-footer-manual .ra-switch input");
    if (sw) sw.checked = isManualEnabled();
    updateFooterEditButton();
  }

  // Exits an in-progress edit mode without saving (e.g. Manual Order off).
  function cancelEditModeIfActive() {
    var grid = document.querySelector(".ra-beaten-grid.ra-editing");
    if (grid) grid.classList.remove("ra-editing");
  }

  // RA's footer is absolutely positioned with a FIXED height (320/350px via
  // --footer-height-md/lg) and the body reserves exactly that much space.
  // Our added settings rows make the footer content taller, which would
  // overflow onto the lighter page background. This re-measures the footer
  // and syncs its height and the body's bottom padding.
  function fixFooterHeight() {
    var footer = document.querySelector("footer");
    if (!footer || !document.body) return;
    if (!footer.querySelector(".ra-footer-sort")) return; // nothing injected
    // On mobile (<768px) RA's footer is NOT absolutely positioned — it is
    // static and needs no fixed height or body padding. Setting a padding
    // there creates the "scroll way past the footer" gap seen on phones.
    if (window.innerWidth < 768) {
      footer.style.height = "auto";
      footer.style.boxSizing = "";
      document.body.style.paddingBottom = "";
      return;
    }
    var cs = getComputedStyle(document.documentElement);
    var md = parseInt(cs.getPropertyValue("--footer-height-md"), 10) || 320;
    var lg = parseInt(cs.getPropertyValue("--footer-height-lg"), 10) || 350;
    var min = window.innerWidth >= 1024 ? lg : md;
    footer.style.boxSizing = "border-box";
    footer.style.height = "auto";
    var h = Math.max(footer.offsetHeight, min);
    footer.style.height = h + "px";
    document.body.style.paddingBottom = h + "px";
  }

  // Returns true when the settings rows were added by this call.
  function injectFooterSettings() {
    if (document.querySelector(".ra-footer-sort")) return false;
    var themeSelect = document.querySelector("[data-choose-theme]");
    if (!themeSelect) return false;
    var themeRow = themeSelect.closest(".flex.mb-3.items-center") ||
                   themeSelect.closest(".flex.items-center");
    if (!themeRow || !themeRow.parentNode) return false;

    // --- Beaten Sort row ---
    var sortRow = buildFooterRow("ra-footer-sort");
    sortRow.label.textContent = "Beaten Sort";
    var sel = document.createElement("select");
    sel.className = "ra-footer-sort-select";
    sel.setAttribute("aria-label", "Beaten sort order");
    SORT_OPTIONS.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.value = getSortPref();
    sel.addEventListener("change", function () {
      setSortPref(sel.value);
      maybeQuickCheck();
      var ctx = buildContext();
      if (ctx.manualActive) {
        // A saved arrangement governs the own profile; without one, Manual
        // Order follows the Sort setting, so redraw.
        refreshBeatenSection();
        return;
      }
      var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
      if (grid && !grid.classList.contains("ra-editing")) sortBeatenTiles(grid, sel.value);
    });
    sortRow.controls.appendChild(sel);

    // --- Beaten Size row (50% – 100% of full size) ---
    var sizeRow = buildRangeRow("ra-footer-size", "Beaten Size", "Beaten badge size", 50, 100, 5,
      getBeatenSize(),
      function (v) { STORE[SIZE_KEY] = String(v); applyBeatenStyles(); },   // live, while dragging
      function (v) { setRangePref(SIZE_KEY, v); });                          // saved on release

    // --- Beaten Color row (0 = full grayscale, 100 = full color) ---
    var colorRow = buildRangeRow("ra-footer-color", "Beaten Color", "Beaten badge color", 0, 100, 5,
      getBeatenColor(),
      function (v) { STORE[COLOR_KEY] = String(v); applyBeatenStyles(); },
      function (v) { setRangePref(COLOR_KEY, v); });

    // --- Manual Order row (own profile; only while logged in) ---
    var manualRow = null;
    if (getViewerUsername()) {
      manualRow = buildSwitchRow("ra-footer-manual", "Manual Order",
        "Manual order for your own profile",
        isManualEnabled(),
        function (on) {
          cancelEditModeIfActive(); // toggling off discards an edit in progress
          setManualEnabled(on);
          refreshBeatenSection();
          updateFooterEditButton();
        });
      // "Edit Badges" lives here, next to the switch. It is shown only when
      // the current page is the viewer's own profile with manual order on
      // (kept in sync by updateFooterEditButton).
      var slot = document.createElement("span");
      slot.className = "ra-edit-slot";
      manualRow.controls.appendChild(slot);
    }

    // --- Beaten Data row (reload the full beaten list) ---
    var dataRow = buildFooterRow("ra-footer-data");
    dataRow.label.textContent = "Beaten Data";
    dataRow.row.title = "Loads every beaten game from your progress pages, not only the ones in Completion Progress";
    var syncBtn = document.createElement("button");
    syncBtn.type = "button";
    syncBtn.className = "btn-base btn-base--default btn-base--size-sm ra-sync-btn";
    syncBtn.textContent = "Sync";
    syncBtn.disabled = true;
    syncBtn.addEventListener("click", function () { startSync(true); });
    var syncStatus = document.createElement("span");
    syncStatus.className = "ra-sync-status";
    dataRow.controls.appendChild(syncBtn);
    dataRow.controls.appendChild(syncStatus);

    // --- Backup row (Export / Import settings as JSON) ---
    var backupRow = buildFooterRow("ra-footer-backup");
    backupRow.label.textContent = "Backup";
    var expBtn = document.createElement("button");
    expBtn.type = "button";
    expBtn.className = "btn-base btn-base--default btn-base--size-sm ra-footer-export-btn";
    expBtn.textContent = "Export";
    expBtn.title = "Download your RABG settings as a JSON file";
    expBtn.addEventListener("click", doExport);
    var impBtn = document.createElement("button");
    impBtn.type = "button";
    impBtn.className = "btn-base btn-base--default btn-base--size-sm ra-footer-import-btn";
    impBtn.textContent = "Import";
    impBtn.title = "Load RABG settings from a JSON file";
    impBtn.addEventListener("click", function () {
      var input = document.querySelector(".ra-import-input");
      if (input) { input.value = ""; input.click(); }
    });
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.className = "ra-import-input";
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) doImport(fileInput.files[0]);
    });
    backupRow.controls.appendChild(expBtn);
    backupRow.controls.appendChild(impBtn);
    backupRow.controls.appendChild(fileInput);

    // Insert right after the theme row (i.e. above the copyright row).
    var parent = themeRow.parentNode;
    parent.insertBefore(sortRow.row, themeRow.nextSibling);
    parent.insertBefore(sizeRow, sortRow.row.nextSibling);
    parent.insertBefore(colorRow, sizeRow.nextSibling);
    if (manualRow) parent.insertBefore(manualRow.row, colorRow.nextSibling);
    var afterManual = manualRow ? manualRow.row : colorRow;
    parent.insertBefore(dataRow.row, afterManual.nextSibling);
    parent.insertBefore(backupRow.row, dataRow.row.nextSibling);

    fixFooterHeight();
    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener("resize", fixFooterHeight);
      window.addEventListener("load", fixFooterHeight);
    }
    updateSyncUI();
    return true;
  }
  var resizeBound = false;

  /* ---------- edit mode (drag to reorder, hide/restore) --------------- */

  var dragState = null;   // active press-and-hold gesture
  var scrollBlocker = null;

  function blockScroll(on) {
    if (on && !scrollBlocker) {
      scrollBlocker = function (ev) { ev.preventDefault(); };
      document.addEventListener("touchmove", scrollBlocker, { passive: false });
    } else if (!on && scrollBlocker) {
      document.removeEventListener("touchmove", scrollBlocker);
      scrollBlocker = null;
    }
  }

  function scrollX0() { return window.pageXOffset || 0; }
  function scrollY0() { return window.pageYOffset || 0; }

  function positionGhostAt(x, y) {
    if (!dragState || !dragState.ghost) return;
    var w = (dragState.ghost.offsetWidth / 2) || 24;
    var h = (dragState.ghost.offsetHeight / 2) || 24;
    dragState.ghost.style.left = (x - w) + "px";
    dragState.ghost.style.top = (y - h) + "px";
  }

  function startDrag() {
    if (!dragState) return;
    dragState.active = true;
    var tile = dragState.tile, grid = dragState.grid;
    var ghost = tile.cloneNode(true);
    ghost.classList.add("ra-ghost");
    try { ghost.style.width = tile.offsetWidth + "px"; } catch (e) {}
    document.body.appendChild(ghost);
    dragState.ghost = ghost;
    // Live drop preview: the badge leaves the grid and a dashed slot shows
    // where it will land — the slot follows the pointer between tiles, so
    // there's no guesswork about where a drop will place it.
    var slot = document.createElement("div");
    slot.className = "ra-drop-slot";
    grid.insertBefore(slot, tile);
    if (tile.parentNode) tile.parentNode.removeChild(tile);
    dragState.slot = slot;
    // Cache the visible tiles' geometry so drop targeting is stable: the
    // slot's presence shifts tiles around, which would otherwise feed back
    // into the targeting and make the preview erratic.
    dragState.rects = [];
    var kids = grid.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el === slot) continue;
      if (el.classList && el.classList.contains("ra-hidden")) continue;
      var r = null;
      try { r = el.getBoundingClientRect(); } catch (e) {}
      if (r) dragState.rects.push({ el: el, cx: r.left + r.width / 2 + scrollX0(),
                                    cy: r.top + r.height / 2 + scrollY0() });
    }
    // The badge's own starting place has no tile in it, so it gets a target of
    // its own — otherwise pointing at it would pick a neighbour and the badge
    // could not be put back where it came from.
    dragState.homeNext = slot.nextSibling;
    var hr = null;
    try { hr = slot.getBoundingClientRect(); } catch (e) {}
    if (hr) dragState.rects.push({ home: true, cx: hr.left + hr.width / 2 + scrollX0(),
                                   cy: hr.top + hr.height / 2 + scrollY0() });
    dragState.topInset = stickyHeaderHeight();
    blockScroll(true);
    startAutoScroll();
    // Appear at the pointer's current position (the badge "teleports"
    // under the pointer even if it moved away during the hold).
    positionGhostAt(dragState.lastX, dragState.lastY);
    updateDropSlot(dragState.lastX, dragState.lastY);
  }

  // Moves the drop-preview slot to the tile nearest the pointer. Targeting
  // uses the geometry cached at drag start (stable — no feedback loop) and
  // the nearest tile by center distance, which behaves intuitively across
  // wrapped grid rows.
  function updateDropSlot(x, y) {
    var grid = dragState.grid, slot = dragState.slot;
    if (!grid || !slot || slot.parentNode !== grid) return;
    // Pointer position → page coordinates (the cached tile centers are page
    // coordinates too, so the page may scroll while a badge is being dragged).
    x += scrollX0();
    y += scrollY0();
    var rects = dragState.rects || [];
    var best = null, bestD = Infinity;
    for (var i = 0; i < rects.length; i++) {
      if (!rects[i].home && rects[i].el.parentNode !== grid) continue;
      var dx = x - rects[i].cx, dy = y - rects[i].cy;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = rects[i]; }
    }
    if (!best) return;
    var ref;
    if (best.home) {
      ref = dragState.homeNext;                    // back to where it started
      if (ref && ref.parentNode !== grid) ref = null;
    } else {
      ref = x > best.cx ? best.el.nextSibling : best.el;
    }
    while (ref && ref !== slot && ref.classList && ref.classList.contains("ra-hidden")) {
      ref = ref.nextSibling;
    }
    if (ref && ref !== slot) grid.insertBefore(slot, ref);
    else if (!ref) {
      var fh = grid.querySelector(".ra-hidden");
      if (fh) grid.insertBefore(slot, fh); else grid.appendChild(slot);
    }
  }

  // Drops the badge at the preview slot's position.
  function finishDrop() {
    var grid = dragState.grid, tile = dragState.tile, slot = dragState.slot;
    if (!grid || !tile) return;
    if (slot && slot.parentNode === grid) {
      grid.insertBefore(tile, slot);
      grid.removeChild(slot);
      dragState.slot = null;
    } else {
      grid.appendChild(tile);
    }
  }

  // While a badge is held near the top or bottom edge of the window, the page
  // scrolls by itself so the badge can be carried across a long list. (Touch
  // scrolling is blocked during a drag, so this is the only way there.)
  var autoScrollRaf = null;
  function autoScrollStep() {
    autoScrollRaf = null;
    if (!dragState || !dragState.active || !dragState.grid) return;
    var EDGE = 70, MAX = 16, dy = 0;
    var vh = window.innerHeight || 0;
    var top = dragState.topInset || 0;
    var y = dragState.lastY;
    var gr = null;
    try { gr = dragState.grid.getBoundingClientRect(); } catch (e) {}
    if (gr && vh > 0) {
      // Only while the badge list actually continues beyond that edge.
      if (y < top + EDGE && gr.top < top + 8) {
        dy = -Math.ceil(MAX * Math.min(1, (top + EDGE - y) / EDGE));
      } else if (y > vh - EDGE && gr.bottom > vh - 8) {
        dy = Math.ceil(MAX * Math.min(1, (y - (vh - EDGE)) / EDGE));
      }
    }
    if (dy) {
      try { window.scrollBy({ top: dy, left: 0, behavior: "instant" }); }
      catch (e) { window.scrollBy(0, dy); }
      updateDropSlot(dragState.lastX, dragState.lastY);
    }
    autoScrollRaf = window.requestAnimationFrame(autoScrollStep);
  }
  function startAutoScroll() {
    if (!autoScrollRaf && typeof window.requestAnimationFrame === "function") {
      autoScrollRaf = window.requestAnimationFrame(autoScrollStep);
    }
  }
  function stopAutoScroll() {
    if (autoScrollRaf) {
      try { window.cancelAnimationFrame(autoScrollRaf); } catch (e) {}
      autoScrollRaf = null;
    }
  }

  function cleanupDrag() {
    stopAutoScroll();
    if (dragState) {
      if (dragState.ghost && dragState.ghost.parentNode) {
        dragState.ghost.parentNode.removeChild(dragState.ghost);
      }
      if (dragState.slot && dragState.slot.parentNode) {
        dragState.slot.parentNode.removeChild(dragState.slot);
      }
    }
    dragState = null;
    blockScroll(false);
  }

  function endGesture() {
    if (!dragState) return;
    if (dragState.holdTimer) { clearTimeout(dragState.holdTimer); dragState.holdTimer = null; }
    if (dragState.active) finishDrop();
    cleanupDrag();
  }

  function setupGlobalDragListeners() {
    document.addEventListener("pointermove", function (e) {
      if (!dragState) return;
      dragState.lastX = (e.clientX || 0);
      dragState.lastY = (e.clientY || 0);
      if (!dragState.active) {
        // Touch: moving before the hold fires means a scroll — cancel.
        // Mouse: the hold survives movement anywhere on the page; the badge
        // teleports under the pointer once the hold time elapses.
        if (dragState.pointerType === "touch") {
          var dx = dragState.lastX - dragState.startX;
          var dy = dragState.lastY - dragState.startY;
          if (Math.sqrt(dx * dx + dy * dy) > 12) endGesture();
        }
        return;
      }
      e.preventDefault();
      positionGhostAt(dragState.lastX, dragState.lastY);
      updateDropSlot(dragState.lastX, dragState.lastY);
    }, { passive: false });
    // The page moved under a held badge (mouse wheel, keyboard): re-aim.
    window.addEventListener("scroll", function () {
      if (dragState && dragState.active) updateDropSlot(dragState.lastX, dragState.lastY);
    }, { passive: true });
    document.addEventListener("pointerup", function () { if (dragState) endGesture(); });
    document.addEventListener("pointercancel", function () { if (dragState) endGesture(); });
  }

  function attachTileDrag(tile, grid) {
    tile.addEventListener("pointerdown", function (e) {
      if (!grid.classList.contains("ra-editing")) return;
      if (tile.classList.contains("ra-hidden")) return; // hidden badges don't drag
      if (e.button !== undefined && e.button !== 0) return;
      if (dragState) return;
      // Don't hijack the ✕ / ＋ buttons.
      var t = e.target;
      while (t && t !== tile) {
        if (t.classList && t.classList.contains("ra-tile-btn")) return;
        t = t.parentNode;
      }
      dragState = {
        tile: tile, grid: grid, ghost: null, active: false,
        startX: (e.clientX || 0), startY: (e.clientY || 0),
        lastX: (e.clientX || 0), lastY: (e.clientY || 0),
        pointerType: e.pointerType || "",
        holdTimer: setTimeout(startDrag, HOLD_MS)
      };
    });
  }

  function attachTileButton(tile, grid) {
    if (tile.querySelector(".ra-tile-btn")) return;
    var hidden = tile.classList.contains("ra-hidden");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ra-tile-btn " + (hidden ? "ra-plus" : "ra-x");
    btn.textContent = hidden ? "＋" : "✕";
    btn.title = hidden ? "Show this badge again" : "Hide this badge";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleTileHidden(tile, grid);
    });
    tile.appendChild(btn);
  }

  function toggleTileHidden(tile, grid) {
    var btn = tile.querySelector(".ra-tile-btn");
    if (!btn) return;
    if (tile.classList.contains("ra-hidden")) {
      tile.classList.remove("ra-hidden");
      btn.className = "ra-tile-btn ra-x";
      btn.textContent = "✕";
      btn.title = "Hide this badge";
      var firstHidden = grid.querySelector(".ra-hidden");
      if (firstHidden) grid.insertBefore(tile, firstHidden);
      else grid.appendChild(tile);
    } else {
      tile.classList.add("ra-hidden");
      btn.className = "ra-tile-btn ra-plus";
      btn.textContent = "＋";
      btn.title = "Show this badge again";
      grid.appendChild(tile); // hidden badges sit at the end
    }
  }

  function enterEditMode(grid, hiddenGames, username) {
    grid.classList.add("ra-editing");
    // Reveal hidden badges at the end (half-transparent, restorable).
    hiddenGames.forEach(function (g) {
      var t = makeBeatenTile(g, username);
      t.classList.add("ra-hidden");
      grid.appendChild(t);
    });
    var tiles = grid.querySelectorAll("[data-beaten]");
    for (var i = 0; i < tiles.length; i++) {
      attachTileButton(tiles[i], grid);
      attachTileDrag(tiles[i], grid);
    }
  }

  // Footer / popup button: starts editing, or saves when already editing.
  function toggleEditMode() {
    var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
    if (grid && grid.classList.contains("ra-editing")) { saveEditMode(); return; }
    startEditMode();
  }

  // SAVE — persist the arrangement shown in the grid.
  function saveEditMode() {
    var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
    if (!grid || !grid.classList.contains("ra-editing")) return;
    var order = [], hidden = [];
    var tiles = grid.querySelectorAll("[data-beaten]");
    for (var i = 0; i < tiles.length; i++) {
      var id = tiles[i].getAttribute("data-gameid");
      if (tiles[i].classList.contains("ra-hidden")) hidden.push(id);
      else order.push(id);
    }
    // Games that were saved earlier but aren't in the grid right now keep
    // their place instead of being forgotten.
    var prev = getManualData(getUsername());
    if (prev) {
      var present = Object.create(null);
      order.concat(hidden).forEach(function (id) { present[id] = true; });
      prev.order.forEach(function (id) { if (!present[id]) { present[id] = true; order.push(id); } });
      prev.hidden.forEach(function (id) { if (!present[id]) { present[id] = true; hidden.push(id); } });
    }
    grid.classList.remove("ra-editing"); // exit edit mode (unblocks refresh)
    setManualData(getUsername(), { order: order, hidden: hidden });
    refreshBeatenSection(); // re-renders in normal (saved) view
  }

  // DISCARD — leave edit mode; the saved arrangement stays as it was.
  function discardEditMode() {
    var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
    if (!grid || !grid.classList.contains("ra-editing")) return;
    grid.classList.remove("ra-editing");
    refreshBeatenSection();
  }

  // RESET — delete the saved arrangement (default order, nothing hidden).
  function resetEditMode() {
    var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
    if (!grid || !grid.classList.contains("ra-editing")) return;
    grid.classList.remove("ra-editing");
    clearManualData(getUsername());
    refreshBeatenSection();
  }

  // Height of a fixed/sticky bar stuck to the top of the viewport (RA's menu).
  function stickyHeaderHeight() {
    var h = 0;
    try {
      var els = document.querySelectorAll("header, nav, #app-header, .navbar");
      for (var i = 0; i < els.length; i++) {
        var cs = window.getComputedStyle(els[i]);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        var r = els[i].getBoundingClientRect();
        if (r.top <= 2 && r.bottom > 0 && r.bottom < 220) h = Math.max(h, r.bottom);
      }
    } catch (e) {}
    return h;
  }

  // Brings the Reset / Discard / Save bar into view (with the Beaten label
  // just above it), clear of any sticky site menu. Entering edit mode is
  // usually triggered from the footer or the toolbar popup, far below.
  function scrollEditBarIntoView() {
    var bar = document.querySelector("#gameawards .ra-edit-bar");
    if (!bar) return;
    function go(smooth) {
      var top = bar.getBoundingClientRect().top + (window.pageYOffset || 0) -
                stickyHeaderHeight() - 64;
      try { window.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" }); }
      catch (e) { window.scrollTo(0, Math.max(0, top)); }
    }
    go(true);
    // Layout can still shift while a smooth scroll runs (images, the grid
    // growing) — check again and correct instantly if the bar isn't visible.
    setTimeout(function () {
      var r = bar.getBoundingClientRect();
      if (r.top < stickyHeaderHeight() + 4 || r.bottom > (window.innerHeight || 0)) go(false);
    }, 800);
  }

  function startEditMode() {
    var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
    var awards = document.getElementById("gameawards");
    if (!grid || !awards || beatenExtra.state === "loading") return;
    var ctx = buildContext();
    var beaten = getAllBeaten(computeMasteredIds(awards));
    var split = applyManualOrder(beaten, ctx.manual || { order: [], hidden: [] });
    enterEditMode(grid, split.hiddenGames, ctx.username);
    updateFooterEditButton();
    scrollEditBarIntoView();
  }

  /* ---------- beaten section rendering -------------------------------- */

  function buildContext() {
    var username = getUsername();
    var viewer = getViewerUsername();
    var active = manualIsActive(username, viewer);
    return {
      username: username,
      viewer: viewer,
      manualActive: active,
      manual: active ? (getManualData(username) || { order: [], hidden: [] }) : null
    };
  }

  function buildBeatenSection(beaten, gridClass, withDivider, totals, ctx) {
    var section = document.createElement("div");
    section.className = "ra-beaten-section";

    if (withDivider) {
      var divider = document.createElement("div");
      divider.className = "ra-divider";
      section.appendChild(divider);
    }

    var visible = beaten;
    if (ctx.manualActive && ctx.manual) {
      visible = applyManualOrder(beaten, ctx.manual).visible;
    }

    var hcF = 0, scF = 0, hcV = 0, scV = 0;
    beaten.forEach(function (g) { if (g.type === "hc") hcF++; else scF++; });
    visible.forEach(function (g) { if (g.type === "hc") hcV++; else scV++; });
    var hcTotal = totals && typeof totals.hc === "number" ? totals.hc : hcF;
    var scTotal = totals && typeof totals.sc === "number" ? totals.sc : scF;

    var bLabel = buildGroupLabel("Beaten", false);
    var hcDisp = Math.max(hcTotal, hcF);
    if (hcDisp > 0) {
      var hcHid = beatenExtra.state === "loading" ? 0 : Math.max(0, hcDisp - hcV);
      bLabel.appendChild(makeCrownCounter("silver", hcDisp,
        hcDisp + " games beaten" + (hcHid > 0 ? " (" + hcHid + " hidden)" : "")));
    }
    var scDisp = Math.max(scTotal, scF);
    if (scDisp > 0) {
      var scHid = beatenExtra.state === "loading" ? 0 : Math.max(0, scDisp - scV);
      bLabel.appendChild(makeMedalCounter(scDisp,
        scDisp + " games beaten (casual)" + (scHid > 0 ? " (" + scHid + " hidden)" : "")));
    }

    section.appendChild(bLabel);

    var bGrid = document.createElement("div");
    bGrid.className = gridClass + " ra-beaten-grid";
    visible.forEach(function (g) { bGrid.appendChild(makeBeatenTile(g, ctx.username)); });
    section.appendChild(bGrid);

    // No sorting here: getAllBeaten() already delivers the games in the order
    // of the Sort setting (and applyManualOrder keeps a saved arrangement).
    return section;
  }

  // (Re)builds the Beaten section inside `awards`. Safe to call repeatedly.
  function renderBeatenSection(awards, beaten, gridClass, withDivider, totals, ctx) {
    // Build the new section first: if anything goes wrong the existing one
    // stays on the page instead of the Beaten badges vanishing.
    var section;
    try {
      section = buildBeatenSection(beaten, gridClass, withDivider, totals, ctx);
    } catch (e) {
      console.info("[RABG] Could not build the Beaten section:", e);
      return null;
    }
    var old = awards.querySelector(".ra-beaten-section");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (withDivider) {
      var mGrid = awards.querySelector(".grid");
      if (mGrid && mGrid.parentNode) mGrid.parentNode.insertBefore(section, mGrid.nextSibling);
      else awards.appendChild(section);
    } else {
      awards.appendChild(section);
    }
    return section;
  }

  // Re-renders the Beaten section (e.g. after toggling Manual Order, or a
  // storage change from another tab). Never clobbers an active edit mode.
  function refreshBeatenSection() {
    if (document.querySelector(".ra-beaten-grid.ra-editing")) return;
    var awards = document.getElementById("gameawards");
    if (!awards || !awards.querySelector(".ra-beaten-section")) return;
    // The Mastered grid (not the Beaten one). Profiles without any Mastered
    // badges have no Mastered label — and therefore no divider.
    var mGrid = awards.querySelector(".grid:not(.ra-beaten-grid)");
    var hasMastered = !!awards.querySelector(".ra-grouplabel-first");
    var ctx = buildContext();
    var beaten = getAllBeaten(computeMasteredIds(awards));
    var totals = getBeatenTotals();
    renderBeatenSection(awards, beaten, mGrid ? mGrid.className : GRID_CLASSES, hasMastered, totals, ctx);
    updateFooterEditButton();
  }

  /* ---------- main apply routine -------------------------------------- */

  function apply() {
    var awards = document.getElementById("gameawards");
    if (awards && awards.dataset.raApplied === "v2" && awards.querySelector(".ra-grouplabel")) {
      return true;
    }

    var ctx = buildContext();
    var beatenTotals = getBeatenTotals();
    var hasTotal = !!(beatenTotals && (beatenTotals.hc > 0 || beatenTotals.sc > 0));
    var created = false;
    // Use the cached complete list if it is current, otherwise start loading it
    // (the Beaten section is rendered right away and fills up as pages arrive).
    maybeAutoSync();

    if (awards) {
      var grid = awards.querySelector(".grid");
      if (!grid) return false;

      var counts = readMasteryCounts(awards);

      var oldCounters = awards.querySelectorAll("h3 .cursor-help");
      for (var i = 0; i < oldCounters.length; i++) oldCounters[i].remove();

      if (!awards.querySelector(".ra-grouplabel")) {
        var mLabel = buildGroupLabel("Mastered", true);
        if (counts.hc > 0)
          mLabel.appendChild(makeCrownCounter("gold", counts.hc, counts.hcTitle || (counts.hc + " games mastered")));
        if (counts.sc > 0)
          mLabel.appendChild(makeMedalCounter(counts.sc, counts.scTitle || (counts.sc + " games completed")));
        awards.insertBefore(mLabel, grid);
      }

      var beaten = getAllBeaten(computeMasteredIds(awards));
      if (beaten.length > 0 || hasTotal) {
        renderBeatenSection(awards, beaten, grid.className, true, beatenTotals, ctx);
      }

      awards.dataset.raApplied = "v2";
    } else {
      var beaten0 = getAllBeaten(Object.create(null));
      if (beaten0.length === 0 && !hasTotal) return true;
      var completed = document.getElementById("completedgames");
      if (!completed || !completed.parentNode) return false;

      awards = document.createElement("div");
      awards.id = "gameawards";
      awards.appendChild(buildTitle());
      renderBeatenSection(awards, beaten0, GRID_CLASSES, false, beatenTotals, ctx);
      completed.parentNode.insertBefore(awards, completed);
      awards.dataset.raApplied = "v2";
      created = true;
    }

    updateFooterEditButton();

    console.info(
      "[RABG] " + "Beaten section ready" +
      (beatenTotals ? " (Progression Status: " + beatenTotals.hc + " HC, " + beatenTotals.sc + " SC)" : "") +
      (ctx.manualActive ? " — manual order active" : "") +
      (created ? " — created the Game Awards box." : ".")
    );
    updateSyncUI();
    return true;
  }

  /* ---------- site theme capture (used by the popup) ------------------- */

  // Resolve RA's effective color scheme. RA renders it as an attribute on
  // <body> (NOT <html>): data-scheme="" means Dark, "black" = Black,
  // "light" = Light, "system" = follow the OS (resolved here via matchMedia
  // — RA's own CSS does the same with a media query). Falls back to <html>
  // and finally to the OS preference, then Dark.
  function resolveScheme() {
    var v = "";
    try {
      if (document.body) v = (document.body.getAttribute("data-scheme") || "").toLowerCase();
    } catch (e) {}
    if (!v) {
      try {
        v = (document.documentElement.getAttribute("data-scheme") || "").toLowerCase();
      } catch (e) {}
    }
    if (v === "black") return "black";
    if (v === "light") return "light";
    if (v === "system") {
      try {
        if (window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
      } catch (e) {}
    }
    return "dark";
  }

  // The popup can't read the site's CSS (different document), so we capture
  // the live RA colors here — including the *rendered* button colors via a
  // hidden probe element — and store them for the popup to apply.
  function captureSiteTheme() {
    try {
      var probe = document.createElement("span");
      probe.className = "btn-base btn-base--default btn-base--size-sm";
      probe.style.display = "none";
      // Force a concrete border so the computed border-color resolves.
      probe.style.borderWidth = "1px";
      probe.style.borderStyle = "solid";
      document.body.appendChild(probe);
      var cs = getComputedStyle(probe);
      // CRITICAL: read the theme variables from <body>'s computed style.
      // RA defines the dark palette on :root, but the Black/Light scheme
      // values and the color-theme overrides (e.g. the default theme's
      // blue text / gold links) live in [data-scheme=…] / [data-theme=…]
      // rules attached to <body> — they never inherit back up to <html>.
      // Reading from documentElement always yielded the dark :root values.
      var bcs = getComputedStyle(document.body);
      var scheme = resolveScheme();
      var light = scheme === "light";
      var theme = {
        scheme: scheme,
        menu: bcs.getPropertyValue("--menu-link-color").trim(),
        btnText: (cs.color || "").trim(),
        btnBg: (cs.backgroundColor || "").trim(),
        btnBorder: (cs.borderTopColor || "").trim(),
        btnHoverText: bcs.getPropertyValue("--link-hover-color").trim(),
        btnHoverBorder: bcs.getPropertyValue("--menu-link-color").trim(),
        // RA's light-scheme buttons (btn-base) hover on neutral-100, not
        // embed-highlight (that's the dark-scheme / classic .btn recipe).
        btnHoverBg: light
          ? (bcs.getPropertyValue("--color-neutral-100").trim() || "#f5f5f5")
          : bcs.getPropertyValue("--embed-highlight-color").trim(),
        selectBg: bcs.getPropertyValue("--embed-color").trim(),
        switchOn: bcs.getPropertyValue("--text-color").trim(),
        switchOff: light
          ? (bcs.getPropertyValue("--color-neutral-200").trim() || "#e5e5e5")
          : (bcs.getPropertyValue("--color-neutral-700").trim() || "#3f3f46"),
        knob: light ? "#ffffff"
          : (bcs.getPropertyValue("--color-neutral-50").trim() || "#fafafa"),
        bg: bcs.getPropertyValue("--bg-color").trim(),
        box: bcs.getPropertyValue("--box-bg-color").trim(),
        highlight: bcs.getPropertyValue("--embed-highlight-color").trim(),
        text: bcs.getPropertyValue("--text-color").trim(),
        heading: bcs.getPropertyValue("--heading-color").trim(),
        muted: bcs.getPropertyValue("--text-color-muted").trim()
      };
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      if (theme.btnBg === "rgba(0, 0, 0, 0)" || theme.btnBg === "transparent") theme.btnBg = "";
      // Only write when something actually changed (storage.onChanged
      // listeners in the popup re-theme live; avoid needless churn).
      if (STORE["rabg-scheme"] !== theme.scheme) {
        storeSet("rabg-scheme", theme.scheme); // standalone, simple key
      }
      var cur = STORE["rabg-site-theme"];
      if (JSON.stringify(cur) !== JSON.stringify(theme)) {
        storeSet("rabg-site-theme", theme);
      }
    } catch (e) {}
  }

  // Re-capture the theme when the user changes it. RA swaps data-scheme /
  // data-theme on <body> without reloading (its footer Theme/Scheme selects
  // update the attribute live), so we watch <body> — plus the selects
  // themselves as an early signal — and the OS scheme for "system" mode.
  var themeObserver = null;
  function startThemeObserver() {
    if (themeObserver) return;
    var deb = null;
    function scheduleCapture() {
      if (deb) return;
      deb = setTimeout(function () { deb = null; captureSiteTheme(); }, 250);
    }
    themeObserver = new MutationObserver(scheduleCapture);
    try {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-scheme", "class"]
      });
    } catch (e) {}
    try {
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ["data-theme", "data-scheme", "class", "style"]
        });
      }
    } catch (e) {}
    try {
      var sels = document.querySelectorAll(
        "select[data-choose-theme], select[data-choose-scheme]");
      for (var i = 0; i < sels.length; i++) {
        sels[i].addEventListener("change", scheduleCapture);
      }
    } catch (e) {}
    try {
      if (window.matchMedia) {
        var mq = window.matchMedia("(prefers-color-scheme: light)");
        var onChange = function () { scheduleCapture(); };
        if (mq.addEventListener) mq.addEventListener("change", onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    } catch (e) {}
    // Some RA pages apply their theme shortly after DOMContentLoaded —
    // capture once more after things settle (a no-op if nothing changed).
    setTimeout(function () { captureSiteTheme(); }, 1500);
  }

  /* ---------- popup messaging (state query + edit toggle) -------------- */

  // Lets the toolbar popup ask about the current page and toggle edit mode.
  // Registered after prefs load so STORE is ready.
  function startMessageListener() {
    var rt = runtime();
    if (!rt || !rt.onMessage || !rt.onMessage.addListener) return;
    rt.onMessage.addListener(function (msg, sender, respond) {
      if (!msg || typeof msg !== "object") return;
      var ctx = buildContext();
      var ownProfile = sameUser(ctx.viewer, ctx.username) &&
        !!document.querySelector("#gameawards .ra-beaten-section");
      if (msg.type === "rabg-get-state") {
        // `ownProfile` is stable regardless of the Manual Order toggle, so
        // the popup can combine it with its own (instant) checkbox state —
        // no race with the storage change still propagating.
        respond({
          ok: true,
          ownProfile: ownProfile,
          manualActive: ctx.manualActive && ownProfile,
          editing: !!document.querySelector(".ra-beaten-grid.ra-editing"),
          sync: syncInfo()
        });
      } else if (msg.type === "rabg-sync") {
        startSync(true);
        respond({ ok: true, ownProfile: ownProfile, sync: syncInfo() });
      } else if (msg.type === "rabg-open-import") {
        // Popups get destroyed by the native file dialog, and programmatic
        // file-input clicks need a real in-page gesture — so the popup asks
        // us to show a small in-page prompt; its click opens the picker via
        // the proven footer-import path.
        highlightFooterImport();
        respond({ ok: true });
      } else if (msg.type === "rabg-toggle-edit") {
        if (ctx.manualActive && ownProfile) {
          toggleEditMode();
        }
        respond({
          ok: true,
          ownProfile: ownProfile,
          editing: !!document.querySelector(".ra-beaten-grid.ra-editing"),
          sync: syncInfo()
        });
      }
    });
  }

  /* ---------- boot: load prefs → footer → apply → observe ------------- */

  var retryTimer = null;
  function scheduleRetry() {
    if (retryTimer) return;
    var tries = 0;
    retryTimer = setInterval(function () {
      if (apply() || ++tries > 24) clearInterval(retryTimer);
    }, 500);
  }

  var observer = null, debounce = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function () {
      if (debounce) return;
      debounce = setTimeout(function () {
        debounce = null;
        // The footer is re-measured only when it was (re)built; the profile
        // logic only ever runs on /user/<name> pages.
        if (injectFooterSettings()) fixFooterHeight();
        if (isProfilePage()) apply();
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    injectFooterSettings();
    captureSiteTheme();
    startThemeObserver();
    var ok = isProfilePage() ? apply() : true;
    updateFooterEditButton(); // footer button exists (disabled) even off-profile
    if (ok) startObserver();
    else { scheduleRetry(); startObserver(); }
  }

  function init() {
    var rt = runtime();
    if (rt && rt.getURL) {
      crownUrls.gold = rt.getURL("icons/gold.svg");
      crownUrls.silver = rt.getURL("icons/silver.svg");
    }
    setupGlobalDragListeners();
    loadAllPrefs(function () {
      applyBeatenStyles();
      startStorageListener();
      startMessageListener();
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
      else run();
    });
  }

  init();
})();