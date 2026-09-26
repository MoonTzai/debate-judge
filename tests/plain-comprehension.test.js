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
    reqs.length === 1 && reqs[0].requirements[0].mode === 'semantic-context-hint' &&
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
  check('V5-R2a reviewer v2 必须把零背景可读从抽象标签落实成可操作三问，并拒绝伪白话/跨章依赖',
    PC.READABILITY_REVIEW_PROMPT_VERSION === 'plain-readability-review-v2' &&
      prompt.includes('具体发生了什么') &&
      prompt.includes('为什么会影响论证或裁决') &&
      prompt.includes('当前结论怎样由前述事实') &&
      prompt.includes('只做同义词换词') &&
      prompt.includes('必须先懂前章'),
    prompt.slice(0, 1800));

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
    repairPrompt.includes('"id": "u-b"') && repairPrompt.includes('"writable": true') &&
      repairPrompt.includes('"id": "u-a"') && repairPrompt.includes('"id": "u-c"') &&
      repairPrompt.includes('"writable": false') && repairPrompt.includes('targetIds=["u-b"]'),
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

// R8：语义概念标签退出 exact-count hard gate；事实数字/证据定位 ID 仍机械保护。
{
  const semanticOrig = "以精神愉悦/主观普遍性/休谟铺设B0=B'，Phase I 完成";
  const semanticNatural = "反方用精神愉悦、主观普遍性以及休谟的思路，铺设出 B0=B'；这里的 B0 指核心立论框架。框架声明阶段已经完成。";
  const semanticGate = PC.inspectPlainText(semanticOrig, semanticNatural, { profile: PC.PROFILE_BODY });
  check('V9-H1 B0/Phase 等语义标签的重复或自然改写不得触发 mechanical hard gate',
    semanticGate.ok && semanticGate.issues.length === 0,
    JSON.stringify(semanticGate));

  const units = [{
    id: 'u-sem-hard',
    text: "依据 M-FA-2，比分 4:6，完成 2 次回应。",
    module: 'C6',
    blockType: 'paragraph',
    containerTag: 'div',
    path: ['C6','u-sem-hard']
  }];
  const badFactRepair = "依据 M-FA-3，比分 4:6，完成 2 次回应。";
  const factHard = PC.inspectPlainText(units[0].text, badFactRepair, { profile: PC.PROFILE_BODY });
  const mechanicalIssues = [{ id: 'u-sem-hard', issues: factHard.issues }];
  const prompt = PC.buildReadabilityHardRepairPrompt(
    units,
    () => badFactRepair,
    dict,
    { targetIds: ['u-sem-hard'], mechanicalIssues }
  );
  check('V9-H2 M/CP/N/S 证据定位与明确数字事实漂移仍必须 fail-close',
    !factHard.ok && factHard.issues.some(x => x.code === 'protected-token-drift'),
    JSON.stringify(factHard));
  check('V9-H3 hard-repair 只针对机器可证明的数字/证据定位，不把 B0/Phase 当 exact-count token',
    PC.READABILITY_HARD_REPAIR_PROMPT_VERSION === 'plain-readability-hard-repair-v1' &&
      prompt.includes('所有机械受保护 identity') &&
      prompt.includes('身份集合一致') &&
      prompt.includes('重复同一个已存在值本身不构成机械错误') &&
      prompt.includes("B0/B'/B''/SC/Phase/Q/Lv/场C 等语义框架标签不属于本机械 identity 范围") &&
      prompt.includes('targetIds=["u-sem-hard"]') &&
      prompt.includes('protected-token-drift'),
    prompt);

  const reviewPrompt = PC.buildReadabilityReviewPrompt(
    [{ id: 'u-label', text: "B0=B'型微消化", module: 'C3', blockType: 'block', containerTag: 'div', path: ['C3','u-label'] }],
    () => '直接用己方原有立论框架接住并重新解释对方这一点，因此不需要额外再引入一个新的上位框架。',
    dict,
    { targetIds: ['u-label'] }
  );
  check('V9-H4 reviewer 必须按概念/阶段/论证作用的语义是否改变来判，而不是按标签字符串',
    reviewPrompt.includes('标签是否变化不是独立失败理由') &&
      reviewPrompt.includes('所指概念、阶段关系、论证作用或事实发生实质变化') &&
      reviewPrompt.includes('semanticEquivalent=false'),
    reviewPrompt.slice(0, 2600));
}

