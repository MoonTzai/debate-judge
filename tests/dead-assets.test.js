// 卡12（260815）：死资产清理防回归（DA-1~11）
// 覆盖：registry.json 零引用 / clearPromptCache 死导出 / check-mechanisms 弃用链归零 /
//       同链 11 处对齐 / 步骤4+附录A 术语 / 单文件交付提取链 / 双兼容镜像与轻量壳
// 运行：node tests/dead-assets.test.js（并被 tests/run-all.js 收录）
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf-8').replace(/\r\n/g, '\n');
const sj = read('Skill-Judge.md');
const pc = read('pipeline-controller.js');
const lines = sj.split('\n');
const lineOf = (content, needle) => {
  const i = content.indexOf(needle);
  return i < 0 ? -1 : content.slice(0, i).split('\n').length + 1;
};

// 内容锚点分区（v1.4：不用固定行号——删旧代码区后行号漂移）
const pcMark = sj.indexOf('<!-- PIPELINE_CONTROLLER_START -->');
const beforeEmbed = sj.slice(0, pcMark);           // 内嵌块之前（正文+附录）
const step4Start = sj.indexOf('**步骤 4 ·');
const step5Start = sj.indexOf('**步骤 5 ·');
const step4Zone = sj.slice(step4Start, step5Start);
const appAStart = sj.indexOf('## 附录 A：管道控制协议');
const appBStart = sj.indexOf('## 附录 B：机械验证规则清单');
const appAZone = sj.slice(appAStart, appBStart);
const c3TplStart = sj.indexOf('C3 Phase I · 机制驱动渲染');
const c3TplEnd = sj.indexOf('C3叙事占位');
const c3Zone = sj.slice(c3TplStart, c3TplEnd);

// ---- DA-1：registry.json 零引用（当前根项目程序文件白名单） ----
const DA1_FILES = [
  'pipeline-controller.js', 'render-report.js', 'render-tables.js', 'install-skill.js',
  'executor/core.js', 'executor/host-node.js', 'executor/browser.js', 'executor/api-provider.js',
  'scripts/plain-language.js', 'scripts/html-contract.js', 'scripts/key-checker.js',
  'scripts/create-baseline.js', 'scripts/plain-audit.js', 'scripts/generate-input-contract.js',
  'Skill-Judge.md', 'Debate-Judge.md', '.claude/skills/debate-judge/SKILL.md'
];
const da1Hits = DA1_FILES.filter(f => fs.existsSync(path.join(root, f)) && read(f).includes('registry.json'));
check('DA-1：当前根项目程序文件白名单 grep registry.json 零命中', da1Hits.length === 0, da1Hits.join(','));

// ---- DA-2：导出不含 clearPromptCache ----
const PC = require('../pipeline-controller.js');
check('DA-2：module.exports 不含 clearPromptCache', !('clearPromptCache' in PC));

// ---- DA-3：源码不含 check-mechanisms ----
check('DA-3：pipeline-controller.js 不含 check-mechanisms', !pc.includes('check-mechanisms'));

// ---- DA-4：内嵌块之前不含死链词 ----
const da4Words = ['.tmp-mechanisms', 'check-mechanisms', 'M1-M8'];
const da4Hits = da4Words.filter(w => beforeEmbed.includes(w));
check('DA-4：内嵌块之前不含 .tmp-mechanisms/check-mechanisms/M1-M8', da4Hits.length === 0, da4Hits.join(','));

// ---- DA-5：步骤 4 区段含新验证指令 ----
check('DA-5：步骤 4 区段含 check-structure $OUTPUT_DIR/structure.json', step4Zone.includes('check-structure $OUTPUT_DIR/structure.json'));

// ---- DA-6：旧代码区头注释消除 + 自举标记提取 ----
const step0Start = sj.indexOf('**步骤 0 · 准备文件**');
const step0Zone = sj.slice(step0Start, step4Start);
check('DA-6a：内嵌块之前不含旧代码区头注释（// Debate-Judge V1.0 管道控制器）', !beforeEmbed.includes('// Debate-Judge V1.0 管道控制器'));
check('DA-6b：步骤 0 自举含 PIPELINE_CONTROLLER_ 标记提取（拆串形态，无完整标记字面量）', step0Zone.includes('PIPELINE_CONTROLLER_') && !step0Zone.includes('<!-- PIPELINE_CONTROLLER_START -->'));
check('DA-6c：步骤 0 自举不含旧正则（// Debate-Judge V1.0 管道控制器）', !step0Zone.includes('content.match(/// Debate-Judge V1.0 管道控制器'));

