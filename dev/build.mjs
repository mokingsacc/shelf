// Inline JS into the template -> dist/index.html (one file)
import fs from 'fs';
const r = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
let html = r('./src/template.html');
const qr = r('./src/qrcode.js').replace(/^\/\/.*$/gm, '').replace(/\n\s*\n/g, '\n');
html = html.replace('/*@QRCODE@*/', () => qr).replace('/*@CORE@*/', () => r('./src/core.js')).replace('/*@APP@*/', () => r('./src/app.js'));
fs.mkdirSync(new URL('../', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../index.html', import.meta.url), html);
console.log('built index.html', (html.length / 1024).toFixed(1) + ' KB');
