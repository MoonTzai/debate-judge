// validator-coverage.test.js — D-19 覆盖缺口补测（2026-08-16 用户批准执行）
// 覆盖附录 B 无显式断言的 17 条：F1/V3/V4/V5/P1/P2/C2/C3/C5/C6/C8/C9b/C9c/C10a/C10b/C11a/C11b
// 含 V4 繁体双键读取修复回归（2026-08-16 批准修正：触发看双键、读取简繁双键）
// 运行：node tests/validator-coverage.test.js
'use strict';

const assert = require('assert');
const { test } = require('node:test');

let validator = null;
try { validator = require('../executor/validator.js'); } catch (e) { validator = null; }

const DIMENSION_S7_SC = 'S7赢家↔SC完成方';

// 最小 md：单 S 步骤 + DATA 标记（F2 数量对称满足；F3 轮次预期不满足属预期噪音，断言只看目标 rule）
const md = (keys, step = 'S1') => {
  const lines = [`[S_START=${step}]`, '### 结论', '样本内容'];
  for (const [k, v] of Object.entries(keys)) lines.push(`<!--DATA: ${k}=${v} -->`);
  lines.push(`[S_END=${step}]`);
  return lines.join('\n');
};

const rules = (res) => [...res.blocking, ...res.warnings, ...(res.infos || [])].map(e => e.rule);
const has = (res, rule) => rules(res).includes(rule);

