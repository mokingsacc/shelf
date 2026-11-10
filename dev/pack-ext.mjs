// Writes shelf-extension.zip at the repo root from extension/ (the zip holds one "shelf-extension" folder)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const root = path.resolve(new URL('../', import.meta.url).pathname);
const out = path.join(root, 'shelf-extension.zip');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ext-'));
fs.cpSync(path.join(root, 'extension'), path.join(tmp, 'shelf-extension'), { recursive: true });
fs.rmSync(out, { force: true });
let haveZip = true;
try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch (e) { haveZip = false; }
if (haveZip) execFileSync('zip', ['-r', '-q', '-X', out, 'shelf-extension'], { cwd: tmp });
else execFileSync('python3', ['-I', '-c', 'import sys, os, zipfile\nz = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)\nfor d, _, fs in os.walk("shelf-extension"):\n    for f in sorted(fs): z.write(os.path.join(d, f))\nz.close()', out], { cwd: tmp });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote shelf-extension.zip', (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
