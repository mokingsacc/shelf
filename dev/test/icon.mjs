import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 180, height: 180 } });
await p.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" fill="#0c0c10"/><rect width="180" height="80" fill="#ffe41a"/><rect y="80" width="180" height="50" fill="#1a35d6"/><rect y="76" width="180" height="6" fill="#0c0c10"/><rect y="128" width="180" height="6" fill="#0c0c10"/><path d="M34 22 L74 41 L34 60 Z" fill="#0c0c10"/><rect x="34" y="150" width="112" height="6" fill="#ffffff" opacity=".3"/><rect x="34" y="150" width="64" height="6" fill="#ffffff"/></svg></body>`);
await p.screenshot({ path: new URL('../../icon.png', import.meta.url).pathname, clip: { x: 0, y: 0, width: 180, height: 180 } });
await b.close(); console.log('icon done');