// ---- DA-7：pipeline-controller.js 不含 COMPAT 层 ----
check('DA-7：pipeline-controller.js 不含 COMPAT_MECHANISMS/.tmp-mechanisms', !pc.includes('COMPAT_MECHANISMS') && !pc.includes('.tmp-mechanisms'));

// ---- DA-8：R6a 模板区数据源对齐（structure.json mechanisms 字段，无 .tmp-mechanisms） ----
check('DA-8a：C3 模板区含 structure.json mechanisms 数组字段引用', c3Zone.includes('structure.json') && c3Zone.includes('mechanisms'));
check('DA-8b：C3 模板区不含 .tmp-mechanisms', !c3Zone.includes('.tmp-mechanisms'));

// ---- DA-9：步骤 4 + 附录 A 区段术语（含结构归约轮，不含机制聚合轮/机制提取/MECHANISM注释） ----
check('DA-9a：步骤 4 区段含「结构归约轮」', step4Zone.includes('结构归约轮'));
check('DA-9b：步骤 4 区段不含「机制聚合轮」', !step4Zone.includes('机制聚合轮'));
check('DA-9c：步骤 4 区段不含「机制提取」', !step4Zone.includes('机制提取'));
check('DA-9d：步骤 4 区段不含「MECHANISM注释」', !step4Zone.includes('MECHANISM注释'));
check('DA-9e：附录 A 区段含「结构归约」', appAZone.includes('结构归约'));
check('DA-9f：附录 A 区段不含「机制聚合」', !appAZone.includes('机制聚合'));

// ---- DA-9 扩展（260817 会话7 方案①）：全文件机制聚合零命中（现役三镜像作用域；豁免=空——
//      机制注释 L98 历史注记/机制卡片 L5100/机制驱动 L5022 均不含「机制聚合」字样——R6a 现役概念保留）----
check('DA-9g：全文件不含「机制聚合」（术语统一后零残留）', !sj.includes('机制聚合'), (sj.split('机制聚合').length - 1) + ' 处残留');
check('DA-9h：全文件不含「机制聚合轮」', !sj.includes('机制聚合轮'), (sj.split('机制聚合轮').length - 1) + ' 处残留');

// ---- DA-10：单文件交付提取链（标记正则提取 = 现役逐字一致 + node --check） ----
const re = /<!-- PIPELINE_CONTROLLER_START -->\s*```javascript\s*([\s\S]*?)\s*```\s*<!-- PIPELINE_CONTROLLER_END -->/;
const m = sj.match(re);
check('DA-10a：标记正则命中内嵌块', !!m);
if (m) {
  const ext = m[1].trim();
  check('DA-10b：提取与现役 pipeline-controller.js 逐字一致', ext === pc.trim(), ext.split('\n').length + ' 行');
  const tmp = path.join(require('os').tmpdir(), 'da10-' + Date.now() + '.js');
  fs.writeFileSync(tmp, ext);
  try { execFileSync(process.execPath, ['--check', tmp]); check('DA-10c：提取产物 node --check PASS', true); }
  catch (e) { check('DA-10c：提取产物 node --check PASS', false, String(e.message).split('\n')[0]); }
  fs.unlinkSync(tmp);
}

// ---- DA-11：根目录唯一主版本（三镜像逐字一致 + 单文件闭包标记存在） ----
const sha16 = c => require('crypto').createHash('sha256').update(c).digest('hex').slice(0, 16);
const m2f = read('Debate-Judge.md');
const m3f = read('.claude/skills/debate-judge/SKILL.md');
check('DA-11a：根三镜像逐字一致', sha16(sj) === sha16(m2f) && sha16(m2f) === sha16(m3f), sha16(sj));
check('DA-11b：根主版本含单文件内嵌闭包清单', sj.includes('<!-- EMBED_ASSET_LIST -->') && sj.includes('<!-- PIPELINE_CONTROLLER_START -->'));
check('DA-11c：根主版本不含死资产词', !/\.tmp-mechanisms|check-mechanisms|机制聚合轮/.test(sj));

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
