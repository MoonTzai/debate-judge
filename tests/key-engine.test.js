// 卡 5（260815 方案 v1.3）：键形双引擎合并——key-extract 单一引擎 + patchKeys 治理 + host-node 覆盖闭合
// KE-1~5 防漂移断言（引擎单一/字典过滤/patchKeys 治理/CONSUMER_MAP 稳定/host-node 覆盖/破坏性自检）
// 运行：node tests/key-engine.test.js（run-all 44 套件内注册）
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const gicSrc = fs.readFileSync(path.join(root, 'scripts', 'generate-input-contract.js'), 'utf-8');
const kcSrc = fs.readFileSync(path.join(root, 'scripts', 'key-checker.js'), 'utf-8');

// ---- KE-1: 单一引擎——gic/key-checker 均引用 key-extract，无独立正则；字典侧前缀过滤语义不变
check('KE-1 gic 引用 key-extract', gicSrc.includes("require('./key-extract.js')"));
check('KE-1 gic 无独立正则常量', !/const\s+re\d\s*=\s*\//.test(gicSrc), '独立正则仍在');
check('KE-1 key-checker 引用 key-extract', kcSrc.includes("require('./key-extract.js')"));
check('KE-1 key-checker 无独立正则形态', !/const\s+re\d\s*=\s*\//.test(kcSrc), '独立正则仍在');
let KE = {};
try { KE = require('../scripts/key-extract.js'); } catch (e) { KE = {}; }
check('KE-1 字典过滤: S 前缀入', typeof KE.dictKeyFilter === 'function' && KE.dictKeyFilter('S8.PhaseIII.压缩度'));
check('KE-1 字典过滤: R2.5 前缀入', typeof KE.dictKeyFilter === 'function' && KE.dictKeyFilter('R2.5.正方.Q1.对方对抗象限'));
check('KE-1 字典过滤: R3 拒入', typeof KE.dictKeyFilter === 'function' && !KE.dictKeyFilter('R3.某个键'));
check('KE-1 isKeyShape 宽语义（消费侧）', typeof KE.isKeyShape === 'function' && KE.isKeyShape('S1.辩题') && KE.isKeyShape('C7.微消化.总有效数'));

// ---- KE-2: patchKeys 治理——R2.5 8 键删除 + S2 8 键物化逐字锁定
const S2_KEYS = [
  'S2.正方.论证完成度.充分', 'S2.正方.论证完成度.初步', 'S2.正方.论证完成度.未论证', 'S2.正方.论证完成度.被击穿',
  'S2.反方.论证完成度.充分', 'S2.反方.论证完成度.初步', 'S2.反方.论证完成度.未论证', 'S2.反方.论证完成度.被击穿'
];
check('KE-2 gic 无 R2.5 patchKeys 条目', !/R2\.5\.(正方|反方)\.Q\d\.对方对抗象限/.test(gicSrc), 'R2.5 补丁仍在');
check('KE-2 gic patchKeys = 物化引用形态（无 S2/R2.5 字面量）', /const patchKeys = \[\s*\.\.\.KE\.s2CompletionKeys\(\)\s*\];/.test(gicSrc), 'patchKeys 字面量仍在');
const s2Materialized = (KE.s2CompletionKeys && KE.s2CompletionKeys()) || [];
check('KE-2 S2 8 键物化逐字锁定', JSON.stringify(s2Materialized) === JSON.stringify(S2_KEYS), 'got=' + s2Materialized.length);
const rrSrc = fs.readFileSync(path.join(root, 'render-report.js'), 'utf-8');
check('KE-2 物化源 = render L220 cats 逐字', rrSrc.includes("const cats = ['充分', '初步', '未论证', '被击穿']"));

// ---- KE-3: CONSUMER_MAP 条目数稳定（34）+ 消费声明真实性零报错
const gic = require('../scripts/generate-input-contract.js');
check('KE-3 CONSUMER_MAP 34 条', gic.CONSUMER_MAP.length === 34, 'n=' + gic.CONSUMER_MAP.length);
const claimsErr = gic.validateConsumerClaims();
check('KE-3 消费声明真实性零报错', claimsErr.length === 0, claimsErr.slice(0, 3).join('; '));

// ---- KE-4: M1——key-checker CONSUME_FILES 含 host-node + 前置探针（--strict EXIT 0：host-node 提取面 ⊆ 字典或豁免）
check('KE-4 CONSUME_FILES 含 host-node', /executor\/host-node\.js/.test(kcSrc));
{
  let strictOk = false, strictErr = '';
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'key-checker.js'), '--strict'], { stdio: 'pipe' }).toString();
    strictOk = out.includes('host-node.js');
    if (!strictOk) strictErr = '报告未含 host-node';
  } catch (e) {
    strictErr = '--strict 非零退出（host-node 提取面存在新 MISS——须登记 KNOWN_DRIFT 豁免）: ' + String(e.stdout || e.message).split('\n').slice(0, 6).join(' ');
  }
  check('KE-4 前置探针: host-node ⊆ 字典（--strict EXIT 0）', strictOk, strictErr);
}

// ---- KE-5: 破坏性自检——引擎提取假键（非豁免必红路径）+ key-checker --verify 自检全过
// Post-S5D S8 authority repair T0: dictionary-side extraction must see approved allData literal aliases,
// while dynamic allData expressions must not be mis-materialized as bogus literal keys.
const aliasSrc = "const a = allData['S8.COMPLETE']; const b = allData['S1.' + side + '人数'];";
const aliasKeys = KE.scanDictQuote ? KE.scanDictQuote(aliasSrc).map(x => x.key) : [];
check('KE-5a 字典侧识别 allData 字面量', aliasKeys.includes('S8.COMPLETE'), 'got=' + JSON.stringify(aliasKeys));
check('KE-5b allData 动态表达式不伪造字面键', !aliasKeys.some(k => k === 'S1.' || k.includes('+ side')), 'got=' + JSON.stringify(aliasKeys));
const fakeSrc = "const x = data['S99.探针.FAKE']; const y = data['S99.探针.FAKE2'];";
const fakeKeys = KE.extractLiteralKeys ? KE.extractLiteralKeys(fakeSrc) : [];
check('KE-5 引擎提取假键', Array.isArray(fakeKeys) && fakeKeys.includes('S99.探针.FAKE') && fakeKeys.includes('S99.探针.FAKE2'), 'got=' + JSON.stringify(fakeKeys));
{
  let verifyOk = true, verifyErr = '';
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'key-checker.js'), '--verify'], { stdio: 'pipe' });
  } catch (e) {
    verifyOk = false;
    verifyErr = String(e.stdout || e.message).split('\n').slice(-4).join(' ');
  }
  check('KE-5 key-checker --verify 自检全过（假键注入必红/噪声/豁免）', verifyOk, verifyErr);
}

console.log(failed === 0 ? '=== key-engine ALL PASS ===' : '=== key-engine FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
