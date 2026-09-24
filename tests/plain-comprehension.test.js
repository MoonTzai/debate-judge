'use strict';

// PLAIN v4：机械硬门与独立语义 reviewer 的职责边界。
const PC = require('../scripts/plain-comprehension.js');
const dict = require('../assets/plain-dict.json');

let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};
const codes = result => (result.issues || []).map(issue => issue.code);

// M1：机械层只判断机器能证明的硬不变量；可理解性不再由局部 regex 冒充。
{
  const orig = '双方四个象限均被锁定，胜负须看哪方完成更高层收束。';
  const pseudoPlain = '双方四个象限都被锁定，胜负要看哪一方完成更高层汇总。';
  const r = PC.inspectPlainText(orig, pseudoPlain, { profile: PC.PROFILE_GUIDE });
  check('V4-M1 同义词式伪白话不再由 text-node regex hard gate 判死', r.ok && r.issues.length === 0, JSON.stringify(r));
}

{
  const orig = '技术完成度抵销其微弱优势。';
  const awkward = '技术完成度（结构性交锋是否真正形成统一结论的语义判定（场感语义，非机械字段组合））抵销了这点微弱优势。';
  const r = PC.inspectPlainText(orig, awkward, { profile: PC.PROFILE_BODY });
  check('V4-M2 不自然/黑箱表达交给 reviewer，不再产生 opaque/density hard issue',
    r.ok && !codes(r).includes('opaque-concept') && !codes(r).includes('density'), JSON.stringify(r));
}

// M3：数字/比分/ID multiset 仍必须 fail-close。
{
  const orig = '依据 M-FA-2，比分 4:6，完成 2 次回应。';
  const bad = PC.inspectPlainText(orig, '依据 M-FA-3，比分 4:6，完成 2 次回应。', { profile: PC.PROFILE_BODY });
  const good = PC.inspectPlainText(orig, '依据 M-FA-2，比分 4:6，已经完成 2 次回应。', { profile: PC.PROFILE_BODY });
  check('V4-M3 protected token 漂移仍由机械 hard gate 阻断',
    !bad.ok && codes(bad).includes('protected-token-drift') && good.ok,
    JSON.stringify({ bad, good }));
}

// M4：内部编号可以只是 locator；是否依赖 locator 才能理解由 reviewer 判断。
{
  const orig = '事件已经在前句说明。M-FA-1/M-FA-2 仅作定位。';
  const same = PC.inspectPlainText(orig, orig, { profile: PC.PROFILE_BODY });
  check('V4-M4 locator 本身不触发 internal-marker hard gate', same.ok && !codes(same).includes('internal-marker'), JSON.stringify(same));
}

// G1：术语表只有一个事实源，CONCEPTS 必须从 assets/plain-dict.json 派生。
{
  const conceptMap = new Map(PC.CONCEPTS.map(item => [item.term, item.explanation]));
  const allMatch = Object.entries(dict).every(([term, explanation]) => conceptMap.get(term) === explanation) &&
    PC.CONCEPTS.length === Object.keys(dict).length;
  check('V4-G1 core glossary 单一事实源', allMatch, 'concepts=' + PC.CONCEPTS.length + ' dict=' + Object.keys(dict).length);
}

// G2：glossary 只是 cognition hint，不再是 fixed reader-visible template。
{
  const units = [{ id: 'u1', text: '六向度用于汇总裁判观察。', module: 'C9', blockType: 'paragraph' }];
  const reqs = PC.requirementsForUnits(units, { profile: PC.PROFILE_BODY });
  const fixed = PC.applyControlledConceptGlosses(units[0].text, '六向度就是从几个不同角度汇总双方表现。', { profile: PC.PROFILE_BODY });
  check('V4-G2 glossary requirement 是 hint 且机械补全 seam 为 no-op',
    reqs.length === 1 && reqs[0].requirements[0].mode === 'glossary-hint' &&
      fixed.changed.length === 0 && fixed.text === '六向度就是从几个不同角度汇总双方表现。',
    JSON.stringify({ reqs, fixed }));
}

