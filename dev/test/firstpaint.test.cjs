// The look Shelf paints before anything else runs (the head script in index.html): never light at night
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const src = html.match(/<script>\/\* The look before anything draws[\s\S]*?\*\/([\s\S]*?)<\/script>/)[1];
let n = 0;
function first(saved, at) {
  const attrs = {}, cls = [];
  const RealDate = Date, fixed = new RealDate(at).getTime();
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } }
  vm.runInNewContext(src, {
    Date: FakeDate, JSON,
    localStorage: { getItem: () => (saved ? JSON.stringify(saved) : null) },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add: (...c) => cls.push(...c) } } },
    matchMedia: () => ({ matches: false })
  });
  return attrs['data-theme'];
}
function ok(c, m) { assert.ok(c, m); n++; console.log('  PASS ' + m); }
const day = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
// Light 08:20–16:40 for two weeks from 21 Oct
const w = []; for (let i = 0; i < 14; i++) w.push([day(21 + i, 8, 20), day(21 + i, 16, 40)]);
const auto = { t: 'light', u: day(14, 16, 40), w };
ok(first(auto, day(21, 22)) === 'dark', 'auto, saved in the day a week ago, opened at night: dark');
ok(first(auto, day(23, 12)) === 'light', 'auto, opened at midday: light');
ok(first(auto, day(25, 6, 30)) === 'dark', 'auto, opened before dawn: dark');
ok(first(auto, day(25, 16, 50)) === 'dark', 'auto, opened just after the light hours: dark');
ok(first({ t: 'dark', u: day(21, 8, 20) }, day(23, 21)) === 'dark', 'old save without light hours, two days stale, opened at night: the clock says dark');
ok(first({ t: 'dark', u: day(21, 8, 20) }, day(21, 9)) === 'light', 'old save, its switch just passed: flips to light');
ok(first(null, day(21, 23)) === 'dark', 'nothing saved, opened at night: dark');
ok(first({ t: 'light', u: 0 }, day(21, 23)) === 'light', 'Light chosen by hand stays light');
ok(first({ t: 'dark', u: 0 }, day(21, 12)) === 'dark', 'Dark chosen by hand stays dark');
ok(first(auto, day(5 + 31, 22)) === 'dark', 'auto, light hours run out, opened at night: dark');
console.log(n + ' passed');
