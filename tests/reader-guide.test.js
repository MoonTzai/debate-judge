// A3：R8 ReaderGuide 的公开 seam（运行：node tests/reader-guide.test.js）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const RG = require('../scripts/reader-guide.js');
const RR = require('../render-report.js');
const hn = require('../executor/host-node.js');
const core = require('../executor/core.js');

let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const MODULES = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
  const id = 'C' + (i + 1);
  return [id, { xp: id + ' 解释', slots: { ['INSERT_' + id + '_MAIN']: id + ' 的权威材料。' }, prose: id + ' 的章节事实。', pre: '', raw: '' }];
}));
const normalized = {
  data: {
    'S1.辩题': '金钱是否能买到幸福',
    'S1.正方人数': 4,
    'S1.反方人数': 4,
    'S1.正方轮次': 4,
    'S13.正方人数': 4,
    'S13.反方人数': 4,
    'S11.类型': '1b',
    'S15.正方得分': 4,
    'S15.反方得分': 6,
    'S15.获胜方': '反方',
    'S9.理性.正方': 5,
    'S9.理性.反方': 7
  },
  modules: MODULES
};
const structure = { meta: { schema_version: 'v2' }, layers: [{ id: 'N1', label: '结构性交锋', side: '反方' }] };
const SPEECH_FIXTURE = [
  '**关键CP逐回合轨迹**',
  '',
  '| CP-ID | 回合 | 发言方 | 动作 | 该点临时状态 | 辩词引用 |',
  '|---|---|---|---|---|---|',
  '| CP-3 | 1 | 反二 | 攻击 | 被削弱 | “信念极端之恶……跟钱完全没有关系” |',
  '| CP-3 | 2 | 正三 | 回应 | 被击穿 | “麻原彰晃……心里想的还是钱哪” |',
  '| CP-6 | 1 | 反三 | 攻击 | 被削弱 | “恶的根源为什么会结出善的果实呢” |',
  '| CP-6 | 2 | 正四 | 回应 | 被击穿 | “万恶之源本身并不是恶” |',
  '',
  '### 推理链'
].join('\n');

function anchorFor(section) {
  return section.sources.find(source => /^SPEECH:/.test(source.id));
}

function anchorsFor(section) {
  const anchors = section.sources.filter(source => /^SPEECH:/.test(source.id));
  return section.sectionId === 'C3' || section.sectionId === 'C7' ? anchors : anchors.slice(0, 1);
}

function evidenceWithAnchor(input, sectionIndex, evidence) {
  const anchors = anchorsFor(input.sections[sectionIndex]);
  return Array.from(new Set((evidence || []).concat(anchors.map(anchor => anchor.id))));
}

function validGuide(input, overrides) {
  const guide = {
    schemaVersion: RG.SCHEMA_VERSION,
    inputHash: RG.hashGuideInput(input),
    promptVersion: RG.PROMPT_VERSION,
    modelSnapshot: { provider: 'test', model: 'test-model' },
    cards: input.sections.map(section => {
      const anchors = anchorsFor(section);
      return {
        sectionId: section.sectionId,
        what: '本章把已有材料按读者容易理解的方式说明。',
        why: '它帮助读者理解本章在整份报告中的作用。',
        conclusion: '本章结论以来源材料为准。',
        evidence: evidenceWithAnchor(input, input.sections.indexOf(section), [section.sources[0].id]),
        anchors: anchors.map(anchor => ({ sourceId: anchor.id, speaker: anchor.anchor.speaker, stage: anchor.anchor.stage, quote: anchor.anchor.quote }))
      };
    })
  };
  return Object.assign(guide, overrides || {});
}

function validPlainGuide(guide, overrides) {
  const plain = {
    schemaVersion: RG.PLAIN_SCHEMA_VERSION,
    sourceGuideHash: RG.hashPlainGuideSource(guide),
    promptVersion: RG.PLAIN_PROMPT_VERSION,
    modelSnapshot: { provider: 'test', model: 'plain-model' },
    cards: guide.cards.map(card => ({
      sectionId: card.sectionId,
      what: card.what + '（白话）',
      why: card.why + '（白话）',
      conclusion: card.conclusion + '（白话）'
    })),
    review: {
      approved: true,
      cardChecks: guide.cards.map(card => ({
        sectionId: card.sectionId,
        semanticEquivalent: true,
        noJudgmentChange: true,
        factsConsistent: true,
        zeroBackgroundReadable: true,
        naturalReadable: true,
        noLocatorDependency: true
      }))
    }
  };
  return Object.assign(plain, overrides || {});
}

