'use strict';

// SemanticFirst-E2E TEST-local single-file assembler.
// It is intentionally confined to the exact TEST root and never writes production files.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const { BLOCKS } = require('../install-skill.js');
const ASSET_BLOCKS = BLOCKS.filter(b => b.name !== 'PIPELINE_CONTROLLER');

function normalized(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function sourcePath(rel) {
  const abs = path.resolve(ROOT, ...String(rel).split('/'));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error('BLOCK source escapes TEST root: ' + rel);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error('BLOCK source missing: ' + rel);
  }
  return abs;
}

function buildAssetBlock(block) {
  const content = normalized(fs.readFileSync(sourcePath(block.file), 'utf8')).trim();
  return '<!-- EMBED_ASSET:' + block.name + '_START -->\n```' + block.lang + '\n' + content + '\n```\n<!-- EMBED_ASSET:' + block.name + '_END -->';
}

function buildAssetList() {
  return '<!-- EMBED_ASSET_LIST -->\n```text\n' + BLOCKS.map(b => b.name).join('\n') + '\n```\n<!-- /EMBED_ASSET_LIST -->';
}

function syncR6aCssTemplate(content) {
  content = normalized(content);
  const marker = '### R6a-3 CSS';
  const idx = content.indexOf(marker);
  if (idx < 0) throw new Error('R6a-3 CSS template missing');
  const open = content.indexOf('```css', idx);
  if (open < 0) throw new Error('R6a-3 CSS opening fence missing');
  const bodyStart = open + '```css'.length;
  const close = content.indexOf('```', bodyStart);
  if (close < 0) throw new Error('R6a-3 CSS closing fence missing');
  const css = normalized(fs.readFileSync(sourcePath('assets/report.css'), 'utf8')).trim();
  return content.slice(0, bodyStart) + '\n' + css + '\n' + content.slice(close);
}

function rebuildAssetRegion(content) {
  const pcStart = '<!-- PIPELINE_CONTROLLER_' + 'START -->';
  const idx = content.indexOf(pcStart);
  if (idx < 0) throw new Error('PIPELINE_CONTROLLER_START missing');
  const head = content.slice(0, idx).replace(/^<!-- EMBED_ASSET:[A-Z0-9_]+_START -->[\s\S]*?^<!-- EMBED_ASSET:[A-Z0-9_]+_END -->\s*/gm, '');
  const blocks = ASSET_BLOCKS.map(buildAssetBlock).join('\n') + '\n\n';
  return head + blocks + content.slice(idx);
}

function syncPipelineController(content) {
  const startMarker = '<!-- PIPELINE_CONTROLLER_' + 'START -->';
  const endMarker = '<!-- PIPELINE_CONTROLLER_' + 'END -->';
  const start = content.indexOf(startMarker);
  const end = content.lastIndexOf(endMarker);
  if (start < 0 || end <= start) throw new Error('PIPELINE_CONTROLLER markers invalid');
  const src = normalized(fs.readFileSync(sourcePath('pipeline-controller.js'), 'utf8')).trim();
  const block = startMarker + '\n```javascript\n' + src + '\n```\n' + endMarker;
  return content.slice(0, start) + block + content.slice(end + endMarker.length);
}

function upsertAssetList(content) {
  const block = buildAssetList();
  const startMarker = '<!-- EMBED_ASSET_LIST -->';
  const endMarker = '<!-- /EMBED_ASSET_LIST -->';
  const start = content.lastIndexOf(startMarker);
  if (start < 0) return content.replace(/\n*$/, '') + '\n' + block + '\n';
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error('EMBED_ASSET_LIST closing marker missing');
  return content.slice(0, start) + block + content.slice(end + endMarker.length);
}

function renderSkill(content) {
  return upsertAssetList(syncPipelineController(rebuildAssetRegion(syncR6aCssTemplate(normalized(content)))));
}

function expectedSkill() {
  const skillPath = sourcePath('Skill-Judge.md');
  return renderSkill(fs.readFileSync(skillPath, 'utf8'));
}

function atomicWriteUtf8(target, text) {
  const tmp = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 12);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

function writeMirrors() {
  const skill = expectedSkill();
  atomicWriteUtf8(sourcePath('Skill-Judge.md'), skill);
  atomicWriteUtf8(sourcePath('Debate-Judge.md'), skill);
  return skill;
}

function checkMirrors() {
  const expected = expectedSkill();
  const skill = normalized(fs.readFileSync(sourcePath('Skill-Judge.md'), 'utf8'));
  const debate = normalized(fs.readFileSync(sourcePath('Debate-Judge.md'), 'utf8'));
  // expectedSkill() is idempotent: if Skill-Judge is fully synchronized, rendering it changes nothing.
  if (skill !== expected) throw new Error('Skill-Judge.md embedded assets are stale');
  if (debate !== skill) throw new Error('Debate-Judge.md is not an exact Skill-Judge.md mirror');
  return true;
}

function main() {
  if (process.argv.includes('--check')) {
    checkMirrors();
    console.log('TEST embed check: PASS');
    return;
  }
  writeMirrors();
  checkMirrors();
  console.log('TEST embedded assets synchronized: ' + BLOCKS.length + ' BLOCKS');
  console.log('TEST mirrors synchronized: Skill-Judge.md, Debate-Judge.md');
}

if (require.main === module) main();
module.exports = { ROOT, BLOCKS, renderSkill, expectedSkill, writeMirrors, checkMirrors };
