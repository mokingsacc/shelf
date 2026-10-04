import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 180, height: 180 } });
await p.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">
<rect width="180" height="180" fill="#2B4C9B"/>
<path d="M72 52 L124 86 L72 120 Z" fill="#FBFBF9" stroke="#FBFBF9" stroke-width="8" stroke-linejoin="round"/>
<rect x="36" y="140" width="108" height="7" rx="3.5" fill="#FBFBF9" opacity=".35"/>
<rect x="36" y="140" width="66" height="7" rx="3.5" fill="#FBFBF9"/></svg></body>`);
await p.screenshot({ path: new URL('../../icon.png', import.meta.url).pathname, clip: { x: 0, y: 0, width: 180, height: 180 } });
await b.close(); console.log('icon done');
