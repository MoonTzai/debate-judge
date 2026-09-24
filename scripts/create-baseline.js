#!/usr/bin/env node
// 批 3（260812 结构修复）：基准包创建/校验标准脚本——清单驱动 + 相对路径条目 + 自校验
// 用法：
//   node scripts/create-baseline.js --out <name>.zip  创建基准包（默认 audit-baseline-<ts>.zip）
//   node scripts/create-baseline.js --check            校验最新基准包与工作区同步（不一致 → 退出码 1）
// 设计要点（审计实证）：
//   - 排除式收集（与 260812-GH 包 96 文件清单一致；未来新增文件自动入包）
//   - 条目路径为相对路径（./ 前缀），用 PowerShell .NET ZipArchive 逐条写入——
//     规避 PS5.1 Compress-Archive 对绝对路径通配的「平铺」行为（260812 实测返工教训）
//   - 自校验：创建后解压到系统 TEMP 抽验关键文件 SHA256 与工作区一致
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const EXCLUDE_TOPS = ['Output', 'backup', 'audit-baseline', 'work-omega1-extracted', 'docs', 'benchmark'];
const EXCLUDE_FILE = f => f.startsWith('.tmp-') || f.endsWith('.zip');
// 自校验抽验清单（关键文件：代码/契约/测试/资产）
const PROBE_FILES = [
  'executor/host-node.js', 'pipeline-controller.js', 'render-report.js',
  'schemas/input-contract.json', 'tests/pipeline-run.test.js',
  'tests/fixtures/report-035350.html', 'assets/charts-constants.js'
];

function collectFiles() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split('\\').join('/');
      if (ent.isDirectory()) {
        if (EXCLUDE_TOPS.includes(ent.name)) continue;
        walk(full);
      } else {
        if (EXCLUDE_FILE(ent.name)) continue;
        out.push({ rel, full });
      }
    }
  };
  // 白名单顶层（目录全部递归；根文件逐个加入）
  const TOP_DIRS = ['.claude', 'assets', 'executor', 'fixtures', 'golden', 'schemas', 'scripts', 'tests'];
  const TOP_FILES = ['Debate-Judge.md', 'Skill-Judge.md', 'install-skill.js', 'pipeline-controller.js', 'render-report.js', 'render-tables.js', 'AGENTS.md', 'CLAUDE.md'];
  for (const t of TOP_DIRS) {
    const p = path.join(root, t);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) walk(p);
  }
  for (const f of TOP_FILES) {
    const p = path.join(root, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ rel: f, full: p });
  }
  return out;
}

function sha256(p) {
  try {
    return execSync(`certutil -hashfile "${p}" SHA256`).toString().split('\n')[1].trim();
  } catch (e) {
    return 'ERR';
  }
}

