/*
 * RABG popup — toolbar-click settings panel.
 * Reads/writes the same storage.local keys the content script uses; the
 * content script's storage-change listener applies edits to open RA tabs
 * instantly. The "Edit Badges" button (shown only when the active tab is
 * the viewer's own profile with Manual Order on) talks to the content
 * script via tabs.sendMessage — no extra permissions required.
 */
(function () {
  "use strict";

  var SORT_KEY = "ra-beaten-sort-v1";
  var SIZE_KEY = "rabg-beaten-size";
  var COLOR_KEY = "rabg-beaten-color";
  var MANUAL_ENABLED_KEY = "rabg-manual-enabled";
  var POPUP_THEME_KEY = "rabg-popup-theme";
  var LEGACY_KEYS = [SORT_KEY, SIZE_KEY, COLOR_KEY];
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
  var THEME_OPTIONS = [
    ["auto", "Auto (match site)"],
    ["dark", "Dark"],
    ["black", "Black"],
    ["light", "Light"]
  ];

  /* ---------- storage helpers (mirror content.js) ---------------------- */

  function storageArea() {
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) return browser.storage.local;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) return chrome.storage.local;
    return null;
  }

  function getStore(cb) {
    var area = storageArea();
    if (!area) { cb({}); return; }
    var done = false;
    function finish(items) { if (!done) { done = true; cb(items || {}); } }
    try {
      var p = area.get(null);
      if (p && typeof p.then === "function") { p.then(finish, function () { finish({}); }); return; }
    } catch (e) {}
    try { area.get(null, function (items) { finish(items); }); }
    catch (e) { finish({}); }
  }

  function setKey(key, value) {
    var area = storageArea();
    if (!area) return;
    var obj = {};
    obj[key] = value;
    try {
      var p = area.set(obj);
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {}
  }

  // Same rule as content.js: the beaten-list cache and the captured site
  // theme are internal data, not settings.
  function knownSettingsKey(k) {
    if (LEGACY_KEYS.indexOf(k) !== -1) return true;
    if (k.indexOf("rabg-") !== 0) return false;
    if (k === "rabg-store" || k === "rabg-site-theme" || k === "rabg-scheme") return false;
    if (k === "rabg-cache-index" || k.indexOf("rabg-cache-") === 0) return false;
    return true;
  }

  // Applies the site theme captured by the content script: first the
  // scheme class (RA's exact per-scheme palette, built into popup.css),
  // then any live-captured values as refinements (theme-specific colors).
  // `scheme` (from the standalone "rabg-scheme" key) takes precedence.
  // Any previously-set inline refinements are cleared first so switching
  // between "Auto" and a forced scheme never leaves stale colors behind.
  var RABG_VARS = [
    "--rabg-bg", "--rabg-panel", "--rabg-border", "--rabg-text",
    "--rabg-heading", "--rabg-muted", "--rabg-menu", "--rabg-select-bg",
    "--rabg-btn-bg", "--rabg-btn-border", "--rabg-btn-text",
    "--rabg-btn-hover-bg", "--rabg-btn-hover-border", "--rabg-btn-hover-text",
    "--rabg-switch-on", "--rabg-switch-off", "--rabg-knob", "--rabg-slider"
  ];
  function applySiteTheme(t, scheme) {
    var root = document.documentElement;
    root.classList.remove("rabg-scheme-dark", "rabg-scheme-black", "rabg-scheme-light");
    var sch = scheme || (t && t.scheme);
    if (sch === "black" || sch === "light" || sch === "dark") {
      root.classList.add("rabg-scheme-" + sch);
    }
    for (var i = 0; i < RABG_VARS.length; i++) root.style.removeProperty(RABG_VARS[i]);
    if (!t || typeof t !== "object") return;
    var r = root.style;
    var map = {
      "--rabg-bg": t.bg, "--rabg-panel": t.box, "--rabg-border": t.highlight,
      "--rabg-text": t.text, "--rabg-heading": t.heading, "--rabg-muted": t.muted,
      "--rabg-menu": t.menu, "--rabg-select-bg": t.selectBg,
      "--rabg-btn-bg": t.btnBg, "--rabg-btn-border": t.btnBorder,
      "--rabg-btn-text": t.btnText,
      "--rabg-btn-hover-bg": t.btnHoverBg, "--rabg-btn-hover-border": t.btnHoverBorder,
      "--rabg-btn-hover-text": t.btnHoverText,
      "--rabg-switch-on": t.switchOn, "--rabg-switch-off": t.switchOff,
      "--rabg-knob": t.knob, "--rabg-slider": t.switchOn
    };
    for (var k in map) if (map[k]) r.setProperty(k, map[k]);
  }

  function clampInt(v, def, min, max) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  // Keeps the custom-drawn slider fill (the Chromium track gradient) in
  // sync with the input's value.
  function syncRangeFill(r) {
    var min = parseFloat(r.min), max = parseFloat(r.max);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 100;
    var pct = max > min ? ((parseFloat(r.value) - min) / (max - min)) * 100 : 0;
    if (!isFinite(pct)) pct = 0;
    r.style.setProperty("--ra-fill", Math.max(0, Math.min(100, pct)) + "%");
  }

  /* ---------- tab messaging (Edit Badges ↔ content script) ------------- */

  function tabsApi() {
    if (typeof browser !== "undefined" && browser.tabs) return browser.tabs;
    if (typeof chrome !== "undefined" && chrome.tabs) return chrome.tabs;
    return null;
  }

  function withActiveTab(cb) {
    var tabs = tabsApi();
    if (!tabs) { cb(null); return; }
    try {
      var p = tabs.query({ active: true, currentWindow: true });
      if (p && typeof p.then === "function") {
        p.then(function (t) { cb(t && t[0] ? t[0].id : null); },
               function () { cb(null); });
        return;
      }
    } catch (e) {}
    try {
      tabs.query({ active: true, currentWindow: true }, function (t) {
        cb(t && t[0] ? t[0].id : null);
      });
    } catch (e) { cb(null); }
  }

  function sendToTab(tabId, msg, cb) {
    var tabs = tabsApi();
    if (!tabs || tabId == null) { cb(null); return; }
    try {
      var p = tabs.sendMessage(tabId, msg);
      if (p && typeof p.then === "function") {
        p.then(function (r) { cb(r || null); }, function () { cb(null); });
        return;
      }
    } catch (e) {}
    try { tabs.sendMessage(tabId, msg, function (r) { cb(r || null); }); }
    catch (e) { cb(null); }
  }

  /* ---------- wire up --------------------------------------------------- */

  var $ = function (id) { return document.getElementById(id); };
  var sortSel = $("sort");
  var sizeRange = $("size");
  var sizeVal = $("size-val");
  var colorRange = $("color");
  var colorVal = $("color-val");
  var manualBox = $("manual");
  var editBtn = $("edit");
  var themeSel = $("popup-theme");

  SORT_OPTIONS.forEach(function (o) {
    var op = document.createElement("option");
    op.value = o[0];
    op.textContent = o[1];
    sortSel.appendChild(op);
  });
  THEME_OPTIONS.forEach(function (o) {
    var op = document.createElement("option");
    op.value = o[0];
    op.textContent = o[1];
    themeSel.appendChild(op);
  });

  function render(store) {
    var sort = store[SORT_KEY];
    var ok = false;
    for (var i = 0; i < SORT_OPTIONS.length; i++) if (SORT_OPTIONS[i][0] === sort) ok = true;
    sortSel.value = ok ? sort : "pct-desc";

    var size = clampInt(store[SIZE_KEY], 100, 50, 100);
    sizeRange.value = String(size);
    sizeVal.textContent = size + "%";
    syncRangeFill(sizeRange);

    var color = clampInt(store[COLOR_KEY], 100, 0, 100);
    colorRange.value = String(color);
    colorVal.textContent = color + "%";
    syncRangeFill(colorRange);

    manualBox.checked = store[MANUAL_ENABLED_KEY] === "1";

    var pref = store[POPUP_THEME_KEY];
    var okTheme = false;
    for (var j = 0; j < THEME_OPTIONS.length; j++) {
      if (THEME_OPTIONS[j][0] === pref) okTheme = true;
    }
    themeSel.value = okTheme ? pref : "auto";
  }

  sortSel.addEventListener("change", function () { setKey(SORT_KEY, sortSel.value); });
  sizeRange.addEventListener("input", function () {
    sizeVal.textContent = sizeRange.value + "%";
    syncRangeFill(sizeRange);
    setKey(SIZE_KEY, sizeRange.value);
  });
  colorRange.addEventListener("input", function () {
    colorVal.textContent = colorRange.value + "%";
    syncRangeFill(colorRange);
    setKey(COLOR_KEY, colorRange.value);
  });
  manualBox.addEventListener("change", function () {
    setKey(MANUAL_ENABLED_KEY, manualBox.checked ? "1" : "0");
    refreshEditButton();
  });
  themeSel.addEventListener("change", function () {
    setKey(POPUP_THEME_KEY, themeSel.value);
    getStore(applyStoreTheme); // re-apply immediately with the new preference
  });

  /* ---------- Edit Badges (active tab's own profile only) --------------- */

  function setEditButton(state) {
    // The button is always visible; it's enabled only when the active tab
    // is the viewer's own profile AND Manual Order is on (our own checkbox —
    // instant, never racy). The label also never says "Save"
    // while manual is off — the page cancels edit mode when manual goes
    // off, and this local rule avoids the storage round-trip race.
    var own = !!(state && state.ok && state.ownProfile);
    var editing = !!(state && state.editing && manualBox.checked);
    var loading = !!(state && state.sync && state.sync.state === "loading");
    editBtn.disabled = !(own && manualBox.checked) || (loading && !editing);
    editBtn.textContent = editing ? "Save" : "Edit Badges";
    // Import needs a live RA tab (it shows an in-page file prompt there).
    $("import").disabled = !(state && state.ok);
    applySyncState(state);
  }

  // "Beaten Data → Sync": enabled on a profile page with a Beaten section; the
  // status line shows loading progress / the last sync. While a sync runs the
  // popup re-asks the page once a second so the progress stays live.
  var syncBtn = $("sync");
  var syncRow = $("sync-row");
  var syncText = $("sync-status");
  var syncPoll = null;
  function applySyncState(state) {
    var s = state && state.ok && state.sync ? state.sync : null;
    syncBtn.disabled = !(s && s.can);
    syncBtn.title = s && s.can ? "Reload the full beaten list from RetroAchievements"
                               : "Open a RetroAchievements profile to sync";
    var text = s ? s.text : "";
    syncText.textContent = text;
    syncRow.hidden = !text;
    if (s && s.state === "loading") {
      if (!syncPoll) syncPoll = setInterval(refreshEditButton, 1000);
    } else if (syncPoll) {
      clearInterval(syncPoll);
      syncPoll = null;
    }
  }

  function refreshEditButton() {
    withActiveTab(function (tabId) {
      sendToTab(tabId, { type: "rabg-get-state" }, setEditButton);
    });
  }

  syncBtn.addEventListener("click", function () {
    withActiveTab(function (tabId) {
      sendToTab(tabId, { type: "rabg-sync" }, applySyncState);
    });
  });

  editBtn.addEventListener("click", function () {
    withActiveTab(function (tabId) {
      sendToTab(tabId, { type: "rabg-toggle-edit" }, setEditButton);
    });
  });

  /* ---------- export / import ------------------------------------------- */

  $("export").addEventListener("click", function () {
    getStore(function (store) {
      try {
        var payload = {};
        for (var k in store) if (knownSettingsKey(k)) payload[k] = store[k];
        var json = JSON.stringify(payload, null, 2);
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
        console.info("[RABG popup] Export failed: " + e);
      }
    });
  });

  // The native file dialog destroys popups, and programmatic file-picker
  // clicks need a real in-page gesture — so Import asks the active RA tab
  // to show a small in-page prompt; one click there runs the proven
  // footer-import flow.
  $("import").addEventListener("click", function () {
    withActiveTab(function (tabId) {
      sendToTab(tabId, { type: "rabg-open-import" }, function () {});
    });
  });

  function applyStoreTheme(store) {
    // "Auto" follows the scheme + live colors captured from the page. A
    // forced scheme (Dark/Black/Light) uses RA's exact built-in palette
    // only — no live refinements, so it can never look stale or mixed.
    var pref = store[POPUP_THEME_KEY];
    var forced = (pref === "dark" || pref === "black" || pref === "light")
      ? pref : null;
    var site = store["rabg-site-theme"];
    var scheme = store["rabg-scheme"] || (site && site.scheme);
    if (forced) applySiteTheme(null, forced);
    else applySiteTheme(site, scheme);
    // Diagnostic (hover the header): what the popup detected from the page.
    var sch = scheme || "not captured";
    var live = site && site.btnText ? "yes" : "no";
    var head = document.querySelector(".header");
    if (head) {
      head.title = "Site scheme: " + sch + " · live colors: " + live +
        (forced ? " · override: " + forced : "");
    }
  }

  getStore(function (store) {
    render(store);
    applyStoreTheme(store);
    refreshEditButton(); // after render so the checkbox state is current
  });

  // Follow site-theme changes made while the popup is open (e.g. the theme
  // was changed on the RA tab — the content script re-captures and writes
  // storage, and the popup re-themes here, live).
  (function () {
    var st = (typeof browser !== "undefined" && browser.storage) ||
             (typeof chrome !== "undefined" && chrome.storage);
    if (st && st.onChanged && st.onChanged.addListener) {
      st.onChanged.addListener(function (changes, area) {
        if (area && area !== "local") return;
        if (changes["rabg-site-theme"] || changes["rabg-scheme"] ||
            changes[POPUP_THEME_KEY]) {
          getStore(applyStoreTheme);
        }
      });
    }
  })();
})();
