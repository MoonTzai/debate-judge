// 批 2（260812 结构修复）：CONSUMER_MAP 消费声明真实性校验 + renderC8Persona 渲染补全回归
// 运行：node tests/consumer-claims.test.js（run-all suite 33）
'use strict';
const fs = require('fs');
const path = require('path');
let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const root = path.join(__dirname, '..');
const GIC = require('../scripts/generate-input-contract.js');
const RR = require('../render-report.js');

// ---- 1) 当前 CONSUMER_MAP 全量通过（修订后 34 条无假声明） ----
const claims = GIC.validateConsumerClaims();
check('CC-1：修订后 CONSUMER_MAP 全量通过 validateConsumerClaims（0 条）', claims.length === 0, claims.join(' | ').slice(0, 300));

// ---- 2) 负例：键前缀在两文件均无引用 → 报「声明不实」 ----
const fakeMap1 = [{ re: /^ZZZ\.不存在键$/, consumer: ['validateP2_5'], required: true, default: null }];
const fakeErrors1 = GIC.validateConsumerClaims(fakeMap1);
check('CC-2：负例——键前缀无任何消费文件引用 → 声明不实', fakeErrors1.some(e => e.includes('ZZZ.不存在键') && e.includes('均无引用')), fakeErrors1.join(' | ').slice(0, 300));

// ---- 3) 负例：consumer 函数不存在 → 报「函数不存在」 ----
const fakeMap2 = [{ re: /^S1\.辩题$/, consumer: ['notARealFn'], required: true, default: null }];
const fakeErrors2 = GIC.validateConsumerClaims(fakeMap2);
check('CC-3：负例——consumer 函数不存在 → 报函数不存在', fakeErrors2.some(e => e.includes('notARealFn') && e.includes('不存在')), fakeErrors2.join(' | ').slice(0, 300));

// ---- 4) 正例：自由文本标签（'c6 表头/进度'）豁免不报错 ----
const fakeMap3 = [{ re: /^S7\.关键交锋数$/, consumer: ['c6 表头/进度'], required: false, default: '0' }];
const fakeErrors3 = GIC.validateConsumerClaims(fakeMap3);
check('CC-4：自由文本标签豁免（无函数名语义）', fakeErrors3.length === 0, fakeErrors3.join(' | ').slice(0, 200));

// ---- 5) 正例：点号消费者「函数.锚点」取首段查函数存在（renderHTML.title） ----
const fakeMap4 = [{ re: /^S1\.辩题$/, consumer: ['renderHTML.title'], required: true, default: '（辩题未提供）' }];
const fakeErrors4 = GIC.validateConsumerClaims(fakeMap4);
check('CC-5：点号消费者（函数.锚点）解析正确不误报', fakeErrors4.length === 0, fakeErrors4.join(' | ').slice(0, 200));

// ---- renderC8Persona ----
check('RC-1：无数据 → 空串', RR.renderC8Persona({}) === '');
const rc2 = RR.renderC8Persona({ 'C8.叙事人格.正方': '价值重构者|解读|CP-1', 'C8.人格胜负': '持平|理由' });
check('RC-2：正例——含姿态标签与胜负行', rc2.includes('<strong>价值重构者</strong>') && rc2.includes('<strong>持平</strong>') && rc2.includes('c8-persona'));
const rc3 = RR.renderC8Persona({ 'C8.叙事人格.反方': '立论者|<script>alert(1)</script>' });
check('RC-3：转义——<script> 被转义为 &lt;script&gt;', rc3.includes('&lt;script&gt;') && !rc3.includes('<script>'));
const rc4 = RR.renderC8Persona({ 'C8.人格胜负': '持平|理由' });
check('RC-4：仅胜负行（无双方标签）也渲染', rc4.includes('人格胜负') && !rc4.includes('<strong>价值重构者</strong>'));

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
