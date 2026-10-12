// Inline JS into the template -> dist/index.html (one file)
import fs from 'fs';
import { createHash } from 'crypto';
const r = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
let html = r('./src/template.html');
// Catch syntax slips before they reach the phone
for (const f of ['core.js', 'native.js', 'feeds.js', 'library.js', 'timer.js', 'audio.js', 'search.js', 'courses.js', 'marks.js', 'ai.js', 'app.js']) { try { new Function(r('./src/' + f)); } catch (e) { console.error('Syntax error in src/' + f + ': ' + e.message); process.exit(1); } }
html = html.replace('/*@CORE@*/', () => r('./src/core.js')).replace('/*@NATIVE@*/', () => r('./src/native.js')).replace('/*@FEEDS@*/', () => r('./src/feeds.js')).replace('/*@LIBRARY@*/', () => r('./src/library.js')).replace('/*@TIMER@*/', () => r('./src/timer.js')).replace('/*@AUDIO@*/', () => r('./src/audio.js')).replace('/*@SEARCH@*/', () => r('./src/search.js')).replace('/*@COURSES@*/', () => r('./src/courses.js')).replace('/*@MARKS@*/', () => r('./src/marks.js')).replace('/*@AI@*/', () => r('./src/ai.js')).replace('/*@APP@*/', () => r('./src/app.js'));
// A build mark (from the content, so an unchanged build keeps its mark) goes into the page and into build.txt next to
// it: the app on the phone compares the two when it comes back and reloads itself when the site has a newer build
const build = createHash('sha1').update(html).digest('hex').slice(0, 12);
html = html.replace('@BUILD@', build);
fs.mkdirSync(new URL('../', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../index.html', import.meta.url), html);
fs.writeFileSync(new URL('../build.txt', import.meta.url), build + '\n');
console.log('built index.html', (html.length / 1024).toFixed(1) + ' KB', 'build', build);