test('CV-1 F1：R3 轮末行非 [FILE_END] → BLOCKING', () => {
  assert.ok(validator, 'validator.js 不可加载');
  const res = validator.validate(md({ 'S9.COMPLETE': '是' }, 'S9'), 'R3');
  assert.ok(has(res, 'F1'), 'F1 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-2 V3：已结晶但完成方=字面"无" → BLOCKING', () => {
  const res = validator.validate(md({
    'S8.COMPLETE': '是', 'S8.PhaseIII.状态': '已结晶', 'S8.PhaseIII.完成方': '无'
  }, 'S8'), 'R2');
  assert.ok(has(res, 'V3'), 'V3 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-3 V4：通过数+不通过数≠总数 → WARNING', () => {
  const res = validator.validate(md({
    'S10.1.通过数': '3', 'S10.1.总数': '10', 'S10.1.不通过项号': 'a1_b1|a1_b2'
  }, 'S10.1'), 'R3');
  assert.ok(has(res, 'V4'), 'V4 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-4 V4 繁体回归（批准修正）：仅繁体键输出不误报', () => {
  const res = validator.validate(md({
    'S10.1.通過数': '8', 'S10.1.总数': '10', 'S10.1.不通过项号': 'a1_b1|a1_b2'
  }, 'S10.1'), 'R3');
  assert.ok(!has(res, 'V4'), 'V4 误报（繁体 8+2=10 应通过）: ' + JSON.stringify(rules(res)));
});

test('CV-5 V5：数值负数 → BLOCKING', () => {
  const res = validator.validate(md({ 'S3.交锋点总数': '-1' }), 'R1');
  assert.ok(has(res, 'V5'), 'V5 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-6 P1：PhaseI=否决但 PhaseII 有效数>0 → BLOCKING', () => {
  const res = validator.validate(md({
    'S8.COMPLETE': '是', 'S8.PhaseI.正方': '否决', 'S8.PhaseII.正方.有效数': '1'
  }, 'S8'), 'R2');
  assert.ok(has(res, 'P1'), 'P1 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-6b P1：缺 S8.COMPLETE 也不得绕过实质矛盾', () => {
  const res = validator.validate(md({
    'S8.PhaseI.正方': '否决', 'S8.PhaseII.正方.有效数': '1'
  }, 'S8'), 'R2');
  assert.ok(has(res, 'P1'), '缺 S8.COMPLETE 时 P1 被绕过: ' + JSON.stringify(rules(res)));
});

test('CV-7 P2：PhaseIII 已结晶但完成方 PhaseII 有效数=0 → BLOCKING', () => {
  const res = validator.validate(md({
    'S8.COMPLETE': '是', 'S8.PhaseI.正方': '完成', 'S8.PhaseII.正方.有效数': '0',
    'S8.PhaseIII.状态': '已结晶', 'S8.PhaseIII.完成方': '正方', 'S8.PhaseIII.压缩度': '1'
  }, 'S8'), 'R2');
  assert.ok(has(res, 'P2'), 'P2 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-7b P2：缺 S8.COMPLETE 也不得绕过实质矛盾', () => {
  const res = validator.validate(md({
    'S8.PhaseI.正方': '完成', 'S8.PhaseII.正方.有效数': '0',
    'S8.PhaseIII.状态': '已结晶', 'S8.PhaseIII.完成方': '正方', 'S8.PhaseIII.压缩度': '1'
  }, 'S8'), 'R2');
  assert.ok(has(res, 'P2'), '缺 S8.COMPLETE 时 P2 被绕过: ' + JSON.stringify(rules(res)));
});

test('CV-7c S8C-L1：缺 S8.COMPLETE 也必须执行完成度硬一致性', () => {
  const res = validator.validate(md({
    'S8.SC完成度': '完成', 'S8.PhaseIII.状态': '未结晶',
    'S8.PhaseII.正方.有效数': '1', 'S8.PhaseII.反方.有效数': '0',
    'S8.SC完成度.判据': 'PhaseII已有推进但PhaseIII尚未结晶'
  }, 'S8'), 'R2');
  assert.ok(has(res, 'S8C-L1'), '缺 S8.COMPLETE 时 S8C-L1 被绕过: ' + JSON.stringify(rules(res)));
});

test('CV-7d legacy/incomplete：缺顶层标记本身不新增 P1/P2/S8C-L1 伪阻断', () => {
  const res = validator.validate(md({
    'S8.第一层完成': '是', 'S8.第二层完成': '是', 'S8.碰撞终判': '真碰撞'
  }, 'S8'), 'R2');
  assert.ok(!has(res, 'P1') && !has(res, 'P2') && !has(res, 'S8C-L1'),
    'legacy/incomplete 被实质门禁误判: ' + JSON.stringify(rules(res)));
});

test('CV-8 C2：SC容量预判≠低 且 包着打=成立 → WARNING（final）', () => {
  const res = validator.validate(md({
    'S2.正方.SC容量预判': '高', 'S4.包着打.正方': '成立'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C2'), 'C2 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-9 C3：假价值 + S11=1型 → WARNING（final）', () => {
  const res = validator.validate(md({
    'S5.正方.真假价值': '假', 'S5.反方.真假价值': '真', 'S11.类型': '1a'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C3'), 'C3 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-10 C5：S7 推进=0 但 S8 有效>0 → WARNING（final）', () => {
  const res = validator.validate(md({
    'S7.SC角色.推进节点数': '0', 'S8.PhaseII.正方.有效数': '1'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C5'), 'C5 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-11 C6：完成方≠S14.SC完成方 → WARNING（final）', () => {
  const res = validator.validate(md({
    'S8.SC完成度': '完成', 'S8.PhaseIII.状态': '已结晶', 'S8.PhaseIII.完成方': '正方',
    'S14.SC完成方': '反方'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C6'), 'C6 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-12 C8：预判=无向 但 SC 实际有完成方 → WARNING（final）', () => {
  const res = validator.validate(md({
    'S2.预判SC方向': '无向', 'S8.PhaseIII.完成方': '正方'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C8'), 'C8 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-13 C9b：④(d) 有未覆盖项 → BLOCKING（final）', () => {
  const res = validator.validate(md({
    'S8.PhaseIII.状态': '已结晶', 'S8.PhaseIII.完成方': '正方',
    'S7.反方赢.致命': '2', 'S8.PhaseIII.④致命交锋复核': '已执行·有未覆盖项',
    'S8.PhaseIII.④致命交锋复核.未覆盖数': '1'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C9b'), 'C9b 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-14 C9c：S7_SC 维度经 R4.5 裁决 → C9 阻断豁免 + 标注（final）', () => {
  const res = validator.validate(md({
    'S8.PhaseIII.状态': '已结晶', 'S8.PhaseIII.完成方': '正方',
    'S7.反方赢.致命': '2'
  }), 'R3', {
    final: true,
    adjudicatedDims: [DIMENSION_S7_SC],
    adjudicatedDimsInfo: [{ dimension: DIMENSION_S7_SC, adjudicated: 'reject', pair: ['S7.反方赢.致命=2', 'S7.正方赢.致命=0'] }]
  });
  assert.ok(has(res, 'C9c'), 'C9c 未触发: ' + JSON.stringify(rules(res)));
  assert.ok(!has(res, 'C9a') && !has(res, 'C9b'), 'C9a/C9b 应被豁免: ' + JSON.stringify(rules(res)));
});

test('CV-15 C10a：④(e) 检查未执行 → WARNING（final）', () => {
  const res = validator.validate(md({ 'S8.PhaseIII.④外延漂移.检查完成': '否' }), 'R3', { final: true });
  assert.ok(has(res, 'C10a'), 'C10a 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-16 C10b：漂移信号含"偷换外延" → BLOCKING（final）', () => {
  const res = validator.validate(md({
    'S8.PhaseIII.④外延漂移.检查完成': '是',
    'S8.PhaseIII.④外延漂移信号': '有(1项)',
    'S8.PhaseIII.④外延漂移.合理性': 'M-ZH-1:偷换外延'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C10b'), 'C10b 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-17 C11a：③=语义承接 + 1型 + 闭合=封口 → WARNING（final）', () => {
  const res = validator.validate(md({
    'S8.PhaseIII.③显性程度': '语义承接', 'S11.类型': '1a', 'S11.闭合': '封口'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C11a'), 'C11a 未触发: ' + JSON.stringify(rules(res)));
});

test('CV-18 C11b：质量诊断≥2类 但降权未确认 → WARNING（final）', () => {
  const res = validator.validate(md({
    'S8.7.质量诊断触发': '是(≥2类)', 'S9.感性.质量降权已执行': '否'
  }), 'R3', { final: true });
  assert.ok(has(res, 'C11b'), 'C11b 未触发: ' + JSON.stringify(rules(res)));
});