function writeZip(files, dest) {
  // PowerShell .NET ZipArchive 逐条写入（相对路径条目；manifest 经临时文件传递防命令行过长/中文转义）
  const manifest = path.join(os.tmpdir(), 'opencode', 'bl-manifest-' + Date.now() + '.txt');
  const script = path.join(os.tmpdir(), 'opencode', 'bl-zip.ps1');
  fs.writeFileSync(manifest, files.map(f => f.full + '\t' + './' + f.rel).join('\n'), 'utf-8');
  const ps = [
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$manifest = '" + manifest + "'",
    "$dest = '" + dest + "'",
    "$zip = [System.IO.Compression.ZipFile]::Open($dest, [System.IO.Compression.ZipArchiveMode]::Create)",
    "try {",
    "  Get-Content $manifest -Encoding UTF8 | ForEach-Object {",
    "    $parts = $_ -split \"`t\", 2",
    "    $full = $parts[0]; $rel = $parts[1]",
    "    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)",
    "    $es = $entry.Open()",
    "    try {",
    "      $bytes = [System.IO.File]::ReadAllBytes($full)",
    "      $es.Write($bytes, 0, $bytes.Length)",
    "    } finally { $es.Close() }",
    "  }",
    "} finally { $zip.Dispose() }",
    "Write-Output 'ZIP_OK'"
  ].join('\n');
  fs.writeFileSync(script, ps, 'utf-8');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`, { encoding: 'utf-8' });
  } finally {
    try { fs.unlinkSync(manifest); } catch (e) {}
    try { fs.unlinkSync(script); } catch (e) {}
  }
}

function latestBaseline() {
  const zips = fs.readdirSync(root)
    .filter(f => /^audit-baseline-.*\.zip$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(root, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);   // 按 mtime 选最新（名称序会选错 260812.zip vs -GH.zip）
  return zips.length ? zips[0].f : null;
}

function checkSync(zipArg) {
  const zipName = zipArg || latestBaseline();
  if (!zipName) {
    console.error('CHECK FAIL: 无基准包（先 node scripts/create-baseline.js 创建）');
    process.exit(1);
  }
  const zipPath = path.isAbsolute(zipName) ? zipName : path.join(root, zipName);
  if (!fs.existsSync(zipPath)) {
    console.error('CHECK FAIL: 基准包不存在: ' + zipPath);
    process.exit(1);
  }
  // 解包到 TEMP，逐文件比对（仅比对包内文件；新增文件不使包过时——防误报）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-check-'));
  try {
    execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force"`);
    const diffs = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        const rel = path.relative(tmp, full).split('\\').join('/');
        const cur = path.join(root, rel);
        if (!fs.existsSync(cur)) { diffs.push(rel + '（包内有、工作区缺失）'); continue; }
        if (sha256(full) !== sha256(cur)) diffs.push(rel);
      }
    };
    walk(tmp);
    if (diffs.length) {
      console.error('CHECK FAIL: 基准包 ' + zipName + ' 与工作区不同步（' + diffs.length + ' 文件）——先 node scripts/create-baseline.js 重建：');
      for (const d of diffs) console.error('  - ' + d);
      process.exit(1);
    }
    console.log('CHECK PASS: 基准包 ' + zipName + ' 与工作区同步（零差异）');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

function createBaseline(outName) {
  const files = collectFiles();
  const dest = path.isAbsolute(outName) ? outName : path.join(root, outName);
  if (fs.existsSync(dest)) { console.error('已存在: ' + outName); process.exit(1); }
  writeZip(files, dest);
  // 自校验：解包抽验 PROBE_FILES 哈希
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-verify-'));
  try {
    execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${dest}' -DestinationPath '${tmp}' -Force"`);
    const bad = [];
    for (const rel of PROBE_FILES) {
      const a = sha256(path.join(tmp, rel));
      const b = sha256(path.join(root, rel));
      if (a !== b) bad.push(rel + '(' + a.slice(0, 8) + '≠' + b.slice(0, 8) + ')');
    }
    if (bad.length) {
      console.error('CREATE FAIL: 自校验不一致: ' + bad.join(', '));
      try { fs.unlinkSync(dest); } catch (e) {}
      process.exit(1);
    }
    console.log('CREATE OK: ' + outName + '（' + files.length + ' 文件，抽验 ' + PROBE_FILES.length + ' 项 ALL SAME）');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

const args = process.argv.slice(2);
if (require.main === module) {
  const outIdx = args.indexOf('--out');
  const zipIdx = args.indexOf('--zip');
  if (args.includes('--check')) {
    checkSync(zipIdx >= 0 && args[zipIdx + 1] ? args[zipIdx + 1] : null);
  } else if (outIdx >= 0 && args[outIdx + 1]) {
    const name = args[outIdx + 1];
    if (!/^audit-baseline-[A-Za-z0-9._-]+\.zip$/.test(name)) { console.error('非法包名: ' + name); process.exit(1); }
    createBaseline(name);
  } else {
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    createBaseline('audit-baseline-' + ts + '.zip');
  }
}

module.exports = { collectFiles, checkSync, createBaseline, latestBaseline };
