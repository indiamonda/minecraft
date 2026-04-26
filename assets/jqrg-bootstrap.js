/* jqrg-bootstrap.js
 * Wires the JimmyQrg cloud sync (jqrg-cloud.js) into the Minecraft web client.
 *
 * What this does:
 *   1. Once jqrg-cloud.js has loaded and the user is authenticated (either via the SSO
 *      hand-off `?sso=` param coming from the JimmyQrg home page, or by an existing token
 *      cached in localStorage), kick off cloud sync:
 *         a. If the user account already has IndexedDB save data on the server, restore
 *            it into the local `browserfs` database BEFORE BrowserFS has had a chance to
 *            mount and serve any worlds. (We rely on the fact that BrowserFS is loaded by
 *            the main app bundle injected at the bottom of <body>, while we run synchronously
 *            from <head>.)
 *         b. Register `autoSyncIdb(['browserfs'])` so further world edits get pushed back
 *            on visibility change / pagehide / beforeunload.
 *
 *   2. Show a small toast confirming "Saves restored from your account" or "World will sync
 *      to your account" so the user understands what's happening on first launch.
 *
 *   3. Strip the SSO token from the URL bar after it's been consumed (jqrg-cloud already does
 *      that; we just clean any leftover hash if present).
 *
 * Notes:
 *   - We use `<meta name="jqrg-cloud-namespace" content="mcraft">` so saves on the server are
 *     scoped to the `mcraft` bucket and don't collide with the main jimmyqrg.github.io site.
 *   - All data still belongs to the same user account — only the per-key bucket differs.
 *   - localStorage is intercepted automatically by jqrg-cloud, so Minecraft username, server
 *     list, keybindings, etc. are pushed/pulled with no extra wiring.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__JqrgMcraftBootstrapLoaded) return;
  window.__JqrgMcraftBootstrapLoaded = true;

  var TOAST_BG = 'rgba(20, 20, 22, 0.92)';
  var TOAST_BORDER = 'rgba(255,255,255,0.15)';

  function showToast(html, durationMs) {
    try {
      var existing = document.getElementById('jqrg-mcraft-toast');
      if (existing) existing.remove();
      var el = document.createElement('div');
      el.id = 'jqrg-mcraft-toast';
      el.innerHTML = html;
      el.style.cssText =
        'position:fixed;top:14px;left:50%;transform:translate(-50%,-12px);' +
        'z-index:99999999;pointer-events:none;max-width:min(560px,92vw);' +
        'background:' + TOAST_BG + ';color:#fff;border:1px solid ' + TOAST_BORDER + ';' +
        'border-radius:10px;padding:10px 16px;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,' +
        '"Segoe UI",Roboto,sans-serif;box-shadow:0 12px 36px rgba(0,0,0,0.45);' +
        'opacity:0;transition:transform .25s ease,opacity .25s ease;';
      var attach = function () { document.body.appendChild(el); };
      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
      requestAnimationFrame(function () {
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%,0)';
      });
      setTimeout(function () {
        el.style.opacity = '0';
        el.style.transform = 'translate(-50%,-12px)';
        setTimeout(function () { try { el.remove(); } catch (_) {} }, 300);
      }, durationMs || 4500);
    } catch (_) {}
  }

  /** Resolve once `JqrgCloud` is available on `window`. Times out after 8s — the script tag is
   *  loaded synchronously before the bundle, so this should resolve almost immediately. */
  function waitForCloud(timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var poll = function () {
        if (window.JqrgCloud) return resolve(window.JqrgCloud);
        if (Date.now() - start > (timeoutMs || 8000)) return resolve(null);
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  /** Resolve once an auth state exists (either cached or freshly bootstrapped via SSO). */
  function waitForAuth(Cloud, timeoutMs) {
    return new Promise(function (resolve) {
      if (Cloud.isLoggedIn()) return resolve(Cloud.getUser());
      var off = null;
      var done = function (user) {
        if (off) try { off(); } catch (_) {}
        resolve(user || null);
      };
      try {
        off = Cloud.onAuthChange(function (user) {
          if (user) done(user);
        });
      } catch (_) {}
      setTimeout(function () { done(Cloud.getUser()); }, timeoutMs || 4000);
    });
  }

  /** True if the local `browserfs` IndexedDB looks empty (no entries yet). */
  function isLocalIdbEmpty() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open('browserfs');
        req.onerror = function () { resolve(true); };
        req.onsuccess = function () {
          var db = req.result;
          if (!db.objectStoreNames || !db.objectStoreNames.length) { db.close(); return resolve(true); }
          try {
            var storeName = db.objectStoreNames[0];
            var tx = db.transaction(storeName, 'readonly');
            var store = tx.objectStore(storeName);
            var countReq = store.count();
            countReq.onsuccess = function () {
              try { db.close(); } catch (_) {}
              resolve(!countReq.result || countReq.result === 0);
            };
            countReq.onerror = function () { try { db.close(); } catch (_) {} resolve(true); };
          } catch (_) { try { db.close(); } catch (__) {} resolve(true); }
        };
      } catch (_) { resolve(true); }
    });
  }

  /** Pull mcraft IDB save from the server (key=browserfs, kind=idb:default) and tell us whether
   *  the server actually had any data. */
  function serverHasIdbSnapshot(Cloud) {
    if (!Cloud.fetchSave) return Promise.resolve(false);
    return Cloud.fetchSave('browserfs', 'idb:default')
      .then(function (data) { return !!(data && data.value && data.value.length > 2); })
      .catch(function () { return false; });
  }

  /** Cleanly remove our SSO query param after we've consumed it (jqrg-cloud already does this for
   *  the `sso` param, but if there was a hash too we leave it alone). */
  function cleanSsoUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (!params.has('sso') && !params.has('jqrg_just_signed_in')) return;
      params.delete('sso');
      params.delete('jqrg_just_signed_in');
      var q = params.toString();
      var url = window.location.pathname + (q ? '?' + q : '') + window.location.hash;
      window.history.replaceState({}, '', url);
    } catch (_) {}
  }

  function init() {
    waitForCloud().then(function (Cloud) {
      if (!Cloud) {
        // Cloud library failed to load; nothing else we can do.
        return;
      }
      waitForAuth(Cloud).then(function (user) {
        cleanSsoUrl();
        if (!user) {
          showToast(
            '<strong>Not signed in.</strong> Worlds will only be saved on this device. ' +
            'Sign in on the JimmyQrg home page to sync to your account.',
            6500
          );
          return;
        }

        // Background-sync on visibility hidden / pagehide so progress is captured. Snapshot
        // exists even on first run; the auto handler is cheap and idempotent.
        try { Cloud.autoSyncIdb(['browserfs']); } catch (_) {}

        // Decide whether we need to RESTORE the IDB from the server. We only do that when the
        // local browserfs DB is empty AND the server actually has a snapshot — otherwise we'd
        // either waste time or, worse, overwrite existing local progress.
        Promise.all([isLocalIdbEmpty(), serverHasIdbSnapshot(Cloud)]).then(function (results) {
          var localEmpty = results[0];
          var serverHasIt = results[1];
          if (!serverHasIt) {
            showToast(
              '<strong>Signed in as ' + (user.display_name || user.username || 'you') + '.</strong> ' +
              'Your worlds, server list and settings will sync to your account automatically.',
              5000
            );
            return;
          }
          if (!localEmpty) {
            // Server has a snapshot but the device already has worlds. Don't blow them away
            // — the autoSync upload + last-writer-wins on each key handles merging well enough
            // for the LS side. For IDB we trust the local state on this device.
            showToast(
              '<strong>Signed in.</strong> Cloud saves detected, but worlds on this device ' +
              'were kept. New progress will keep syncing across both.',
              5500
            );
            return;
          }
          // Empty local + server has snapshot → restore now.
          showToast('<strong>Restoring your saved worlds&hellip;</strong>', 12000);
          Cloud.restoreIdb(['browserfs']).then(function () {
            // BrowserFS may have already opened the DB before restore finished; refresh the
            // page so it re-reads the freshly populated stores. Use replace() to keep the
            // back button friendly.
            showToast('<strong>Worlds restored.</strong> Reloading to apply…', 2500);
            setTimeout(function () {
              try { window.location.replace(window.location.href); }
              catch (_) { window.location.reload(); }
            }, 700);
          }).catch(function () {
            showToast(
              '<strong>Could not restore cloud worlds.</strong> ' +
              'You can keep playing — new progress will still upload.',
              5500
            );
          });
        });
      });
    });
  }

  // Kick off as early as possible so we maximise the chance of restoring before BrowserFS opens.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
