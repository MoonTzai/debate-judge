'use strict';

const RG = require('../scripts/reader-guide.js');

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
}

const MODULES = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
  const id = 'C' + (i + 1);
  const prose = id === 'C8'
    ? '双方各4象限被对方锁定、各2/2对角闭环、无假价值，修辞格局呈对称全线受压。意义感维度双开各+0.5，胜负取决于谁能把因向驱力收束成贯通自由与规律的一方。'
    : id + ' 的章节事实。';
  return [id, { xp: id + ' 解释', slots: { ['INSERT_' + id + '_MAIN']: prose }, prose, pre: '', raw: '' }];
}));

const normalized = {
  data: {
    'S1.辩题': '美是客观存在还是主观感受',
    'S1.正方人数': 4,
    'S1.反方人数': 4,
    'S1.正方轮次': 4,
    'S13.正方人数': 4,
    'S13.反方人数': 4,
    'S11.类型': '1b',
    'S15.正方得分': 4,
    'S15.反方得分': 6,
    'S15.获胜方': '反方',
    'C8.判准校准.正方.意义感加权': '+0.5',
    'C8.判准校准.反方.意义感加权': '+0.5'
  },
  modules: MODULES
};
const structure = { meta: { schema_version: 'v2' }, layers: [{ id: 'N1', label: '结构性交锋', side: '反方' }] };
const SPEECH = [
  '**关键CP逐回合轨迹**',
  '',
  '| CP-ID | 回合 | 发言方 | 动作 | 该点临时状态 | 辩词引用 |',
  '|---|---|---|---|---|---|',
  '| CP-3 | 1 | 反二 | 攻击 | 被削弱 | “美从来就不是物质的客观属性。” |',
  '| CP-3 | 2 | 正三 | 回应 | 被击穿 | “美感不同不等于对象没有美。” |',
  '| CP-6 | 1 | 反三 | 攻击 | 被削弱 | “没有审美主体时，美如何成立？” |',
  '| CP-6 | 2 | 正四 | 回应 | 被击穿 | “对象的性质仍然存在。” |',
  '',
  '### 推理链'
].join('\n');

function anchorsFor(section) {
  const anchors = (section.sources || []).filter(source => /^SPEECH:/.test(source.id));
  return section.sectionId === 'C3' || section.sectionId === 'C7' ? anchors : anchors.slice(0, 1);
}
function evidenceWithAnchor(section, ids) {
  return Array.from(new Set((ids || []).concat(anchorsFor(section).map(a => a.id))));
}

const input = RG.buildGuideInput(normalized, structure, null, SPEECH);
const guide = {
  schemaVersion: RG.SCHEMA_VERSION,
  inputHash: RG.hashGuideInput(input),
  promptVersion: RG.PROMPT_VERSION,
  modelSnapshot: { provider: 'test', model: 'test' },
  cards: input.sections.map(section => {
    const anchors = anchorsFor(section);
    const card = {
      sectionId: section.sectionId,
      what: '本章说明这一部分在整份报告中检查什么。',
      why: '它帮助读者理解为什么这一部分会影响整体判断。',
      conclusion: '本章结论以已选来源为准。',
      evidence: evidenceWithAnchor(section, [section.sources[0].id]),
      anchors: anchors.map(a => ({ sourceId: a.id, speaker: a.anchor.speaker, stage: a.anchor.stage, quote: a.anchor.quote }))
    };
    if (section.sectionId === 'C8') {
      const weights = section.sources.filter(source => /^DATA:C8\.判准校准\.(?:正方|反方)\.意义感加权$/.test(source.id)).map(source => source.id);
      card.what = '本章分析双方修辞驱动力来源与对抗格局，并给出逻辑弥合方向与判准校准信号。';
      card.why = '双方各4象限被对方锁定、各2/2对角闭环、无假价值，修辞格局呈对称全线受压。';
      card.conclusion = '意义感维度双开各+0.5，胜负取决于谁能把因向驱力收束成贯通自由与规律的一方。';
      card.evidence = evidenceWithAnchor(section, [section.sources[0].id].concat(weights));
    }
    return card;
  })
};

const guideCheck = RG.validateGuide(input, guide);
check('C8-F1 原 guide 在 +0.5 权重来源下必须有效', guideCheck.ok, JSON.stringify(guideCheck.errors));

function plainWithC8(conclusionOverride) {
  return {
    schemaVersion: RG.PLAIN_SCHEMA_VERSION,
    sourceGuideHash: RG.hashPlainGuideSource(guide),
    promptVersion: RG.PLAIN_PROMPT_VERSION,
    modelSnapshot: { provider: 'test', model: 'plain' },
    cards: guide.cards.map(card => {
      if (card.sectionId !== 'C8') return {
        sectionId: card.sectionId,
        what: card.what + '（白话）',
        why: card.why + '（白话）',
        conclusion: card.conclusion + '（白话）'
      };
      return {
        sectionId: 'C8',
        what: '本卡分析双方的修辞驱动力，也就是他们说服人、推动立场的力量来自哪里；分析双方对抗格局如何；并给出逻辑上补缺口的方向，以及用来校准判断标准的信号。',
        why: '在报告画出的四象限格局里——也就是把双方修辞驱动力分成四个方向来对照——双方各有 4 个象限被对方锁定，也就是这些方向被对方封住或压制；双方还各有 2/2 的对角闭环，即在对角方向上形成封闭对应关系，2/2 是报告对这类闭环数量的标记；并且没有假价值，也就是没有只停在口号、未落实到具体事实和因果的价值判断。整体修辞格局是双方对称地全线受压。',
        conclusion: conclusionOverride || '在“意义感”这个维度上，双方都打开、各得 +0.5，也就是双方在这个维度上各拿到 +0.5 分；胜负取决于谁能把“因向驱力”——也就是从原因往结果解释的推动力——收束成一个能贯通自由与规律的结论，也就是把自由和规律两方面连起来的结论。'
      };
    })
  };
}