// R9：稳定内部符号进入 glossary cognition hints，但最长词优先，禁止重复解释 locator。
{
  const required = {
    "SC": "结构性交锋",
    "B0": "核心主张",
    "B'": "重新定位对方论证",
    "B''": "更高阶理由",
    "B0=B'": "核心主张在功能上",
    "B0=B'型": "从立论开始",
    "B0=B'型微消化": "直接用立论时",
    "B0容纳潜力": "对方论证的空间",
    "己方B0框架": "核心主张或核心立论框架",
    "A→B0": "推进到己方核心主张",
    "B0→C": "推进到最终结论",
    "Phase I": "框架声明阶段",
    "Phase II": "微消化推进阶段",
    "Phase III": "结晶阶段",
    "PhIII③": "第三个要素",
    "场C": "元场层面争议"
  };
  check('V7-G1 高频稳定内部术语已进入 plain-dict cognition hints',
    Object.entries(required).every(([term, fragment]) => typeof dict[term] === 'string' && dict[term].includes(fragment)),
    JSON.stringify(Object.fromEntries(Object.keys(required).map(term => [term, dict[term] || null]))));

  const longHits = PC.conceptMatches("框架铺设·B0=B'型微消化");
  check('V7-G2 conceptMatches 最长词优先，不为 B0=B\'型微消化重复注入 B0/B\' 子提示',
    longHits.length === 1 && longHits[0].term === "B0=B'型微消化",
    JSON.stringify(longHits));

  const equationUnit = [{
    id: 'u-eq',
    text: "以精神愉悦/主观普遍性/休谟铺设B0=B'",
    module: 'C3',
    blockType: 'block',
    containerTag: 'div',
    path: ['C3','u-eq']
  }];
  const prompt = PC.buildReadabilityReviewPrompt(
    equationUnit,
    () => "用精神愉悦、主观普遍性以及休谟的思路，铺设出 B0=B'。",
    dict,
    { targetIds: ['u-eq'] }
  );
  check('V7-G3 B0=B\' 整体表达只给功能等价整体提示，不拆成 B0/B\' 双重解释',
    prompt.includes('"term": "B0=B\'"') &&
      !prompt.includes('"term": "B0"') &&
      !prompt.includes('"term": "B\'"'),
    prompt.slice(0, 2200));

  const higherHit = PC.conceptMatches("若出现 B'' 上位覆盖，应重新比较更高阶理由。");
  check('V7-G4 B\'\' 必须作为更高阶理由独立命中，不能退化为 B\' 子串提示',
    higherHit.some(x => x.term === "B''") && !higherHit.some(x => x.term === "B'"),
    JSON.stringify(higherHit));

  const phaseHits = PC.conceptMatches('Phase I 完成后进入 Phase II，随后在 Phase III 结晶。');
  check('V7-G5 Phase I/II/III 都有稳定阶段白话提示',
    ['Phase I','Phase II','Phase III'].every(term => phaseHits.some(x => x.term === term)),
    JSON.stringify(phaseHits));
}


