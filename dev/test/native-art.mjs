// App icon (1024) and launch image (2732) for the iPhone shell
import { chromium } from 'playwright';
const root = new URL('../../ios/App/App/Assets.xcassets/', import.meta.url).pathname;
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 180 180"><rect width="180" height="180" fill="#2B4C9B"/><path d="M72 52 L124 86 L72 120 Z" fill="#FBFBF9" stroke="#FBFBF9" stroke-width="8" stroke-linejoin="round"/><rect x="36" y="140" width="108" height="7" rx="3.5" fill="#FBFBF9" opacity=".35"/><rect x="36" y="140" width="66" height="7" rx="3.5" fill="#FBFBF9"/></svg>`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
await p.setContent(`<body style="margin:0">${svg(1024)}</body>`);
await p.screenshot({ path: root + 'AppIcon.appiconset/AppIcon-512@2x.png', clip: { x: 0, y: 0, width: 1024, height: 1024 }, omitBackground: false });
p = await b.newPage({ viewport: { width: 2732, height: 2732 } });
await p.setContent(`<body style="margin:0;width:2732px;height:2732px;background:#F4F3EF;display:grid;place-items:center"><div style="width:300px;height:300px;border-radius:66px;overflow:hidden">${svg(300)}</div></body>`);
for (const n of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) await p.screenshot({ path: root + 'Splash.imageset/' + n });
await b.close(); console.log('native art done');