(async () => {
  const input = RG.buildGuideInput(normalized, structure, null, SPEECH_FIXTURE);
  check('A3-S1 buildGuideInput 确定性生成 C1—C12、R6 与辩词锚点',
    input.sections.length === 12 && input.sections.map(x => x.sectionId).join(',') === 'C1,C2,C3,C4,C5,C6,C7,C8,C9,C10,C11,C12' && input.sections.every(x => x.sources.some(s => s.id === 'R6:' + x.sectionId) && anchorFor(x)) &&
      input.sections[2].sources.filter(s => /^SPEECH:/.test(s.id)).map(s => s.id).join(',') === 'SPEECH:CP-3:1,SPEECH:CP-3:2' &&
      input.sections[6].sources.filter(s => /^SPEECH:/.test(s.id)).map(s => s.id).join(',') === 'SPEECH:CP-6:1,SPEECH:CP-6:2',
    JSON.stringify(input.sections.map(x => [x.sectionId, x.sources.length])));

  const guide = validGuide(input);
  const valid = RG.validateGuide(input, guide);
  check('A3-S2 有 12 张卡、辩词锚点、来源回指和受限事实时通过', valid.ok === true, JSON.stringify(valid.errors));

  // 260901 真实故障回归：schema 的数组形状错误使用 cards[n] 路径，R8 定点修复定位器必须
  // 映射到候选该位置真实 sectionId；这个测试直接喂 schema 错误，避免其它 Cx 语义错误让旧实现“碰巧变绿”。
  const indexedErrorGuide = validGuide(input);
  const swap = indexedErrorGuide.cards[1];
  indexedErrorGuide.cards[1] = indexedErrorGuide.cards[11];
  indexedErrorGuide.cards[11] = swap;
  const indexedErrors = [
    'reader-guide cards[1] anchors 超过最大项数',
    'reader-guide cards[11] anchors 超过最大项数'
  ];
  const indexedRepairIds = typeof RG.guideRepairSectionIds === 'function' ? RG.guideRepairSectionIds(indexedErrors, indexedErrorGuide) : [];
  check('R8-P0 schema cards[n] 错误必须按候选真实 sectionId 定位定点修复',
    indexedRepairIds.join(',') === 'C12,C2',
    JSON.stringify({ indexedErrors, indexedRepairIds }));

  check('R8-P1 白话导览契约 seam 已导出',
    typeof RG.hashPlainGuideSource === 'function' && typeof RG.validatePlainGuide === 'function' &&
    typeof RG.validatePlainGuideReview === 'function' && typeof RG.buildPlainGuideReviewPrompt === 'function' &&
    typeof RG.plainGuideReviewFailedSections === 'function' && typeof RG.buildPlainGuideRepairPrompt === 'function');
  const plainGuide = typeof RG.validatePlainGuide === 'function' ? validPlainGuide(guide) : null;
  const plainValid = plainGuide ? RG.validatePlainGuide(input, guide, plainGuide) : { ok: false, errors: ['plain seam missing'] };
  const plainReviewValid = plainGuide ? RG.validatePlainGuideReview(input, guide, plainGuide) : { ok: false, errors: ['plain seam missing'] };
  check('R8-P2 白话导览只改三段文本且仍通过原 R8 事实门 + 逐章语义复核',
    plainValid.ok === true && plainReviewValid.ok === true,
    JSON.stringify({ plain: plainValid.errors, review: plainReviewValid.errors }));

  if (plainGuide) {
    const badHash = JSON.parse(JSON.stringify(plainGuide));
    badHash.sourceGuideHash = '0'.repeat(64);
    check('R8-P3 白话导览必须绑定当前原 guide 哈希',
      RG.validatePlainGuide(input, guide, badHash).ok === false);

    const missingSection = JSON.parse(JSON.stringify(plainGuide));
    missingSection.cards.pop();
    check('R8-P4 白话导览必须恰为 C1—C12',
      RG.validatePlainGuide(input, guide, missingSection).ok === false);

    const factGuide = validGuide(input);
    const c1 = factGuide.cards.find(card => card.sectionId === 'C1');
    c1.conclusion = '反方获胜。';
    c1.evidence = evidenceWithAnchor(input, 0, ['DATA:S15.获胜方']);
    const factPlain = validPlainGuide(factGuide);
    factPlain.cards.find(card => card.sectionId === 'C1').conclusion = '正方获胜。';
    check('R8-P5 白话文本若改变胜负/事实关系，机械事实门必须阻断',
      RG.validatePlainGuide(input, factGuide, factPlain).ok === false,
      JSON.stringify(RG.validatePlainGuide(input, factGuide, factPlain).errors));

    const c12CountGuide = validGuide(input);
    const c12CountPlain = validPlainGuide(c12CountGuide);
    c12CountGuide.cards.find(card => card.sectionId === 'C12').why = '判决与评分共用同一证据链。';
    c12CountPlain.sourceGuideHash = RG.hashPlainGuideSource(c12CountGuide);
    c12CountPlain.cards.find(card => card.sectionId === 'C12').why = '判决与评分共用同一条证据链。';
    const c12CountCheck = RG.validatePlainGuide(input, c12CountGuide, c12CountPlain);
    check('P0-D RED：白话“同一条证据链”属于自然量词，不得被机械门误判成 1/item',
      c12CountCheck.ok === true,
      JSON.stringify(c12CountCheck.errors));

    const badReview = JSON.parse(JSON.stringify(plainGuide));
    badReview.review.cardChecks[0].semanticEquivalent = false;
    check('R8-P6 即使事实 token 未漂移，语义等价复核不通过仍必须阻断',
      RG.validatePlainGuideReview(input, guide, badReview).ok === false);
  }

  const c11Index = input.sections.findIndex(section => section.sectionId === 'C11');
  const c11SourceIds = input.sections[c11Index].sources.map(source => source.id);
  check('A3-C11a C11 必须带入 S1/S13 双方各四位的直接人数见证',
    ['DATA:S1.正方人数', 'DATA:S1.反方人数', 'DATA:S13.正方人数', 'DATA:S13.反方人数'].every(id => c11SourceIds.includes(id)),
    JSON.stringify(c11SourceIds));

  const c11DirectCounts = validGuide(input);
  c11DirectCounts.cards[c11Index].conclusion = '本章点评双方各4位辩手。';
  c11DirectCounts.cards[c11Index].evidence = evidenceWithAnchor(input, c11Index, ['DATA:S1.正方人数', 'DATA:S1.反方人数']);
  const c11DirectCountsReview = RG.validateReview(input, c11DirectCounts, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11b 双方各四位只能由同卡直接人数来源见证',
    c11DirectCountsReview.ok === true,
    JSON.stringify(c11DirectCountsReview.errors));

  const c11S13DirectCounts = validGuide(input);
  c11S13DirectCounts.cards[c11Index].conclusion = '本章分别点评正方4位和反方4位辩手。';
  c11S13DirectCounts.cards[c11Index].evidence = evidenceWithAnchor(input, c11Index, ['DATA:S13.正方人数', 'DATA:S13.反方人数']);
  const c11S13DirectCountsReview = RG.validateReview(input, c11S13DirectCounts, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11b1 S13 的双方直接人数来源也可见证',
    c11S13DirectCountsReview.ok === true,
    JSON.stringify(c11S13DirectCountsReview.errors));

  const c11WrongSideCount = validGuide(input);
  c11WrongSideCount.cards[c11Index].conclusion = '本章点评双方各4位辩手。';
  c11WrongSideCount.cards[c11Index].evidence = evidenceWithAnchor(input, c11Index, ['DATA:S1.反方人数']);
  const c11WrongSideCountReview = RG.validateReview(input, c11WrongSideCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11b2 双方各四位不得借单方人数见证，伪造复核不得绕过',
    c11WrongSideCountReview.ok === false && c11WrongSideCountReview.errors.some(error => error.includes('4/person')),
    JSON.stringify(c11WrongSideCountReview.errors));

  const c11BothHaveCount = validGuide(input);
  c11BothHaveCount.cards[c11Index].conclusion = '本章点评双方各有4位辩手。';
  c11BothHaveCount.cards[c11Index].evidence = evidenceWithAnchor(input, c11Index, ['DATA:S1.正方人数']);
  const c11BothHaveCountReview = RG.validateReview(input, c11BothHaveCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11b3 双方各有四位不得借单方人数见证，伪造复核不得绕过',
    c11BothHaveCountReview.ok === false && c11BothHaveCountReview.errors.some(error => error.includes('4/person')),
    JSON.stringify(c11BothHaveCountReview.errors));

  const c11BothHaveDirectCount = validGuide(input);
  c11BothHaveDirectCount.cards[c11Index].conclusion = '本章点评双方各有4位辩手。';
  c11BothHaveDirectCount.cards[c11Index].evidence = evidenceWithAnchor(input, c11Index, ['DATA:S1.正方人数', 'DATA:S1.反方人数']);
  const c11BothHaveDirectCountReview = RG.validateReview(input, c11BothHaveDirectCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11b4 双方各有四位可由双方直接人数来源见证',
    c11BothHaveDirectCountReview.ok === true,
    JSON.stringify(c11BothHaveDirectCountReview.errors));

  const c1Index = input.sections.findIndex(section => section.sectionId === 'C1');
  const c1RoundCount = validGuide(input);
  c1RoundCount.cards[c1Index].conclusion = '本章说明双方各有4轮。';
  c1RoundCount.cards[c1Index].evidence = evidenceWithAnchor(input, c1Index, ['DATA:S1.正方轮次']);
  const c1RoundCountReview = RG.validateReview(input, c1RoundCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11b5 双方各有人数语法不得改变非人数计数行为',
    c1RoundCountReview.ok === true,
    JSON.stringify(c1RoundCountReview.errors));

  const c1SubjectRoundCount = validGuide(input);
  c1SubjectRoundCount.cards[c1Index].conclusion = '本章说明正方4轮。';
  c1SubjectRoundCount.cards[c1Index].evidence = evidenceWithAnchor(input, c1Index, ['DATA:S1.正方轮次']);
  const c1SubjectRoundCountReview = RG.validateReview(input, c1SubjectRoundCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11b6 人数主体绑定不得改变非人数的显式主体计数行为',
    c1SubjectRoundCountReview.ok === true,
    JSON.stringify(c1SubjectRoundCountReview.errors));

  const c11AggregateCount = validGuide(input);
  c11AggregateCount.cards[c11Index].conclusion = '本章点评双方共8位辩手。';
  c11AggregateCount.cards[c11Index].evidence = evidenceWithAnchor(input, c11Index, ['DATA:S1.正方人数', 'DATA:S1.反方人数']);
  const c11AggregateCountReview = RG.validateReview(input, c11AggregateCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-C11c 双方人数不得隐式相加为八位',
    c11AggregateCountReview.ok === false && c11AggregateCountReview.errors.some(error => error.includes('8/person')),
    JSON.stringify(c11AggregateCountReview.errors));

  const c12Index = input.sections.findIndex(section => section.sectionId === 'C12');
  const synonymWinner = validGuide(input);
  synonymWinner.cards[c12Index].conclusion = '反方胜出。';
  synonymWinner.cards[c12Index].evidence = evidenceWithAnchor(input, c12Index, ['DATA:S15.获胜方']);
  const synonymWinnerCheck = RG.validateGuide(input, synonymWinner);
  check('A3-C11d 胜负词不得把同卡来源的获胜同义改写为胜出',
    synonymWinnerCheck.ok === false && synonymWinnerCheck.errors.some(error => error.includes('胜出')),
    JSON.stringify(synonymWinnerCheck.errors));

  let missingAnchorInput = false;
  try { RG.buildGuideInput(normalized, structure, null, '无关键交锋轨迹'); } catch (e) { missingAnchorInput = String(e.message).includes('辩词锚点'); }
  check('A3-S2b 缺少已裁决的辩词锚点来源时必须阻断', missingAnchorInput === true);

  const missingAnchor = validGuide(input);
  missingAnchor.cards[0].anchors = [];
  const missingAnchorCheck = RG.validateGuide(input, missingAnchor);
  check('A3-S2c 每张卡必须有同卡辩词锚点',
    missingAnchorCheck.ok === false && missingAnchorCheck.errors.some(e => e.includes('辩词锚点')),
    JSON.stringify(missingAnchorCheck.errors));

  const forgedAnchor = validGuide(input);
  forgedAnchor.cards[0].anchors[0].speaker = '正一';
  const forgedAnchorReview = RG.validateReview(input, forgedAnchor, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S2d 锚点辩手/阶段/引文必须逐项回指，伪造复核不得绕过',
    forgedAnchorReview.ok === false && forgedAnchorReview.errors.some(e => e.includes('辩词锚点')),
    JSON.stringify(forgedAnchorReview.errors));

  const crossSectionInput = JSON.parse(JSON.stringify(input));
  const otherAnchor = anchorFor(crossSectionInput.sections[2]);
  const crossSectionAnchor = validGuide(crossSectionInput);
  crossSectionAnchor.cards[0].anchors = [{ sourceId: otherAnchor.id, speaker: otherAnchor.anchor.speaker, stage: otherAnchor.anchor.stage, quote: otherAnchor.anchor.quote }];
  crossSectionAnchor.cards[0].evidence = [crossSectionInput.sections[0].sources[0].id, otherAnchor.id];
  const crossSectionCheck = RG.validateGuide(crossSectionInput, crossSectionAnchor);
  check('A3-S2e 不得跨章节借用辩词锚点',
    crossSectionCheck.ok === false && crossSectionCheck.errors.some(e => e.includes('辩词锚点')),
    JSON.stringify(crossSectionCheck.errors));

  const incompleteExchange = validGuide(input);
  incompleteExchange.cards[2].anchors = incompleteExchange.cards[2].anchors.slice(0, 1);
  incompleteExchange.cards[2].evidence = incompleteExchange.cards[2].evidence.filter(id => id !== 'SPEECH:CP-3:2');
  const incompleteExchangeReview = RG.validateReview(input, incompleteExchange, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S2f C3/C7 必须各有同 CP 的攻击与回应，伪造复核不得绕过',
    incompleteExchangeReview.ok === false && incompleteExchangeReview.errors.some(e => e.includes('攻击与回应')),
    JSON.stringify(incompleteExchangeReview.errors));

  const extraFields = validGuide(input);
  extraFields.verdict = '不应存在的裁决字段';
  extraFields.cards[0].extra = '不应存在的卡片字段';
  extraFields.promptVersion = 'r8-reader-guide-prompt-v0';
  const shapeCheck = RG.validateGuide(input, extraFields);
  check('A3-S2a schema 契约必须阻断额外字段与错误提示版本',
    shapeCheck.ok === false && shapeCheck.errors.some(e => e.includes('非契约字段')) && shapeCheck.errors.some(e => e.includes('promptVersion')),
    JSON.stringify(shapeCheck.errors));

  const duplicate = validGuide(input);
  duplicate.cards[11].sectionId = 'C1';
  const duplicateCheck = RG.validateGuide(input, duplicate);
  check('A3-S3 重复/缺失章节必须阻断', duplicateCheck.ok === false && duplicateCheck.errors.some(e => e.includes('章节集合')),
    JSON.stringify(duplicateCheck.errors));

  const inventedNumber = validGuide(input);
  inventedNumber.cards[0].conclusion = '本章宣布 99 比 1 的新比分。';
  const numberCheck = RG.validateGuide(input, inventedNumber);
  check('A3-S4 来源外数字/比分必须阻断', numberCheck.ok === false && numberCheck.errors.some(e => e.includes('事实 token')),
    JSON.stringify(numberCheck.errors));

  const inventedRef = validGuide(input);
  inventedRef.cards[0].evidence = ['DATA:不存在'];
  const refCheck = RG.validateGuide(input, inventedRef);
  check('A3-S5 非输入来源回指必须阻断', refCheck.ok === false && refCheck.errors.some(e => e.includes('来源回指')),
    JSON.stringify(refCheck.errors));

  const forgedWinner = validGuide(input);
  forgedWinner.cards[0].conclusion = '正方获胜。';
  const forgedReview = RG.validateReview(input, forgedWinner, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true }))
  });
  check('A3-S5a 主体/胜负必须从该卡实际 evidence 回指，伪造复核不得绕过',
    forgedReview.ok === false && forgedReview.errors.some(e => e.includes('事实 token')),
    JSON.stringify(forgedReview.errors));

  const mismatchedWinner = validGuide(input);
  mismatchedWinner.cards[0].conclusion = '正方以 4 比 6 获胜。';
  mismatchedWinner.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const mismatchedWinnerReview = RG.validateReview(input, mismatchedWinner, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true }))
  });
  check('A3-S5b 同 token 的主体/胜负错配必须阻断，伪造复核不得绕过',
    mismatchedWinnerReview.ok === false && mismatchedWinnerReview.errors.some(e => e.includes('来源胜负不一致')),
    JSON.stringify(mismatchedWinnerReview.errors));

  const mismatchedScoreSide = validGuide(input);
  mismatchedScoreSide.cards[0].conclusion = '反方以 4:6 获胜。';
  mismatchedScoreSide.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const mismatchedScoreSideReview = RG.validateReview(input, mismatchedScoreSide, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('P0-D RED：反方以 4:6 获胜中的 4:6 是正式正:反比分，不得误读为反方:正方',
    mismatchedScoreSideReview.ok === true,
    JSON.stringify(mismatchedScoreSideReview.errors));

  const wrongExplicitSideScore = validGuide(input);
  wrongExplicitSideScore.cards[0].conclusion = '反方得分为4分，最终反方获胜。';
  wrongExplicitSideScore.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const wrongExplicitSideScoreReview = RG.validateReview(input, wrongExplicitSideScore, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('P0-D RED：明确“反方得分为4分”必须继续按主体得分硬门阻断',
    wrongExplicitSideScoreReview.ok === false && wrongExplicitSideScoreReview.errors.some(e => e.includes('主体得分不一致')),
    JSON.stringify(wrongExplicitSideScoreReview.errors));

  const explicitArabicItemCount = validGuide(input);
  explicitArabicItemCount.cards[0].conclusion = '本章明确列出3条证据。';
  explicitArabicItemCount.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const explicitArabicItemCountReview = RG.validateReview(input, explicitArabicItemCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('P0-D RED：阿拉伯数字的明确“3条证据”仍必须属于硬保护',
    explicitArabicItemCountReview.ok === false,
    JSON.stringify(explicitArabicItemCountReview.errors));

  const chineseNumeral = validGuide(input);
  chineseNumeral.cards[0].conclusion = '本章宣布九十九比一的新比分。';
  chineseNumeral.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分']);
  const chineseNumeralReview = RG.validateReview(input, chineseNumeral, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true }))
  });
  check('A3-S5d 中文数词构成的来源外比分必须阻断，伪造复核不得绕过',
    chineseNumeralReview.ok === false && chineseNumeralReview.errors.some(e => e.includes('事实关系')),
    JSON.stringify(chineseNumeralReview.errors));

  const ungroundedChineseCount = validGuide(input);
  ungroundedChineseCount.cards[0].conclusion = '本章有九十九位评委。';
  ungroundedChineseCount.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const ungroundedChineseCountReview = RG.validateReview(input, ungroundedChineseCount, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true }))
  });
  check('A3-S5e 裸中文计数事实必须由同卡 evidence 见证，伪造复核不得绕过',
    ungroundedChineseCountReview.ok === false && ungroundedChineseCountReview.errors.some(e => e.includes('事实声明')),
    JSON.stringify(ungroundedChineseCountReview.errors));

  const predicateWinner = validGuide(input);
  predicateWinner.cards[0].conclusion = '获胜方为正方，比分是四比六。';
  predicateWinner.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const predicateWinnerReview = RG.validateReview(input, predicateWinner, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true }))
  });
  check('A3-S5f 谓词式获胜方必须由同卡 evidence 见证，伪造复核不得绕过',
    predicateWinnerReview.ok === false && predicateWinnerReview.errors.some(e => e.includes('来源胜负不一致')),
    JSON.stringify(predicateWinnerReview.errors));

  const acknowledgedWinner = validGuide(input);
  acknowledgedWinner.cards[0].conclusion = '正方承认反方获胜，比分四比六。';
  acknowledgedWinner.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const acknowledgedWinnerReview = RG.validateReview(input, acknowledgedWinner, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S5g 引述/承认语境应识别实际获胜方，不得误拒来源一致的声明',
    acknowledgedWinnerReview.ok === true,
    JSON.stringify(acknowledgedWinnerReview.errors));

  const narrativeEvidenceInput = JSON.parse(JSON.stringify(input));
  narrativeEvidenceInput.sections[0].sources[0].text = '本章确认反方获胜，比分为 4 比 6。';
  const narrativeEvidenceGuide = validGuide(narrativeEvidenceInput);
  narrativeEvidenceGuide.cards[0].conclusion = '获胜方为反方，比分是四比六。';
  narrativeEvidenceGuide.cards[0].evidence = evidenceWithAnchor(narrativeEvidenceInput, 0, ['R6:C1']);
  const narrativeEvidenceReview = RG.validateReview(narrativeEvidenceInput, narrativeEvidenceGuide, {
    approved: true,
    cardChecks: narrativeEvidenceInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S5h R6 文本中的胜负/比分可单独充当本卡事实见证',
    narrativeEvidenceReview.ok === true,
    JSON.stringify(narrativeEvidenceReview.errors));

  const countEvidenceInput = JSON.parse(JSON.stringify(input));
  countEvidenceInput.sections[0].sources.push({ id: 'DATA:S1.评委人数', text: 'S1.评委人数=2' });
  const countEvidenceGuide = validGuide(countEvidenceInput);
  countEvidenceGuide.cards[0].conclusion = '本章有二位评委。';
  countEvidenceGuide.cards[0].evidence = evidenceWithAnchor(countEvidenceInput, 0, ['DATA:S1.评委人数']);
  const countEvidenceReview = RG.validateReview(countEvidenceInput, countEvidenceGuide, {
    approved: true,
    cardChecks: countEvidenceInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S5i 结构化阿拉伯数值可见证等义中文计数声明',
    countEvidenceReview.ok === true,
    JSON.stringify(countEvidenceReview.errors));

  const predicateContext = validGuide(input);
  predicateContext.cards[0].conclusion = '正方在本章提出论点，获胜方为反方，比分是四比六。';
  predicateContext.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const predicateContextReview = RG.validateReview(input, predicateContext, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S5j 获胜方谓词不得把前置主体误判为获胜主体',
    predicateContextReview.ok === true,
    JSON.stringify(predicateContextReview.errors));

  const reverseBareScore = validGuide(input);
  reverseBareScore.cards[0].conclusion = '比分六比四。';
  reverseBareScore.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const reverseBareScoreReview = RG.validateReview(input, reverseBareScore, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true }))
  });
  check('A3-S5k 无主体比分只能按正方:反方顺序见证，反向必须阻断',
    reverseBareScoreReview.ok === false && reverseBareScoreReview.errors.some(e => e.includes('无来源比分见证')),
    JSON.stringify(reverseBareScoreReview.errors));

  const forwardBareScore = validGuide(input);
  forwardBareScore.cards[0].conclusion = '比分四比六。';
  forwardBareScore.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const forwardBareScoreReview = RG.validateReview(input, forwardBareScore, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S5k2 无主体正向比分可由正方:反方结构化分数见证',
    forwardBareScoreReview.ok === true,
    JSON.stringify(forwardBareScoreReview.errors));

  const negativeSideScore = validGuide(input);
  negativeSideScore.cards[0].conclusion = '反方以六比四获胜。';
  negativeSideScore.cards[0].evidence = evidenceWithAnchor(input, 0, ['DATA:S15.正方得分', 'DATA:S15.反方得分', 'DATA:S15.获胜方']);
  const negativeSideScoreReview = RG.validateReview(input, negativeSideScore, {
    approved: true,
    cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('P0-D RED：反方以六比四不得把全局比分倒置成反方:正方来绕过正式 4:6',
    negativeSideScoreReview.ok === false && negativeSideScoreReview.errors.some(e => e.includes('无来源比分见证')),
    JSON.stringify(negativeSideScoreReview.errors));

  const subjectNarrativeInput = JSON.parse(JSON.stringify(input));
  subjectNarrativeInput.sections[0].sources[0].text = '反方以6比4。';
  const subjectNarrativeGuide = validGuide(subjectNarrativeInput);
  subjectNarrativeGuide.cards[0].conclusion = '反方以6比4。';
  subjectNarrativeGuide.cards[0].evidence = evidenceWithAnchor(subjectNarrativeInput, 0, ['R6:C1']);
  const subjectNarrativeReview = RG.validateReview(subjectNarrativeInput, subjectNarrativeGuide, {
    approved: true,
    cardChecks: subjectNarrativeInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S5o 显式反方比分可由同主体同方向的 R6 文本见证',
    subjectNarrativeReview.ok === true,
    JSON.stringify(subjectNarrativeReview.errors));

  const crossedSubjectNarrativeInput = JSON.parse(JSON.stringify(input));
  crossedSubjectNarrativeInput.sections[0].sources[0].text = '正方以4比6，反方以6比4。';
  const crossedSubjectNarrativeGuide = validGuide(crossedSubjectNarrativeInput);
  crossedSubjectNarrativeGuide.cards[0].conclusion = '正方以6比4。';
  crossedSubjectNarrativeGuide.cards[0].evidence = evidenceWithAnchor(crossedSubjectNarrativeInput, 0, ['R6:C1']);
  const crossedSubjectNarrativeReview = RG.validateReview(crossedSubjectNarrativeInput, crossedSubjectNarrativeGuide, {
    approved: true,
    cardChecks: crossedSubjectNarrativeInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('P0-D 主体+比分自然语言关系不由机械门越权裁决；ordered 比分有来源时交独立 reviewer 判语义',
    crossedSubjectNarrativeReview.ok === true && !crossedSubjectNarrativeReview.errors.some(e => e.includes('主体/比分不一致')),
    JSON.stringify(crossedSubjectNarrativeReview.errors));

  const countNotOrdinalInput = JSON.parse(JSON.stringify(input));
  countNotOrdinalInput.sections[0].sources.push({ id: 'DATA:S1.轮次', text: 'S1.轮次=2' });
  const countNotOrdinalGuide = validGuide(countNotOrdinalInput);
  countNotOrdinalGuide.cards[0].conclusion = '第2轮已完成。';
  countNotOrdinalGuide.cards[0].evidence = evidenceWithAnchor(countNotOrdinalInput, 0, ['DATA:S1.轮次']);
  const countNotOrdinalReview = RG.validateReview(countNotOrdinalInput, countNotOrdinalGuide, {
    approved: true,
    cardChecks: countNotOrdinalInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true }))
  });
  check('A3-S5l 普通轮次数量不能见证第 N 轮序数声明，伪造复核不得绕过',
    countNotOrdinalReview.ok === false && countNotOrdinalReview.errors.some(e => e.includes('事实声明')),
    JSON.stringify(countNotOrdinalReview.errors));

  const ordinalTextInput = JSON.parse(JSON.stringify(input));
  ordinalTextInput.sections[0].sources[0].text = '第2轮的交锋记录已经完成。';
  const ordinalTextGuide = validGuide(ordinalTextInput);
  ordinalTextGuide.cards[0].conclusion = '第2轮已完成。';
  ordinalTextGuide.cards[0].evidence = evidenceWithAnchor(ordinalTextInput, 0, ['R6:C1']);
  const ordinalTextReview = RG.validateReview(ordinalTextInput, ordinalTextGuide, {
    approved: true,
    cardChecks: ordinalTextInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
  });
  check('A3-S5m 明确第 N 轮文本可见证同一序数声明',
    ordinalTextReview.ok === true,
    JSON.stringify(ordinalTextReview.errors));

  const key1 = RG.cacheKey(input, guide.modelSnapshot);
  const key2 = RG.cacheKey(input, { provider: 'test', model: 'other-model' });
  check('A3-S6 缓存键包含输入/提示/模型/契约版本', /^[a-f0-9]{64}$/.test(key1) && key1 !== key2, key1 + ' / ' + key2);

  const reviewPass = RG.validateReview(input, guide, { approved: true, cardChecks: input.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true })) });
  const reviewFail = RG.validateReview(input, guide, { approved: false, cardChecks: [] });
  check('A3-S7 复核必须逐章确认“无新增裁决/事实/锚点一致”', reviewPass.ok === true && reviewFail.ok === false, JSON.stringify({ pass: reviewPass.errors, fail: reviewFail.errors }));

  const rendered = RR.renderReaderGuide(guide);
  const visibleCards = rendered.match(/<article class="reader-guide-card"[^>]*>[\s\S]*?<\/article>/g) || [];
  check('A3-S8 渲染器只展示十二张三段式导览卡', visibleCards.length === 12 && visibleCards.every(card => (card.match(/<dt>/g) || []).length === 3) && !rendered.includes('reader-guide-anchor') && !rendered.includes('reader-guide-evidence') && !rendered.includes('辩词锚点') && !rendered.includes('来源回指') && rendered.includes('C12') && !rendered.includes('<script'), rendered.slice(0, 220));

  const regularRendered = RR.renderHTML(normalized);
  check('A3-S8a R8 专用样式只进入独立导览，普通报告不带该样式',
    rendered.includes('.reader-guide-card{') && !regularRendered.includes('.reader-guide-card{'),
    JSON.stringify({ guideHasR8Css: rendered.includes('.reader-guide-card{'), reportHasR8Css: regularRendered.includes('.reader-guide-card{') }));

  // R8-M1 视觉契约：十二张导览必须分散到 C1—C12 各章开头，并以原生 details 默认折叠；
  // 纯 renderer 只可机械嵌入已验收 guide，重复执行必须逐字幂等。
  const embedded = typeof RR.embedReaderGuideIntoReport === 'function'
    ? RR.embedReaderGuideIntoReport(regularRendered, guide, plainGuide) : '';
  const embeddedCards = embedded.match(/<details class="reader-guide-card reader-guide-card-embedded"[^>]*>[\s\S]*?<\/details>/g) || [];
  const embeddedAgain = typeof RR.embedReaderGuideIntoReport === 'function'
    ? RR.embedReaderGuideIntoReport(embedded, guide, plainGuide) : '';
  const perSectionPlacement = RG.SECTION_IDS.every(sectionId => {
    const id = sectionId.toLowerCase();
    const re = new RegExp('id="' + id + '"[^>]*>\\s*<h2[^>]*>[\\s\\S]*?<\\/h2><!--R8_REPORT_GUIDE_START:' + sectionId + '-->');
    return re.test(embedded);
  });
  check('R8-M1-S1 正常主报告在 C1—C12 各章开头机械嵌入默认折叠三段式导览且逐字幂等',
    typeof RR.embedReaderGuideIntoReport === 'function' &&
      !regularRendered.includes('R8_REPORT_GUIDE_SLOT') &&
      (embedded.match(/<!--R8_REPORT_GUIDE_START:C\d{1,2}-->/g) || []).length === 12 &&
      (embedded.match(/<!--R8_REPORT_GUIDE_END:C\d{1,2}-->/g) || []).length === 12 &&
      embeddedCards.length === 12 && embeddedCards.every(card =>
        (card.match(/<dt>/g) || []).length === 3 &&
        card.includes('<summary>章节导览</summary>') &&
        card.includes('<dl style="margin-top:12px">') &&
        (card.match(/data-orig=/g) || []).length === 3 &&
        (card.match(/data-plain=/g) || []).length === 3 &&
        !card.includes('展开查看') &&
        !/<summary>C\d{1,2}\b/.test(card)) &&
      perSectionPlacement &&
      !/<details class="reader-guide-card reader-guide-card-embedded"[^>]*\sopen(?:\s|>)/.test(embedded) &&
      !embedded.includes('reader-guide reader-guide-embedded') &&
      embeddedAgain === embedded &&
      !embedded.includes('reader-guide-anchor') && !embedded.includes('reader-guide-evidence'),
    JSON.stringify({ hasEmbedder: typeof RR.embedReaderGuideIntoReport === 'function', cards: embeddedCards.length, perSectionPlacement, idempotent: embeddedAgain === embedded, delta: embeddedAgain.length - embedded.length }));

  // R8 adapter 失败时不可覆写任何 R1—R7 报告；只测试公开失败隔离行为。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r8-isolation-'));
  try {
    const transition = '<!--DATA: S1.辩题=金钱是否能买到幸福 -->\n<!--DATA: S15.正方得分=4 -->\n<!--DATA: S15.反方得分=6 -->\n<!--DATA: S15.获胜方=反方 -->';
    fs.writeFileSync(path.join(workDir, 'transition-final.md'), transition, 'utf8');
    fs.writeFileSync(path.join(workDir, '.tmp-adjudicated-data.md'), transition + '\n\n' + SPEECH_FIXTURE, 'utf8');
    fs.writeFileSync(path.join(workDir, '叙事.md'), Array.from({ length: 12 }, (_, i) => '## C' + (i + 1) + ' 标题\n<!--XP:测试-->\n<!--INSERT_C' + (i + 1) + '_MAIN-->\nC' + (i + 1) + ' 材料。\n<!--INSERT_C' + (i + 1) + '_MAIN-->').join('\n\n'), 'utf8');
    fs.writeFileSync(path.join(workDir, 'structure.json'), JSON.stringify(structure), 'utf8');
    fs.writeFileSync(path.join(workDir, 'report.html'), regularRendered, 'utf8');
    fs.writeFileSync(path.join(workDir, 'report-plain.html'), '<html><body>既有白话报告</body></html>', 'utf8');
    const before = [fs.readFileSync(path.join(workDir, 'report.html'), 'utf8'), fs.readFileSync(path.join(workDir, 'report-plain.html'), 'utf8')];
    const authorityNames = ['transition-final.md', '.tmp-adjudicated-data.md', '叙事.md', 'structure.json', 'report-plain.html'];
    const authorityBefore = Object.fromEntries(authorityNames.map(name => [name, fs.readFileSync(path.join(workDir, name), 'utf8')]));
    let threw = '';
    try {
      await hn.applyReaderGuide(workDir, { provider: 'mock' }, () => {}, { requestCompletion: async () => JSON.stringify({ approved: false, cardChecks: [] }) });
    } catch (e) { threw = String(e.message); }
    const after = [fs.readFileSync(path.join(workDir, 'report.html'), 'utf8'), fs.readFileSync(path.join(workDir, 'report-plain.html'), 'utf8')];
    const authorityAfter = Object.fromEntries(authorityNames.map(name => [name, fs.readFileSync(path.join(workDir, name), 'utf8')]));
    check('A3-S9 R8 失败态不得改写任何 R1—R7 权威输入/裁决正文，只可留下私有 R8 checkpoint',
      threw.includes('R8') && before[0] === after[0] && before[1] === after[1] &&
      authorityNames.every(name => authorityBefore[name] === authorityAfter[name]) &&
      !fs.existsSync(path.join(workDir, 'reader-guide.html')) && !fs.existsSync(path.join(workDir, 'reader-guide-plain.json')), threw);

    let calls = 0;
    const logs = [];
    const response = async (_cfg, messages) => {
      calls++;
      const prompt = messages[0].content;
      if (prompt.includes('reader-guide-plain') && prompt.includes('独立语义复核器')) {
        return JSON.stringify({ approved: true, cardChecks: RG.SECTION_IDS.map(sectionId => ({
          sectionId, semanticEquivalent: true, noJudgmentChange: true, factsConsistent: true,
          zeroBackgroundReadable: true, naturalReadable: true, noLocatorDependency: true
        })) });
      }
      if (prompt.includes('\n\nreader-guide:\n')) {
        return JSON.stringify({ approved: true, cardChecks: RG.SECTION_IDS.map(sectionId => ({ sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true })) });
      }
      const marker = '\n\nguide-input:\n';
      const generatedInput = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
      return JSON.stringify(validGuide(generatedInput, { modelSnapshot: { provider: 'mock', model: 'mock-model' } }));
    };
    const first = await hn.applyReaderGuide(workDir, { provider: 'mock', model: 'mock-model' }, message => logs.push(message), { requestCompletion: response });
    const produced = JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide.json'), 'utf8'));
    const reportAfterFirstEmbed = fs.readFileSync(path.join(workDir, 'report.html'), 'utf8');
    let cacheCalledModel = false;
    const second = await hn.applyReaderGuide(workDir, { provider: 'mock', model: 'mock-model' }, message => logs.push(message), {
      requestCompletion: async () => { cacheCalledModel = true; throw new Error('缓存命中时不得再请求模型'); }
    });
    const reportsAfter = [fs.readFileSync(path.join(workDir, 'report.html'), 'utf8'), fs.readFileSync(path.join(workDir, 'report-plain.html'), 'utf8')];
    check('R8-M1-S2 R8 成功后只机械嵌入原文主报告并按输入/提示/模型键复用缓存',
      calls === 3 && first.cached === false && first.plainCached === false && second.cached === true && second.plainCached === true && !cacheCalledModel &&
      produced.cards.length === 12 && fs.existsSync(path.join(workDir, 'reader-guide-input.json')) &&
      fs.existsSync(path.join(workDir, 'reader-guide-plain.json')) && fs.existsSync(path.join(workDir, 'reader-guide.html')) && fs.existsSync(path.join(workDir, '.tmp-reader-guide-cache.json')) &&
      RG.validatePlainGuideReview(JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide-input.json'), 'utf8')), produced, JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide-plain.json'), 'utf8'))).ok === true &&
      (reportsAfter[0].match(/<!--R8_REPORT_GUIDE_START:C\d{1,2}-->/g) || []).length === 12 &&
      (reportsAfter[0].match(/<details class="reader-guide-card reader-guide-card-embedded"/g) || []).length === 12 &&
      (reportsAfter[0].match(/data-orig=/g) || []).length >= 36 && (reportsAfter[0].match(/data-plain=/g) || []).length >= 36 &&
      RG.SECTION_IDS.every(sectionId => new RegExp('id="' + sectionId.toLowerCase() + '"[^>]*>\\s*<h2[^>]*>[\\s\\S]*?<\\/h2><!--R8_REPORT_GUIDE_START:' + sectionId + '-->').test(reportsAfter[0])) &&
      reportsAfter[0] === reportAfterFirstEmbed &&
      reportsAfter[1] === before[1] && logs.some(message => message.includes('缓存命中')),
      JSON.stringify({ calls, first, second, cacheCalledModel }));

    // PLAIN v4 R8：生成器只产 draft；自然可读性由独立 reviewer 判。reviewer 点名失败卡后，
    // repair 只能改该卡，但可以看到该卡完整 what/why/conclusion 上下文；不再机械强塞固定括号释义。
    const retryInput = JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide-input.json'), 'utf8'));
    const retrySnapshot = { provider: 'codex-cli', model: 'gpt-5.5' };
    const retryGuide = validGuide(retryInput, { modelSnapshot: retrySnapshot });
    retryGuide.cards[0].what = '本章比较六向度。';
    const retryReview = {
      approved: true,
      cardChecks: retryInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
    };
    fs.writeFileSync(path.join(workDir, 'reader-guide.json'), JSON.stringify(retryGuide, null, 2), 'utf8');
    fs.writeFileSync(path.join(workDir, '.tmp-reader-guide-cache.json'), JSON.stringify({
      key: RG.cacheKey(retryInput, retrySnapshot),
      inputHash: RG.hashGuideInput(retryInput),
      guide: retryGuide,
      review: retryReview
    }, null, 2), 'utf8');
    fs.rmSync(path.join(workDir, 'reader-guide-plain.json'), { force: true });
    let plainTranslateCalls = 0;
    let plainReviewCalls = 0;
    let semanticRepairCalls = 0;
    let semanticRepairScoped = false;
    const sixGreen = sectionId => ({
      sectionId, semanticEquivalent: true, noJudgmentChange: true, factsConsistent: true,
      zeroBackgroundReadable: true, naturalReadable: true, noLocatorDependency: true
    });
    const retryResponse = async (_cfg, messages, opts) => {
      const prompt = String(messages[0] && messages[0].content || '');
      const system = String(opts && opts.system || '');
      if (system.includes('R8 章节导览白话层的独立语义复核器')) {
        plainReviewCalls++;
        const checks = RG.SECTION_IDS.map(sixGreen);
        if (plainReviewCalls === 1) {
          const c1 = checks.find(item => item.sectionId === 'C1');
          c1.zeroBackgroundReadable = false;
          c1.naturalReadable = false;
          return JSON.stringify({ approved: false, cardChecks: checks });
        }
        return JSON.stringify({ approved: true, cardChecks: checks });
      }
      if (system.includes('R8 白话导览定点语义修复器')) {
        semanticRepairCalls++;
        semanticRepairScoped = prompt.includes('R8P:C1:what') && prompt.includes('R8P:C1:why') && prompt.includes('R8P:C1:conclusion') &&
          !prompt.includes('R8P:C2:what');
        const card = retryGuide.cards.find(item => item.sectionId === 'C1');
        return JSON.stringify({ units: [
          { id: 'R8P:C1:what', text: '本章比较六向度，也就是从不同评价角度汇总双方表现。' },
          { id: 'R8P:C1:why', text: card.why },
          { id: 'R8P:C1:conclusion', text: card.conclusion }
        ] });
      }
      plainTranslateCalls++;
      return JSON.stringify({ units: retryGuide.cards.flatMap(card => [
        { id: 'R8P:' + card.sectionId + ':what', text: card.what },
        { id: 'R8P:' + card.sectionId + ':why', text: card.why },
        { id: 'R8P:' + card.sectionId + ':conclusion', text: card.conclusion }
      ]) });
    };
    let retryResult = null;
    let retryError = '';
    try {
      retryResult = await hn.applyReaderGuide(workDir, retrySnapshot, () => {}, { requestCompletion: retryResponse });
    } catch (e) { retryError = String(e.message); }
    const retryPlain = fs.existsSync(path.join(workDir, 'reader-guide-plain.json'))
      ? JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide-plain.json'), 'utf8')) : null;
    check('R8-P7 独立 reviewer 失败后只定点修失败卡；glossary 不再机械强塞固定括号',
      !retryError && retryResult && plainTranslateCalls === 1 && plainReviewCalls === 2 && semanticRepairCalls === 1 &&
        semanticRepairScoped && retryPlain &&
        retryPlain.cards[0].what.includes('也就是从不同评价角度') && !retryPlain.cards[0].what.includes('六向度（') &&
        RG.validatePlainGuideReview(retryInput, retryGuide, retryPlain).ok === true,
      JSON.stringify({ retryError, plainTranslateCalls, plainReviewCalls, semanticRepairCalls, semanticRepairScoped }));

    // W-T1 R8 #3 真实故障回归：跨 Job 恢复必须把私有 plain draft 当作冻结基底，
    // 第一笔模型请求就只修当前机械门点名字段；不得先重译整批 36 字段。
    const draftResumeSnapshot = { provider: 'codex-cli', model: 'draft-resume-test' };
    const draftResumeGuide = validGuide(retryInput, { modelSnapshot: draftResumeSnapshot });
    draftResumeGuide.cards.find(card => card.sectionId === 'C12').why = '判决与评分共用同一证据链。';
    const draftResumeReview = {
      approved: true,
      cardChecks: retryInput.sections.map(s => ({ sectionId: s.sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
    };
    for (const name of ['reader-guide-input.json','reader-guide.json','reader-guide-plain.json','reader-guide.html','.tmp-reader-guide-cache.json','.tmp-reader-guide-draft.json','.tmp-reader-guide-plain-draft.json']) fs.rmSync(path.join(workDir, name), { force: true });
    fs.writeFileSync(path.join(workDir, 'report.html'), regularRendered, 'utf8');
    fs.writeFileSync(path.join(workDir, 'report-plain.html'), '<html><body>既有白话报告</body></html>', 'utf8');
    fs.writeFileSync(path.join(workDir, '.tmp-reader-guide-cache.json'), JSON.stringify({
      key: RG.cacheKey(retryInput, draftResumeSnapshot),
      inputHash: RG.hashGuideInput(retryInput),
      guide: draftResumeGuide,
      review: draftResumeReview
    }, null, 2), 'utf8');
    const badDraftRows = draftResumeGuide.cards.flatMap(card => ['what','why','conclusion'].map(field => ({
      id: 'R8P:' + card.sectionId + ':' + field,
      text: card.sectionId === 'C12' && field === 'why' ? '判决与评分涉及九十九位评委。' : card[field] + '（白话）'
    })));
    const badDraftById = new Map(badDraftRows.map(row => [row.id, row.text]));
    const idsInPrompt = prompt => Array.from(new Set([...String(prompt || '').matchAll(/"id"\s*:\s*"(R8P:[^"]+)"/g)].map(match => match[1])));
    const oldDraftRetryDelay = core.retryDelayMs;
    core.retryDelayMs = () => 0;
    let draftCreateError = '';
    try {
      await hn.applyReaderGuide(workDir, draftResumeSnapshot, () => {}, { requestCompletion: async (_cfg, messages) => {
        const prompt = String(messages[0] && messages[0].content || '');
        const wanted = prompt.includes('R8 定点修复模式') ? idsInPrompt(prompt) : badDraftRows.map(row => row.id);
        return JSON.stringify({ units: wanted.map(id => ({ id, text: badDraftById.get(id) })) });
      } });
    } catch (e) { draftCreateError = String(e.message); }
    finally { core.retryDelayMs = oldDraftRetryDelay; }
    const draftCheckpointExists = fs.existsSync(path.join(workDir, '.tmp-reader-guide-plain-draft.json'));
    let resumeTranslateCalls = 0;
    let resumePromptScoped = false;
    let draftResumeError = '';
    let draftResumeResult = null;
    try {
      draftResumeResult = await hn.applyReaderGuide(workDir, draftResumeSnapshot, () => {}, { requestCompletion: async (_cfg, messages) => {
        const prompt = String(messages[0] && messages[0].content || '');
        if (prompt.includes('reader-guide-plain') && prompt.includes('独立语义复核器')) {
          return JSON.stringify({ approved: true, cardChecks: RG.SECTION_IDS.map(sectionId => ({
            sectionId, semanticEquivalent: true, noJudgmentChange: true, factsConsistent: true,
            zeroBackgroundReadable: true, naturalReadable: true, noLocatorDependency: true
          })) });
        }
        resumeTranslateCalls++;
        const wanted = idsInPrompt(prompt);
        resumePromptScoped = prompt.includes('R8 定点修复模式') && wanted.length === 1 && wanted[0] === 'R8P:C12:why' &&
          !prompt.includes('R8P:C12:what') && !prompt.includes('R8P:C12:conclusion') && !prompt.includes('R8P:C11:');
        return JSON.stringify({ units: [{ id: 'R8P:C12:why', text: '判决与评分共用同一证据链。（白话）' }] });
      } });
    } catch (e) { draftResumeError = String(e.message); }
    const resumedPlain = fs.existsSync(path.join(workDir, 'reader-guide-plain.json'))
      ? JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide-plain.json'), 'utf8')) : null;
    check('R8-P8 plain draft 跨 Job 续跑必须冻结其它 35 字段，首笔请求只定点修 C12 why',
      draftCreateError.includes('C12 why 事实声明无来源计数见证: 99/person') && draftCheckpointExists &&
        !draftResumeError && draftResumeResult && resumeTranslateCalls === 1 && resumePromptScoped && resumedPlain &&
        resumedPlain.cards.find(card => card.sectionId === 'C12').why === '判决与评分共用同一证据链。（白话）' &&
        !fs.existsSync(path.join(workDir, '.tmp-reader-guide-plain-draft.json')),
      JSON.stringify({ draftCreateError, draftCheckpointExists, draftResumeError, resumeTranslateCalls, resumePromptScoped }));

    // W-T1 R8 真实故障回归：原导览机械门失败时只允许定点修失败卡，其它卡冻结；预算耗尽仍 fail-close。
    const repairSnapshot = { provider: 'mock', model: 'r8-repair-test' };
    const invalidGuide = validGuide(retryInput, { modelSnapshot: repairSnapshot });
    invalidGuide.cards.find(card => card.sectionId === 'C5').what = '本章有 99 项关键判断。';
    const validC5 = validGuide(retryInput, { modelSnapshot: repairSnapshot }).cards.find(card => card.sectionId === 'C5');
    const cleanupR8 = () => {
      for (const name of ['reader-guide-input.json','reader-guide.json','reader-guide-plain.json','reader-guide.html','.tmp-reader-guide-cache.json','.tmp-reader-guide-draft.json']) fs.rmSync(path.join(workDir, name), { force: true });
      fs.writeFileSync(path.join(workDir, 'report.html'), regularRendered, 'utf8');
      fs.writeFileSync(path.join(workDir, 'report-plain.html'), '<html><body>既有白话报告</body></html>', 'utf8');
    };
    cleanupR8();
    let repairCalls = 0;
    let repairPromptScoped = false;
    const repairResponse = async (_cfg, messages, opts) => {
      repairCalls++;
      const prompt = String(messages[0] && messages[0].content || '');
      const system = String(opts && opts.system || '');
      if (prompt.includes('R8 章节导览定点修复')) {
        repairPromptScoped = prompt.includes('C5') && !prompt.includes('"sectionId":"C4"') && !prompt.includes('"sectionId":"C6"');
        return JSON.stringify({ cards: [validC5] });
      }
      if (system.includes('R8 章节导览白话层的独立语义复核器')) {
        return JSON.stringify({ approved: true, cardChecks: RG.SECTION_IDS.map(sectionId => ({
          sectionId, semanticEquivalent: true, noJudgmentChange: true, factsConsistent: true,
          zeroBackgroundReadable: true, naturalReadable: true, noLocatorDependency: true
        })) });
      }
      if (prompt.includes('\n\nreader-guide:\n')) {
        return JSON.stringify({ approved: true, cardChecks: RG.SECTION_IDS.map(sectionId => ({ sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true })) });
      }
      return JSON.stringify(invalidGuide);
    };
    let repairResult = null;
    let repairError = '';
    try {
      repairResult = await hn.applyReaderGuide(workDir, repairSnapshot, () => {}, { requestCompletion: repairResponse });
    } catch (e) { repairError = String(e.message); }
    const repairedGuide = fs.existsSync(path.join(workDir, 'reader-guide.json')) ? JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide.json'), 'utf8')) : null;
    const frozenIds = RG.SECTION_IDS.filter(id => id !== 'C5');
    check('R8 原导览机械门失败必须只定点修失败卡，冻结其余 11 卡并继续独立复核',
      !repairError && repairResult && repairCalls === 4 && repairPromptScoped && repairedGuide &&
        RG.validateGuide(retryInput, repairedGuide).ok === true &&
        frozenIds.every(id => RG.stableJson(repairedGuide.cards.find(card => card.sectionId === id)) === RG.stableJson(invalidGuide.cards.find(card => card.sectionId === id))) &&
        !fs.existsSync(path.join(workDir, '.tmp-reader-guide-draft.json')),
      JSON.stringify({ repairError, repairCalls, repairPromptScoped }));

    cleanupR8();
    const oldRetryDelay = core.retryDelayMs;
    core.retryDelayMs = () => 0;
    let exhaustedCalls = 0;
    let exhaustedError = '';
    try {
      await hn.applyReaderGuide(workDir, repairSnapshot, () => {}, { requestCompletion: async (_cfg, messages) => {
        exhaustedCalls++;
        const prompt = String(messages[0] && messages[0].content || '');
        if (prompt.includes('R8 章节导览定点修复')) return JSON.stringify({ cards: [invalidGuide.cards.find(card => card.sectionId === 'C5')] });
        return JSON.stringify(invalidGuide);
      } });
    } catch (e) { exhaustedError = String(e.message); }
    finally { core.retryDelayMs = oldRetryDelay; }
    const exhaustedReport = fs.readFileSync(path.join(workDir, 'report.html'), 'utf8');
    check('R8 原导览纠错预算耗尽必须 fail-close，并只保留私有 draft checkpoint',
      exhaustedError.includes('R8') && exhaustedCalls === core.MAX_RETRIES + 1 &&
        fs.existsSync(path.join(workDir, '.tmp-reader-guide-draft.json')) &&
        !fs.existsSync(path.join(workDir, 'reader-guide.json')) && !fs.existsSync(path.join(workDir, 'reader-guide-plain.json')) &&
        (exhaustedReport.match(/<!--R8_REPORT_GUIDE_START:C/g) || []).length === 0,
      JSON.stringify({ exhaustedError, exhaustedCalls }));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().then(() => {
  console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
  process.exit(failed === 0 ? 0 : 1);
});