// R1-R4：独立 reviewer API 与完整 coverage fail-close。
{
  const apiReady = typeof PC.buildReadabilityReviewPrompt === 'function' &&
    typeof PC.validateReadabilityReview === 'function' &&
    typeof PC.buildReadabilityRepairPrompt === 'function' &&
    typeof PC.failedReviewIds === 'function';
  check('V3-R1 独立可理解性 review/repair API 必须存在', apiReady);

  const units = [
    { id: 'u-a', text: '接收两个让步后重新定位为人的选择，并用类比完成反转。', module: 'C7', blockType: 'paragraph', containerTag: 'div', path: ['div.c7','p.1'] },
    { id: 'u-b', text: 'M-FA-1/M-FA-2 · 郭宇宽·盘问小结', module: 'C7', blockType: 'paragraph', containerTag: 'div', path: ['div.c7','p.2'] },
    { id: 'u-c', text: '后句继续说明这两个定位对应的判断如何影响结论。', module: 'C7', blockType: 'paragraph', containerTag: 'div', path: ['div.c7','p.3'] }
  ];
  const plainById = new Map(units.map(unit => [unit.id, unit.text]));
  const prompt = PC.buildReadabilityReviewPrompt(units, id => plainById.get(id), dict, { targetIds: units.map(unit => unit.id) });
  check('V3-R2 reviewer 必须看到有序邻文，locator 不再被孤立成自解释单元',
    prompt.indexOf('接收两个让步后重新定位') < prompt.indexOf('M-FA-1/M-FA-2') &&
      prompt.indexOf('M-FA-1/M-FA-2') < prompt.indexOf('后句继续说明') &&
      /不要求.*逐个解释|定位码.*理解|locator/.test(prompt),
    prompt.slice(0, 1100));

  const missingCoverage = PC.validateReadabilityReview({ approved: true, checkedIds: ['u-a','u-b'], issues: [] }, ['u-a','u-b','u-c']);
  check('V3-R3 review 少审一个 id 必须机械 fail-close', !missingCoverage.ok && !missingCoverage.valid, JSON.stringify(missingCoverage));

  const validReview = PC.validateReadabilityReview({ approved: true, checkedIds: ['u-a','u-b','u-c'], issues: [] }, ['u-a','u-b','u-c']);
  check('V3-R4 完整 coverage 且无 issue 才可批准', validReview.ok && validReview.valid, JSON.stringify(validReview));

  const semanticFail = {
    approved: false,
    checkedIds: ['u-a','u-b','u-c'],
    issues: [{ id: 'u-b', codes: ['naturalReadable','noLocatorDependency'], message: '该行单独像内部索引；需要结合已给出的邻文自然说明它只是定位。' }]
  };
  const semanticValidation = PC.validateReadabilityReview(semanticFail, ['u-a','u-b','u-c']);
  check('V4-R5 完整 coverage 的语义失败是 valid review 但不能 approved', semanticValidation.valid && !semanticValidation.ok, JSON.stringify(semanticValidation));

  const repairPrompt = PC.buildReadabilityRepairPrompt(units, id => plainById.get(id), semanticFail, dict, { targetIds: ['u-b'] });
  check('V4-R6 repair 只开放失败 ID 写入，但携带邻接/同容器只读 halo',
    repairPrompt.includes('"id":"u-b"') && repairPrompt.includes('"writable":true') &&
      repairPrompt.includes('"id":"u-a"') && repairPrompt.includes('"id":"u-c"') &&
      repairPrompt.includes('"writable":false') && repairPrompt.includes('targetIds=["u-b"]'),
    repairPrompt.slice(0, 1800));
}

// R7：review codes 必须受限，不能让 reviewer 自造不可执行诊断。
{
  const invalidCode = PC.validateReadabilityReview({
    approved: false,
    checkedIds: ['u1'],
    issues: [{ id: 'u1', codes: ['opaque-concept'], message: '旧 regex code 不再是 reviewer contract。' }]
  }, ['u1']);
  check('V4-R7 reviewer code schema 非法必须 fail-close', !invalidCode.valid && !invalidCode.ok, JSON.stringify(invalidCode));
}

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
