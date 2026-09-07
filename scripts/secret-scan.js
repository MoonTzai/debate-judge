// secret-scan.js —— 上传前密钥扫描门禁（260806）
// 用法：node scripts/secret-scan.js [根目录]（默认 Debate-Judge 根）
// 命中真实密钥模式或敏感文件 → 打印打码位置并以非零退出；占位符（REPLACE_ME 等）不拦截。
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const skipDirs = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);
const skipExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.7z', '.exe', '.dll', '.pyc']);
const pats = [
  { n: 'sk- API Key', re: /sk-[A-Za-z0-9_\-]{16,}/ },
  { n: 'GitHub PAT', re: /ghp_[A-Za-z0-9]{20,}/ },
  { n: '厂商 API_KEY 值', re: /(?:OPENAI|ANTHROPIC|DEEPSEEK|MOONSHOT|ZHIPU|QIANFAN|GITHUB)_API_KEY\s*=\s*["'][^"']{16,}["']/i },
  { n: 'GITHUB_TOKEN 值', re: /GITHUB_TOKEN\s*=\s*["'][^"']{10,}["']/ },
  { n: '_AUTH_TOKEN 值（260813 补）', re: /_AUTH_TOKEN\s*[:=]\s*["'][^"']{16,}["']/i },
  { n: 'api_key 长值赋值', re: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][A-Za-z0-9_\-\.]{24,}["']/i },
  { n: 'Bearer 长 token', re: /Bearer\s+[A-Za-z0-9._\-]{20,}/i }
];
const isPlaceholder = v => /^((sk|ghp)_)?(REPLACE_ME|PUT_?[A-Z_]*_?HERE|xxx+|change_?me|example|your[_-]?(api[_-]?)?key)$/i.test(v.trim());
const sensitiveFile = /(^|\.)(api-config\.json|auth\.json|env|env\.local|env\.prod|key|pem)$/i;

function walk(dir, out) {
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) {
    if (skipDirs.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

let hits = 0;
const files = walk(root, []);
for (const f of files) {
  const base = path.basename(f);
  if (skipExt.has(path.extname(f).toLowerCase())) continue;
  if (sensitiveFile.test(base)) {
    console.log('[敏感文件] ' + f.replace(root + path.sep, ''));
    hits++;
    continue;
  }
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  for (const p of pats) {
    const m = txt.match(p.re);
    if (!m) continue;
    // 占位符放行
    const val = m[0].replace(/^[^"']*["']/, '').replace(/["']$/, '');
    if (isPlaceholder(val)) continue;
    hits++;
    const idx = m.index;
    const line = txt.slice(Math.max(0, idx - 30), idx + 60).replace(/\r?\n/g, ' ');
    console.log('[命中 ' + p.n + '] ' + f.replace(root + path.sep, '') + ' :: ' + line.replace(p.re, '[REDACTED]'));
    break;
  }
}

console.log(hits ? 'FAIL：发现 ' + hits + ' 处密钥风险' : 'PASS：未发现密钥风险（' + files.length + ' 个文件）');
process.exit(hits ? 1 : 0);
