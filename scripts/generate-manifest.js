'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const repo = path.resolve(__dirname, '..');
const manifestPath = path.join(repo, 'MANIFEST.sha256');

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(repo, abs).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      if (rel === 'web/dist') continue; // generated test intermediate; intentionally Git-ignored
      walk(abs, out);
    } else if (ent.isFile()) {
      if (rel === 'MANIFEST.sha256') continue;
      out.push(rel);
    }
  }
}
const files = [];
walk(repo, files);
files.sort((a,b)=>a.localeCompare(b, 'en'));
const lines = files.map(rel => sha256File(path.join(repo, ...rel.split('/'))) + '  ' + rel);
fs.writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf8');

const result = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  os_release: os.release(),
  entry_count: files.length,
  manifest_sha256: sha256File(manifestPath),
  manifest_bytes: fs.statSync(manifestPath).size,
  html_sha256: sha256File(path.join(repo, 'web', 'judge.html')),
  html_bytes: fs.statSync(path.join(repo, 'web', 'judge.html')).size,
  canonical_skill_sha256: sha256File(path.join(repo, 'Skill-Judge.md')),
  dist: files.filter(rel => rel.startsWith('web/dist/'))
};
console.log(JSON.stringify(result, null, 2));
