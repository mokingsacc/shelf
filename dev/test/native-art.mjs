// App icon (1024) and launch image (2732) for the iPhone shell
import { chromium } from 'playwright';
const root = new URL('../../ios/App/App/Assets.xcassets/', import.meta.url).pathname;
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 180 180"><rect width="180" height="180" fill="#0c0c10"/><rect width="180" height="80" fill="#ffe41a"/><rect y="80" width="180" height="50" fill="#1a35d6"/><rect y="76" width="180" height="6" fill="#0c0c10"/><rect y="128" width="180" height="6" fill="#0c0c10"/><path d="M34 22 L74 41 L34 60 Z" fill="#0c0c10"/><rect x="34" y="150" width="112" height="6" fill="#ffffff" opacity=".3"/><rect x="34" y="150" width="64" height="6" fill="#ffffff"/></svg>`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
await p.setContent(`<body style="margin:0">${svg(1024)}</body>`);
await p.screenshot({ path: root + 'AppIcon.appiconset/AppIcon-512@2x.png', clip: { x: 0, y: 0, width: 1024, height: 1024 }, omitBackground: false });
p = await b.newPage({ viewport: { width: 2732, height: 2732 } });
await p.setContent(`<body style="margin:0;width:2732px;height:2732px;background:#ffffff;display:grid;place-items:center"><div style="width:300px;height:300px;overflow:hidden">${svg(300)}</div></body>`);
for (const n of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) await p.screenshot({ path: root + 'Splash.imageset/' + n });
await b.close(); console.log('native art done');
