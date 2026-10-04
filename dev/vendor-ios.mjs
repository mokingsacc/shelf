// After `npx cap sync ios`: copy the Capacitor plugins' iOS sources into ios/vendor and point
// CapApp-SPM at them, so Xcode can build from the downloaded ZIP with no npm.
import fs from 'fs';
const root = new URL('../', import.meta.url).pathname;
const plugins = ['app', 'clipboard', 'preferences'];
for (const p of plugins) {
  const from = `${root}node_modules/@capacitor/${p}`, to = `${root}ios/vendor/${p}`;
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(`${from}/ios`, `${to}/ios`, { recursive: true });
  fs.rmSync(`${to}/ios/Tests`, { recursive: true, force: true });
  fs.copyFileSync(`${from}/LICENSE`, `${to}/LICENSE`);
  fs.writeFileSync(`${to}/Package.swift`, fs.readFileSync(`${from}/Package.swift`, 'utf8').replace(/,\s*\.testTarget\([\s\S]*?\)\s*\n/, '\n'));
}
const pkg = `${root}ios/App/CapApp-SPM/Package.swift`;
let s = fs.readFileSync(pkg, 'utf8').replace(/path: "\.\.\/\.\.\/\.\.\/node_modules\/@capacitor\/([a-z]+)"/g, 'path: "../../vendor/$1"')
  .replace('// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands', '// Plugins are vendored in ios/vendor so Xcode builds without npm. Regenerate with: node dev/vendor-ios.mjs (after npx cap sync)');
fs.writeFileSync(pkg, s);
// Shelf's own plugin (ios/App/App/ShelfSignIn.swift) isn't an npm package, so cap sync drops it from the class list
const cfg = `${root}ios/App/App/capacitor.config.json`, c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
c.packageClassList = c.packageClassList || [];
if (!c.packageClassList.includes('ShelfSignInPlugin')) { c.packageClassList.push('ShelfSignInPlugin'); fs.writeFileSync(cfg, JSON.stringify(c, null, '\t') + '\n'); }
console.log('vendored', plugins.join(', '), '+ ShelfSignInPlugin registered');
