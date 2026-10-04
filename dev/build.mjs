// Inline JS into the template -> dist/index.html (one file)
import fs from 'fs';
const r = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
let html = r('./src/template.html');
// Catch syntax slips before they reach the phone
for (const f of ['core.js', 'native.js', 'feeds.js', 'library.js', 'timer.js', 'app.js']) { try { new Function(r('./src/' + f)); } catch (e) { console.error('Syntax error in src/' + f + ': ' + e.message); process.exit(1); } }
const qr = r('./src/qrcode.js').replace(/^\/\/.*$/gm, '').replace(/\n\s*\n/g, '\n');
html = html.replace('/*@QRCODE@*/', () => qr).replace('/*@CORE@*/', () => r('./src/core.js')).replace('/*@NATIVE@*/', () => r('./src/native.js')).replace('/*@FEEDS@*/', () => r('./src/feeds.js')).replace('/*@LIBRARY@*/', () => r('./src/library.js')).replace('/*@TIMER@*/', () => r('./src/timer.js')).replace('/*@APP@*/', () => r('./src/app.js'));
fs.mkdirSync(new URL('../', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../index.html', import.meta.url), html);
console.log('built index.html', (html.length / 1024).toFixed(1) + ' KB');
