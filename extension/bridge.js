// Runs on the Shelf page. Marks the page, then carries the page's questions to the extension and back.
(function () {
  var version = '';
  try { version = chrome.runtime.getManifest().version; } catch (e) {}
  // At document_start the page's root element may not exist yet: mark it the moment it does (before any page script runs)
  function mark() {
    if (!document.documentElement) return false;
    document.documentElement.setAttribute('data-shelf-ext', version || '1');
    return true;
  }
  if (!mark()) {
    var wait = new MutationObserver(function () { if (mark()) wait.disconnect(); });
    wait.observe(document, { childList: true });
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== window || !m || m.shelfExt !== 'ask') return;
    var reply = function (o) { o.shelfExt = 'answer'; o.id = m.id; window.postMessage(o, location.origin); };
    try {
      chrome.runtime.sendMessage({ op: m.op, args: m.args }, function (r) {
        var err = chrome.runtime.lastError;
        if (err) return reply({ error: err.message || 'The Shelf extension is not answering.' });
        if (r && r.error) return reply({ error: r.error });
        reply({ r: r });
      });
    } catch (x) {
      // The extension was reloaded or removed: this page's copy of the bridge is orphaned
      reply({ error: 'The Shelf extension was reloaded. Reload this page.' });
    }
  });
})();
