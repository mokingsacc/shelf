var SHELF = 'https://mokingsacc.github.io/shelf/';
var until = 0;
function ask(op) {
  return new Promise(function (res) {
    chrome.runtime.sendMessage({ op: op }, function (r) { void chrome.runtime.lastError; res(r || {}); });
  });
}
function clock(t) { var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function show(r) {
  until = (r && r.bounceOffUntil) || 0;
  var off = until > Date.now();
  document.getElementById('state').textContent = off ? 'YouTube is open until ' + clock(until) : 'YouTube opens Shelf';
  document.getElementById('toggle').textContent = off ? 'Send YouTube to Shelf again' : 'Allow YouTube for 15 minutes';
}
document.getElementById('toggle').addEventListener('click', function () {
  ask(until > Date.now() ? 'back' : 'pass').then(show);
});
document.getElementById('open').addEventListener('click', function () {
  chrome.tabs.query({ url: SHELF + '*' }, function (tabs) {
    if (tabs && tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else chrome.tabs.create({ url: SHELF });
    window.close();
  });
});
ask('state').then(show);