// R10：固定词表只作语义理解提示，不得成为机械翻译/字符串匹配门禁。
{
  const orig = "B0=B'型微消化";
  const natural = "这里的 B0 是己方核心立论；这个框架本身已经能接住并重新解释对方这一点，所以可以直接沿用它回应。";
  const mechanical = PC.inspectPlainText(orig, natural, { profile: PC.PROFILE_BODY });
  check('V8-S1 不复刻词典原句的自然等价解释不得被机械层拒绝',
    mechanical.ok && mechanical.issues.length === 0,
    JSON.stringify(mechanical));

  const units = [{
    id: 'u-sem',
    text: "B0=B'型微消化",
    module: 'C3',
    blockType: 'block',
    containerTag: 'div',
    path: ['C3','u-sem']
  }];
  const reviewPrompt = PC.buildReadabilityReviewPrompt(units, () => natural, dict, { targetIds: ['u-sem'] });
  check('V8-S2 reviewer 必须明确把 glossary 当候选语义而非答案键/字符串匹配规则',
    reviewPrompt.includes('不是答案键、标准译文或字符串匹配规则') &&
      reviewPrompt.includes('不得因为候选没有复现词典措辞') &&
      reviewPrompt.includes('先结合 originalText、上下文和本场具体论证'),
    reviewPrompt.slice(0, 2400));

  const contract = PC.buildPromptContract({ profile: PC.PROFILE_BODY });
  check('V8-S3 generator 必须先理解本场语义，再决定保留/解释/改写术语',
    contract.includes('不是翻译表或答案键') &&
      contract.includes('先根据原文、邻接上下文和本场论证理解术语此处的实际语义') &&
      contract.includes('不以“首次出现”或是否复现词典措辞作为机械判据'),
    contract);

  const badByMeaning = "B0=B'型微消化（直接用立论时已经具备容纳功能的核心框架，接住并重新解释对方的一处论证）";
  const badReviewPrompt = PC.buildReadabilityReviewPrompt(units, () => badByMeaning, dict, { targetIds: ['u-sem'] });
  check('V8-S4 即使候选照抄词典，reviewer 仍必须按本场 what/why/conclusion 可理解性判断',
    badReviewPrompt.includes('真正要判断的是忽略术语标签后') &&
      badReviewPrompt.includes('具体发生了什么') &&
      badReviewPrompt.includes('为什么会影响论证或裁决'),
    badReviewPrompt.slice(0, 2600));
}

// R11：同一数值/证据 identity 可以为解释重复；新值/改号仍必须机械阻断。
{
  const c8WhyOrig = '双方各4象限被对方锁定、各2/2对角闭环、无假价值，修辞格局呈对称全线受压。';
  const c8WhyExplain = '在四象限格局里，双方各有 4 个象限被对方锁定；双方还各有 2/2 的对角闭环，2/2 是报告对这类闭环数量的标记；整体呈对称全线受压。';
  const repeated = PC.inspectPlainText(c8WhyOrig, c8WhyExplain, { profile: PC.PROFILE_GUIDE });
  check('V10-N1 同一 4 / 2/2 为解释重复不得因次数增加被机械拒绝',
    repeated.ok,
    JSON.stringify(repeated));

  const c8ConclusionOrig = '意义感维度双开各+0.5，胜负取决于谁能把因向驱力收束成贯通自由与规律的一方。';
  const c8ConclusionExplain = '在意义感维度上双方各得 +0.5，也就是双方在这个维度上各增加 +0.5；胜负仍看谁能把因向驱力收束起来。';
  const repeatedDecimal = PC.inspectPlainText(c8ConclusionOrig, c8ConclusionExplain, { profile: PC.PROFILE_GUIDE });
  check('V10-N2 同一 0.5 的自然复述不得因重复次数被机械拒绝',
    repeatedDecimal.ok,
    JSON.stringify(repeatedDecimal));

  const newNumericIdentity = PC.inspectPlainText(c8WhyOrig, c8WhyExplain.replace('4 个象限', '5 个象限'), { profile: PC.PROFILE_GUIDE });
  check('V10-N3 引入原文没有的数值 identity 仍必须 fail-close',
    !newNumericIdentity.ok && newNumericIdentity.issues.some(x => x.code === 'protected-token-drift'),
    JSON.stringify(newNumericIdentity));

  const refOrig = '依据 M-FA-2，比分 4:6，完成 2 次回应。';
  const refBad = '依据 M-FA-3，比分 4:6，完成 2 次回应。';
  const refDrift = PC.inspectPlainText(refOrig, refBad, { profile: PC.PROFILE_BODY });
  check('V10-N4 证据定位 ID 替换仍必须 fail-close',
    !refDrift.ok && refDrift.issues.some(x => x.code === 'protected-token-drift'),
    JSON.stringify(refDrift));
}

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
