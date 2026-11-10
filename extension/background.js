// Shelf extension: reads other sites for the Shelf page, and sends YouTube to Shelf.
var PASS_MS = 15 * 60 * 1000;

// Patterns turn into regular expressions ("https://host/path/*"), from the manifest only
function patternToRegExp(p) {
  return new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}
function fromShelfPage(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.url) return false;
  var m = chrome.runtime.getManifest().content_scripts[0].matches;
  return m.some(function (p) { return patternToRegExp(p).test(sender.url); });
}

var BAD_HEADER = /^(cookie|cookie2|user-agent|origin|referer|host|sec-.*|proxy-.*)$/i;
function allowedUrl(s) {
  var u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u;
  return null;
}
function isYouTube(u) { return u.hostname === 'youtube.com' || /\.youtube\.com$/.test(u.hostname); }

function doFetch(a) {
  a = a || {};
  var u = allowedUrl(a.url);
  if (!u) return Promise.reject(new Error('That address is not allowed.'));
  var method = String(a.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return Promise.reject(new Error('That method is not allowed.'));
  var headers = {};
  Object.keys(a.headers || {}).forEach(function (k) { if (!BAD_HEADER.test(k)) headers[k] = String(a.headers[k]); });
  // Only a read of YouTube goes out as the browser's signed-in account; a POST never carries its cookies
  var opts = { method: method, headers: headers, credentials: isYouTube(u) && method === 'GET' ? 'include' : 'omit', cache: 'no-store' };
  if (method === 'POST' && a.body != null) opts.body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
  return fetch(u.href, opts).then(function (r) {
    return r.text().then(function (t) { return { status: r.status, ok: r.ok, text: t, url: r.url }; });
  });
}

// The YouTube redirect, off for a while
function setBounce(on) {
  return chrome.declarativeNetRequest.updateEnabledRulesets(on ? { enableRulesetIds: ['bounce'] } : { disableRulesetIds: ['bounce'] });
}
function pass() {
  var until = Date.now() + PASS_MS;
  return chrome.storage.local.set({ bounceOffUntil: until }).then(function () {
    chrome.alarms.create('bounce-on', { when: until });
    return setBounce(false);
  }).then(function () { return { bounceOffUntil: until }; });
}
function back() {
  return chrome.storage.local.set({ bounceOffUntil: 0 }).then(function () { chrome.alarms.clear('bounce-on'); return setBounce(true); }).then(function () { return { bounceOffUntil: 0 }; });
}
function state() {
  return chrome.storage.local.get('bounceOffUntil').then(function (o) { var t = o.bounceOffUntil || 0; return { bounceOffUntil: t > Date.now() ? t : 0 }; });
}
// Turns the redirect back on when the time has passed (and off again if the browser forgot it mid-pass)
function settle() {
  return chrome.storage.local.get('bounceOffUntil').then(function (o) {
    var t = o.bounceOffUntil || 0;
    if (t > Date.now()) { chrome.alarms.create('bounce-on', { when: t }); return setBounce(false); }
    return setBounce(true);
  });
}
// Shelf's own reads of YouTube go out the way the phone app's do, without an Origin header: YouTube answers a plain
// request, but its "load more" may refuse one that names an extension as where it comes from
function plainReads() {
  var doms = ['youtube.com'];
  if ((chrome.runtime.getManifest().host_permissions || []).some(function (h) { return /^http:\/\/localhost\//.test(h); })) doms.push('localhost'); // the test's copy
  return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [100], addRules: [{ id: 100, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: { initiatorDomains: [chrome.runtime.id], requestDomains: doms, resourceTypes: ['xmlhttprequest'] } }] }).catch(function () {});
}
function wake() { plainReads(); return settle(); }
chrome.alarms.onAlarm.addListener(function (a) { if (a.name === 'bounce-on') settle(); });
chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(wake);

chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  var fromPopup = sender && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  var fromPage = fromShelfPage(sender);
  if (!msg || (!fromPage && !fromPopup)) return false;
  var job;
  if (msg.op === 'fetch' && fromPage) job = doFetch(msg.args);
  else if (msg.op === 'pass') job = pass();
  else if (msg.op === 'back') job = back();
  else if (msg.op === 'state') job = state();
  else return false;
  job.then(send, function (e) { send({ error: String((e && e.message) || e) }); });
  return true;
});