const actualRepair = plainWithC8();
const actualCheck = RG.validatePlainGuide(input, guide, actualRepair);
check('C8-F2 真实 repair 对 4 / 2/2 / +0.5 的自然复述应通过 R8 机械与事实门',
  actualCheck.ok,
  JSON.stringify(actualCheck.errors));
check('C8-F3 +0.5 分不得被小数尾巴误判成 5/score',
  !actualCheck.errors.some(e => e.includes('5/score')),
  JSON.stringify(actualCheck.errors));

const changedValue = plainWithC8('在“意义感”这个维度上，双方各得 +0.6 分；胜负取决于谁能把因向驱力收束成贯通自由与规律的结论。');
const changedCheck = RG.validatePlainGuide(input, guide, changedValue);
check('C8-F4 把 +0.5 改成 +0.6 必须被事实/identity 门拒绝',
  !changedCheck.ok && changedCheck.errors.some(e => /0\.6|protected-token-drift|无来源计数见证/.test(e)),
  JSON.stringify(changedCheck.errors));

const prompt = RG.buildPlainGuideRepairPrompt(guide, actualRepair, {
  approved: false,
  cardChecks: guide.cards.map(card => ({
    sectionId: card.sectionId,
    semanticEquivalent: true,
    noJudgmentChange: true,
    factsConsistent: true,
    zeroBackgroundReadable: card.sectionId !== 'C8',
    naturalReadable: true,
    noLocatorDependency: true
  }))
}, ['C8']);
check('C8-F5 R8 repair prompt 明确允许复述同一已存在数值，但禁止引入新值/改关系',
  prompt.includes('可以复述原卡已经存在的同一数值') &&
  prompt.includes('不得引入原卡没有的新数值') &&
  prompt.includes('数值对应主体/单位/关系'),
  prompt.slice(0, 1800));


const baseReview = {
  approved: true,
  cardChecks: guide.cards.map(card => ({
    sectionId: card.sectionId,
    noNewJudgment: true,
    factsConsistent: true,
    anchorsConsistent: true
  }))
};
const noteReview = JSON.parse(JSON.stringify(baseReview));
noteReview.semanticIssues = [{ action: 'note', issue: '这只是导览范围备注，不改变上游报告事实。' }];
const noteCheck = RG.validateReview(input, guide, noteReview);
check('C8-U1 普通 note 不阻断 R8，且被保留为 notes',
  noteCheck.ok && noteCheck.notes.length === 1 && noteCheck.upstreamIssues.length === 0,
  JSON.stringify(noteCheck));

const upstreamReview = JSON.parse(JSON.stringify(baseReview));
upstreamReview.semanticIssues = [{ action: 'upstream_review', targetRound: 'R4.5', issue: '导览发现上游裁决范围与当前证据关系存在实质冲突。' }];
const upstreamCheck = RG.validateReview(input, guide, upstreamReview);
check('C8-U2 approved=true 不能抹掉 upstream_review；必须保留责任轮并 fail-close',
  !upstreamCheck.ok && upstreamCheck.upstreamIssues.length === 1 &&
    upstreamCheck.reopenNodes.join(',') === 'R4.5' &&
    upstreamCheck.errors.some(e => e.includes('上游语义问题')),
  JSON.stringify(upstreamCheck));

const unclassifiedReview = JSON.parse(JSON.stringify(baseReview));
unclassifiedReview.semanticIssues = [{ issue: '这里有异议，但尚未说明是备注还是上游实质问题。' }];
const unclassifiedCheck = RG.validateReview(input, guide, unclassifiedReview);
check('C8-U3 未分类异议只能要求补分类，程序不得猜责任轮',
  !unclassifiedCheck.ok && unclassifiedCheck.needsClarification === true &&
    unclassifiedCheck.reopenNodes.length === 0,
  JSON.stringify(unclassifiedCheck));

const reviewPrompt = RG.buildReviewPrompt(input, guide);
check('C8-U4 reviewer prompt 明确 note/upstream_review 分工，且禁止 approved=true 消除上游异议',
  reviewPrompt.includes('action=upstream_review') &&
    reviewPrompt.includes('action=note') &&
    reviewPrompt.includes('approved=true 不能消除 upstream_review') &&
    reviewPrompt.includes('最早相关 targetRound'),
  reviewPrompt.slice(0, 1800));

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
