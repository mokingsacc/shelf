// The extension's static files: the manifest, and rules.json (every regex has to be RE2, which Chrome uses: no look-around,
// no backreferences). Run: node dev/test/ext.test.cjs
const fs = require('fs'), path = require('path'), assert = require('assert');
const dir = path.join(__dirname, '../../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'));
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

ok(manifest.manifest_version === 3 && manifest.name === 'Shelf' && manifest.version === '1.0.0', 'manifest basics');
ok(['declarativeNetRequest', 'storage', 'alarms'].every((p) => manifest.permissions.includes(p)) && manifest.permissions.length === 3, 'permissions');
ok(manifest.host_permissions.join() === 'https://*/*', 'host permissions');
ok(manifest.background.service_worker === 'background.js', 'service worker');
const cs = manifest.content_scripts;
ok(cs.length === 1 && cs[0].matches.join() === 'https://mokingsacc.github.io/shelf/*' && cs[0].js.join() === 'bridge.js' && cs[0].run_at === 'document_start', 'content script on the Shelf page at document_start');
ok(manifest.action.default_popup === 'popup.html', 'popup');
const rr = manifest.declarative_net_request.rule_resources;
ok(rr.length === 1 && rr[0].id === 'bounce' && rr[0].enabled === true && rr[0].path === 'rules.json', 'ruleset bounce, enabled');
['background.js', 'bridge.js', 'popup.html', 'popup.js', 'rules.json', 'README.md', 'icon.png'].forEach((f) => ok(fs.existsSync(path.join(dir, f)), f + ' exists'));
ok(fs.readFileSync(path.join(dir, 'icon.png')).equals(fs.readFileSync(path.join(dir, '../icon.png'))), 'icon is the repo icon');
ok(manifest.icons && Object.values(manifest.icons).every((f) => fs.existsSync(path.join(dir, f))) && fs.existsSync(path.join(dir, manifest.action.default_icon)), 'icons referenced exist');

// Rules
ok(rules.length === 3 && new Set(rules.map((r) => r.id)).size === 3, 'three rules with their own ids');
rules.forEach((r) => ok(r.condition.resourceTypes.join() === 'main_frame', 'rule ' + r.id + ' only touches main_frame (the embedded player is a sub frame)'));
const [allow, bounce, other] = rules;
ok(allow.priority === 3 && allow.action.type === 'allow' && bounce.priority === 2 && bounce.action.type === 'redirect' && other.priority === 1 && other.action.type === 'redirect', 'priorities 3 allow, 2 redirect, 1 redirect');
const re2Bad = (src) => {
  if (/\(\?[=!]|\(\?<[=!]/.test(src)) return 'look-around';
  if (/\\[1-9]/.test(src)) return 'backreference';
  if (/\(\?<[A-Za-z]/.test(src) || /\(\?P?</.test(src)) return 'named group (kept out for safety)';
  if (/\(\?>|\(\?#|\\[GKXzZ]/.test(src)) return 'unsupported construct';
  if (/(\*|\+|\?|\})\+/.test(src)) return 'possessive quantifier';
  return '';
};
rules.forEach((r) => { const f = r.condition.regexFilter; if (f) { const bad = re2Bad(f); ok(!bad, 'rule ' + r.id + ' regexFilter is RE2-compatible (' + bad + ')'); new RegExp(f); ok(true, 'compiles'); } });
// Chrome's limit on a regex rule's size is 2 KB of compiled program; these are short
rules.forEach((r) => ok(!r.condition.regexFilter || r.condition.regexFilter.length < 300, 'rule ' + r.id + ' regex is short'));

// What the rules do, tested with JS's regex on the same patterns (simple enough to behave the same in RE2)
const hits = (r, u) => new RegExp(r.condition.regexFilter).test(u);
const watch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42';
ok(hits(bounce, watch) && hits(bounce, 'https://m.youtube.com/watch?v=dQw4w9WgXcQ') && hits(bounce, 'https://youtube.com/watch?v=dQw4w9WgXcQ'), 'watch links of www, m and bare youtube.com go to Shelf');
ok(hits(bounce, 'https://www.youtube.com/playlist?list=PLabc') && hits(bounce, 'https://youtu.be/dQw4w9WgXcQ?t=5'), 'playlist and youtu.be links go to Shelf');
ok(!hits(bounce, 'https://www.youtube.com/') && !hits(bounce, 'https://www.youtube.com/shorts/abc') && !hits(bounce, 'https://www.youtube.com/results?search_query=x'), 'other pages are not the watch rule (they take the root rule)');
ok(bounce.action.redirect.regexSubstitution === 'https://mokingsacc.github.io/shelf/#open=\\0', 'the whole original URL goes after #open=');
ok(hits(allow, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&shelf=pass') && hits(allow, 'https://www.youtube.com/?shelf=pass') && hits(allow, 'https://www.youtube.com/signin?action_handle_signin=true'), 'the pass marker and YouTube sign-in are let through');
ok(!hits(allow, watch) && !hits(allow, 'https://www.youtube.com/') && !hits(allow, 'https://www.youtube.com/watch?v=x&notshelf=passed'), 'a plain YouTube link is not let through');
ok(!hits(allow, 'https://evil.example/?shelf=pass') && !hits(allow, 'https://notyoutube.com/?shelf=pass'), 'the pass marker only counts on YouTube');
['accounts.youtube.com', 'consent.youtube.com', 'music.youtube.com', 'studio.youtube.com', 'tv.youtube.com'].forEach((d) => ok(bounce.condition.excludedRequestDomains.includes(d) && other.condition.excludedRequestDomains.includes(d), d + ' is left alone'));
ok(other.condition.requestDomains.join() === 'www.youtube.com,m.youtube.com,youtube.com' && other.action.redirect.url === 'https://mokingsacc.github.io/shelf/', 'everything else on youtube goes to the Shelf root');

// background.js: its pure rules, taken from the file
const bg = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
ok(/BAD_HEADER = \/\^\(cookie\|cookie2\|user-agent\|origin\|referer\|host\|sec-\.\*\|proxy-\.\*\)\$\/i/.test(bg), 'blocked header names');
ok(/credentials: isYouTube\(u\) && method === 'GET' \? 'include' : 'omit'/.test(bg) && /cache: 'no-store'/.test(bg), 'credentials only for reads of YouTube, never cached');
console.log('extension: all ' + n + ' checks passed');
