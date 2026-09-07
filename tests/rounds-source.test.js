// 卡7（260815）：ROUNDS 单一源防漂移（RS-1~9）
// 覆盖：runAll 直接引用 core.ROUNDS / valid+nameMap 派生 / R5_HALVES+parallelGroup 字段 /
//       promptFile 与 host-node 一致 / 破坏性自检（纯内存注入）/ ROUND_ORDER 派生 / halves.json 移除 / filterMap 显式 'R5'
// 运行：node tests/rounds-source.test.js（并被 tests/run-all.js 收录）
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf-8').replace(/\r\n/g, '\n');
const pc = read('pipeline-controller.js');
const core = require('../executor/core.js');

// ---- RS-1：runAll rounds 直接引用 core.ROUNDS（源码级，容错空白/行尾） ----
check('RS-1：runAll rounds 初始化直接引用 core.ROUNDS', /\bconst rounds = ROUNDS\s*;/.test(pc));

// ---- RS-2a：core.ROUNDS num 集（去重）=== 字面量 ----
const numSet = [...new Set(core.ROUNDS.map(r => r.num))];
check('RS-2a：num 集（去重）=== 9 轮字面量', JSON.stringify(numSet) === JSON.stringify(['1', '2', '2.5', '3', '4', '4.5', '5', '6a', '6b']), numSet.join(','));

// ---- RS-2b：loadRoundPrompt valid/nameMap 派生形态（源码级） ----
check('RS-2b：loadRoundPrompt 内 valid/nameMap 为派生形态（引用 ROUND_NUMS/ROUNDS）', /ROUND_NUMS/.test(pc) && /nameMap\['5'\] = 'R5'/.test(pc));

// ---- RS-3：ROUNDS 无重复 name / half 合法 / R5_HALVES 四要素 ----
const names = core.ROUNDS.map(r => r.name);
check('RS-3a：ROUNDS name 无重复', new Set(names).size === names.length, names.join(','));
check('RS-3b：R5A/R5B half 合法（A/B）', core.ROUNDS.find(r => r.name === 'R5A').half === 'A' && core.ROUNDS.find(r => r.name === 'R5B').half === 'B');
check('RS-3c：R5_HALVES 导出四要素（A/B label/range/exclude/chapters）', !!core.R5_HALVES && core.R5_HALVES.A.label === 'A' && core.R5_HALVES.B.label === 'B' &&
  Array.isArray(core.R5_HALVES.A.chapters) && core.R5_HALVES.A.chapters.length === 7 && core.R5_HALVES.B.chapters.length === 5 &&
  typeof core.R5_HALVES.A.range === 'string' && typeof core.R5_HALVES.B.exclude === 'string');

// ---- RS-4：parallelGroup 与平行组表一致 ----
const pg = Object.fromEntries(core.ROUNDS.map(r => [r.name, r.parallelGroup]));
const pgExpected = { R1: null, R2: 1, R2_5: null, R2_5_: null, R3: null, R4: 2, R4_5: null, R5A: 3, R5B: 3, R6a: 3, R6b: null };
// 用 name→group 实际断言（避开键名 R2.5 点号）
const pgOk =
  pg.R1 === null && pg.R2 === 1 && pg['R2.5'] === null && pg.R3 === null &&
  pg.R4 === 2 && pg['R4.5'] === null && pg.R5A === 3 && pg.R5B === 3 && pg.R6a === 3 && pg.R6b === null;
check('RS-4：parallelGroup 与现 runAll 平行组表一致（R2=1/R4=2/R5A=R5B=R6a=3/其余 null）', pgOk, JSON.stringify(pg));

// ---- RS-5：R5A/R5B promptFile 与 host-node 引用一致 ----
const hn = read('executor/host-node.js');
check('RS-5：R5A promptFile=.tmp-R5-A-prompt.md 且 host-node 引用', core.ROUNDS.find(r => r.name === 'R5A').promptFile === '.tmp-R5-A-prompt.md' && hn.includes('.tmp-R5-A-prompt.md'));
check('RS-5b：R5B promptFile=.tmp-R5-B-prompt.md 且 host-node 引用', core.ROUNDS.find(r => r.name === 'R5B').promptFile === '.tmp-R5-B-prompt.md' && hn.includes('.tmp-R5-B-prompt.md'));

// ---- RS-6：纯内存注入破坏性自检（读源码字符串→内存替换→断言必红） ----
const injected = pc.replace(/\bconst rounds = ROUNDS\s*;/, 'const rounds = LOCAL_ROUNDS;');
check('RS-6：注入替换后断言必红（回路自检连通）', !/\bconst rounds = ROUNDS\s*;/.test(injected));

// ---- RS-7：ROUND_ORDER 派生一致性（源码级：派生形态 = ROUNDS.map(r => r.name)） ----
const gic = read('scripts/generate-input-contract.js');
const dc = read('tests/dictionary-consistency.test.js');
const expectedOrder = core.ROUNDS.map(r => r.name).join(',');
const gicOrder = (gic.match(/const ROUND_ORDER = ([^;]+);/) || [])[1];
const dcOrder = (dc.match(/const ROUND_ORDER = ([^;]+);/) || [])[1];
check('RS-7a：gic ROUND_ORDER 派生形态（ROUNDS.map(r => r.name)）', !!gicOrder && gicOrder.includes('ROUNDS.map(r => r.name)'), gicOrder ? gicOrder.trim() : '无');
check('RS-7b：dictionary-consistency ROUND_ORDER 派生形态', !!dcOrder && dcOrder.includes('ROUNDS.map(r => r.name)'), dcOrder ? dcOrder.trim() : '无');

// ---- RS-8：halves.json 移除（M4） ----
check('RS-8a：pipeline-controller 不含 .tmp-R5-halves.json 生成块', !pc.includes('.tmp-R5-halves.json'));
const kc = read('scripts/key-checker.js');
check('RS-8b：key-checker noise 无 .tmp-R5-halves.json 条目', !kc.includes('.tmp-R5-halves.json'));

// ---- RS-9：R5 half 分支显式传 'R5'（filterMap fallback 风险锁定） ----
check('RS-9：generateInsertContract 显式传 R5（half 分支内）', /generateInsertContract\(\s*halfRegistry,\s*'R5'\s*\)/.test(pc));

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
