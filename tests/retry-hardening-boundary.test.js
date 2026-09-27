'use strict';

const assert = require('assert');
const SCA = require('../executor/sc-semantic-authority.js');
const V = require('../executor/validator.js');
const P = require('../scripts/plain-comprehension.js');
const H = require('../executor/host-node.js');

const current = {
  revision: 7,
  authority: {
    sides: {
      affirmative: { phase_iii: 'formed', candidates: [{ id: 'A1' }, { id: 'A2' }] },
      negative: { phase_iii: 'formed', candidates: [{ id: 'N1' }] }
    },
    relation: { type: 'mutual_partial', dominant_side: 'none', reason: 'fixture', evidence: [] }
  }
};

const body = [
  '<!--SC_AUTHORITY_BINDING revision=1 affirmative=not_formed negative=not_formed relation=none dominant=none -->',
  '<!--SC_AUTHORITY_BINDING revision=2 affirmative=formed negative=formed relation=parallel_independent dominant=none -->',
  '[S_START=S8]',
  '<!--DATA: S8.PhaseII.正方.有效数=2 -->',
  '<!--DATA: S8.PhaseII.反方.有效数=1 -->',
  '<!--DATA: S8.PhaseIII.状态=已结晶 -->',
  '<!--DATA: S8.PhaseIII.完成方=双方 -->',
  '<!--DATA: S8.PhaseIII.⑥双方SC关系=相互部分容纳 -->',
  '<!--DATA: S8.SC完成度=完成 -->',
  '<!--DATA: S8.S11类型方向=1型 -->',
  '[S_END=S8]'
].join('\n');

const canonical = SCA.injectCanonicalBinding(body, current);
assert.strictEqual((canonical.match(/<!--SC_AUTHORITY_BINDING/g) || []).length, 1);
assert.ok(canonical.startsWith('<!--SC_AUTHORITY_BINDING revision=7 affirmative=formed negative=formed relation=mutual_partial dominant=none -->'));
assert.strictEqual(SCA.checkR2Projection(canonical, current).ok, true);

const badProjection = canonical.replace('S8.PhaseII.反方.有效数=1', 'S8.PhaseII.反方.有效数=2');
const bad = SCA.checkR2Projection(badProjection, current);
assert.strictEqual(bad.ok, false);
assert.strictEqual(bad.issues[0].rule, 'V10-SC-PROJECTION');
assert.strictEqual(bad.issues[0].repairMode, 'bounded_repair');

const authorityPrompt = SCA.buildAuthorityBlock(current);
assert.ok(!authorityPrompt.includes('<!--SC_AUTHORITY_BINDING'));

assert.deepStrictEqual(P.factIdentities('第2轮推进'), P.factIdentities('第二轮推进'));
assert.deepStrictEqual(P.factIdentities('比分4:6'), P.factIdentities('比分四比六'));
assert.deepStrictEqual(P.factIdentities('Lv4 已知答案的重构'), P.factIdentities('第4级 已知答案的重构'));
assert.notDeepStrictEqual(P.factIdentities('比分4:6'), P.factIdentities('比分6:4'));
assert.notDeepStrictEqual(P.factIdentities('CP-4'), P.factIdentities('CP-5'));

const local = V.toTypedIssue({ rule: 'A1', severity: 'BLOCKING', message: 'missing block' });
assert.strictEqual(local.failureClass, 'representation_local');
assert.strictEqual(local.repairMode, 'bounded_repair');
assert.strictEqual(local.retryable, true);

const authorityIssue = V.toTypedIssue({
  rule: 'AUTH',
  severity: 'BLOCKING',
  authorityClass: 'authority_integrity',
  message: 'bad authority'
});
assert.strictEqual(authorityIssue.failureClass, 'authority_integrity');
assert.strictEqual(authorityIssue.owner, 'host');
assert.strictEqual(authorityIssue.repairMode, 'fail_closed');
assert.strictEqual(authorityIssue.retryable, false);

const r5Draft = [
  '## C1',
  '<!--XP:C1-->',
  '<!--INSERT_C1_01_POEM-->',
  'old-c1',
  '',
  '## C2',
  '<!--XP:C2-->',
  '<!--INSERT_C2_03_ANALYSIS-->',
  'old-c2',
  '',
  '## C3',
  '<!--XP:C3-->',
  'old-c3'
].join('\n');
const r5Issues = [
  V.toTypedIssue({ rule: 'A1', severity: 'BLOCKING', repairScope: 'C2:C2_03_ANALYSIS', message: 'missing C2 block' })
];
const repairPlan = H.roundRepairPlan({ name: 'R5A' }, { typedIssues: r5Issues });
assert.strictEqual(repairPlan.mode, 'r5_bounded');
assert.deepStrictEqual(repairPlan.chapters, ['C2']);
const repairedMap = H.parseR5BoundedRepair(JSON.stringify({
  chapters: [{ chapter: 'C2', markdown: '## C2\n<!--XP:C2-->\n<!--INSERT_C2_03_ANALYSIS-->\nnew-c2' }]
}), ['C2']);
const r5Merged = H.mergeR5BoundedRepair(r5Draft, repairedMap, ['C2']);
assert.ok(r5Merged.includes('new-c2'));
assert.ok(r5Merged.includes('old-c1'));
assert.ok(r5Merged.includes('old-c3'));
assert.ok(!r5Merged.includes('old-c2'));

console.log('PASS retry hardening representation boundary contract');
