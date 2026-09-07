// slicing-contract.test.js — 切片加载机制契约（SECTION 主路径 + 标题回退兼容层 + 行首锚定）
// 260815 卡8：回退路径行首锚定（防命中内嵌代码文本→垃圾切片静默污染 LLM）；现状 null throw（L1661）回归实证。
// 前缀锚定（标题带「· 轮名」后缀，禁 $ 终结）；TEMP 临时副本注入（跑完清理）。
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const ROOT = path.join(__dirname, '..');
const SJ = fs.readFileSync(path.join(ROOT, 'Skill-Judge.md'), 'utf8');
const PC = require(path.join(ROOT, 'pipeline-controller.js'));

const { ROUNDS: CORE_ROUNDS, SECTION_ROUNDS } = require('../executor/core.js');  // 260816 切片契约单一源
const ROUNDS = [...new Set(CORE_ROUNDS.map(r => r.num))];
const TITLE_RE = /^## R[\d.]+[ab]? PROMPT/mg;

// SC-1：9 轮次主路径非空（SECTION 主路径回归）
{
  let allOk = true, errs = [];
  for (const r of ROUNDS) {
    try {
      const p = PC.loadRoundPrompt(r);
      if (!p || p.trim().length === 0) { allOk = false; errs.push(r + ' 空'); }
    } catch (e) { allOk = false; errs.push(r + ' 抛错: ' + e.message.slice(0, 40)); }
  }
  check('SC-1：9 轮次 loadRoundPrompt 非空（SECTION 主路径）', allOk, errs.join('; '));
}

// SC-2：9 组 SECTION 各恰 1 组 + 9 个行首标题各恰 1 次（前缀锚定，标题带「· 轮名」后缀）
{
  const secs = SECTION_ROUNDS;  // 260816 切片契约单一源（core.SECTION_ROUNDS）
  let secOk = true, secErrs = [];
  for (const r of secs) {
    const s = SJ.split('<!-- SECTION:' + r + '_START -->').length - 1;
    const e = SJ.split('<!-- SECTION:' + r + '_END -->').length - 1;
    if (s !== 1 || e !== 1) { secOk = false; secErrs.push(r + ' START=' + s + ' END=' + e); }
  }
  TITLE_RE.lastIndex = 0;
  const titles = SJ.match(TITLE_RE) || [];
  check('SC-2：9 组 SECTION 唯一 + 9 个行首标题（前缀锚定）',
    secOk && titles.length === 9, 'SECTION: ' + (secOk ? 'OK' : secErrs.join(';')) + ' 标题=' + titles.length);
}

// SC-3：注入必红——去 R2.5 SECTION（标题保留）→ 回退切片起点必须为行首标题（内嵌文本命中即 FAIL）
{
  const tmp = path.join(require('os').tmpdir(), 'sj-sc3-no-r25-section-' + process.pid + '.md');
  const noR25 = SJ
    .replace('<!-- SECTION:R2.5_START -->', '<!-- SECTION:R2.5_START_REMOVED -->')
    .replace('<!-- SECTION:R2.5_END -->', '<!-- SECTION:R2.5_END_REMOVED -->');
  fs.writeFileSync(tmp, noR25, 'utf8');
  const idx = PC.buildSectionIndex(tmp);
  fs.unlinkSync(tmp);
  const slice = idx['R2.5'];
  check('SC-3：去 SECTION 后回退切片起点为行首标题（垃圾前导杜绝）',
    slice !== null && slice.startsWith('## R2.5 PROMPT') && !slice.includes("';\n  else if"),
    slice ? JSON.stringify(slice.slice(0, 40)) : 'null');
}

// SC-4：双缺失（SECTION + 行首标题整行替换）→ null（L1661 throw 前提回归实证）
{
  const tmp = path.join(require('os').tmpdir(), 'sj-sc4-double-missing-' + process.pid + '.md');
  const noAll = SJ
    .replace('<!-- SECTION:R2.5_START -->', '<!-- SECTION:R2.5_START_REMOVED -->')
    .replace('<!-- SECTION:R2.5_END -->', '<!-- SECTION:R2.5_END_REMOVED -->')
    .replace(/^## R2\.5 PROMPT.*$/m, '## 无标题区（SC-4 测试注入）');
  fs.writeFileSync(tmp, noAll, 'utf8');
  const idx = PC.buildSectionIndex(tmp);
  fs.unlinkSync(tmp);
  check('SC-4：双缺失 → index["R2.5"]=null（消费处 L1661 将 throw）', idx['R2.5'] === null,
    'index="' + (idx['R2.5'] === null ? 'null' : String(idx['R2.5']).slice(0, 30)) + '"');
}

// SC-5：降级路径行首锚定——9 轮次全成功且切片起点为行首标题
{
  let allOk = true, errs = [];
  for (const r of ROUNDS) {
    try {
      const p = PC.loadRoundPromptFallback(r);
      if (!p || !/^## R[\d.]+[ab]? PROMPT/m.test(p.split('\n').find(l => /^## R[\d.]+[ab]? PROMPT/.test(l)) || '')) {
        allOk = false; errs.push(r + ' 起点异常');
      }
    } catch (e) { allOk = false; errs.push(r + ' 抛错: ' + e.message.slice(0, 40)); }
  }
  check('SC-5：降级路径 9 轮次成功且含行首标题起点', allOk, errs.join('; '));
}

console.log(failed === 0 ? '=== slicing-contract ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
