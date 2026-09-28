'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const RG = require('../scripts/reader-guide');
const snapshot = {provider:'mock',model:'envelope-test'};
const input = {
  schemaVersion:RG.SCHEMA_VERSION, sourceMode:'original', reportMode:'rendered-report',
  sharedSources:[{id:'SPEECH:RAW:1',text:'发言者甲：若条件 d 成立，理由 p 才能支持结论 q。',anchor:{speaker:'未标注',stage:'原文段落 1'}}],
  sections:RG.SECTION_IDS.map(sectionId=>({sectionId,sources:[{id:'R6:'+sectionId,text:'本章保留条件 d。'}]}))
};
const cards = () => RG.SECTION_IDS.map(sectionId=>({
  sectionId,what:'本章讨论论证的适用范围。',why:'帮助判断结论的条件。',conclusion:'不能省略条件 d。',
  evidence:['R6:'+sectionId],anchors:[{sourceId:'SPEECH:RAW:1',speaker:'发言者甲',stage:'原文段落 1',quote:'若条件 d 成立，理由 p 才能支持结论 q。'}]
}));
function legacyDraft(guide){
  const inputHash=RG.hashGuideInput(input);
  const key=crypto.createHash('sha256').update(RG.stableJson({inputHash,promptVersion:'r8-reader-guide-prompt-v4',modelSnapshot:snapshot,schemaVersion:RG.SCHEMA_VERSION})).digest('hex');
  return {v:1,key,inputHash,guide};
}
test('当前响应的运行元数据由宿主生成；语义内容不改；已保存产物仍严格检查',()=>{
  const response={cards:cards(),inputHash:'sha256:mis-copied',promptVersion:'wrong',schemaVersion:'wrong',modelSnapshot:{model:'invented'}};
  const before=JSON.stringify(response);
  const g=RG.bindGuideResponse(input,response,snapshot);
  assert(RG.validateGuide(input,g).ok);assert.deepEqual(g.cards,response.cards);assert.equal(JSON.stringify(response),before);
  assert.equal(g.inputHash,RG.hashGuideInput(input));assert.deepEqual(g.modelSnapshot,snapshot);
  assert(!RG.validateGuide(input,{...g,inputHash:'bad'}).ok);
  assert(!RG.validateGuide(input,{...g,promptVersion:'r8-reader-guide-prompt-v4'}).ok);
  assert(!RG.validateGuide(input,RG.bindGuideResponse(input,{...response,verdict:'unexpected'},snapshot)).ok);
  assert.throws(()=>RG.bindGuideResponse(input,[],snapshot));
  const prompt=RG.buildGuidePrompt(input,snapshot);assert(!prompt.includes(RG.hashGuideInput(input)));assert(prompt.includes('只输出 JSON：{"cards"'));
});
test('单独锚点引用有效；不存在的来源、伪造引文和错误位置仍拒绝',()=>{
  const g=RG.bindGuideResponse(input,{cards:cards()},snapshot);assert(RG.validateGuide(input,g).ok);
  for(const [field,value] of [['sourceId','SPEECH:RAW:absent'],['quote','不在原文中的句子'],['stage','错误位置']]){
    const broken=structuredClone(g);broken.cards[0].anchors[0][field]=value;assert(!RG.validateGuide(input,broken).ok,field);
  }
  const broken=structuredClone(g);broken.cards[0].evidence.push('DATA:not-an-input');assert(!RG.validateGuide(input,broken).ok);
});
test('正文超过 240 字只提示；原导览和白话导览均可进入独立语义复核',()=>{
  const g=RG.bindGuideResponse(input,{cards:cards()},snapshot);g.cards[0].why='需要保留条件，避免改变判断的适用范围。'.repeat(18);
  const check=RG.validateGuide(input,g);assert(check.ok);assert(check.warnings.some(x=>x.includes('较长')));
  const plain={schemaVersion:RG.PLAIN_SCHEMA_VERSION,sourceGuideHash:RG.hashPlainGuideSource(g),promptVersion:RG.PLAIN_PROMPT_VERSION,modelSnapshot:snapshot,cards:g.cards.map(({sectionId,what,why,conclusion})=>({sectionId,what,why,conclusion}))};
  assert(RG.validatePlainGuide(input,g,plain).ok);
  const rejected={approved:false,cardChecks:RG.SECTION_IDS.map(sectionId=>({sectionId,noNewJudgment:true,factsConsistent:sectionId!=='C1',anchorsConsistent:true}))};
  assert(!RG.validateReview(input,g,rejected).ok);
  g.cards[0].why='  ';assert(!RG.validateGuide(input,g).ok);
});
test('旧私有草稿只在外层来源键完全相符时迁移，不继承任何复核批准',()=>{
  const saved=legacyDraft({cards:cards(),inputHash:'bad'});const before=JSON.stringify(saved);
  const restored=RG.restoreGuideDraft(input,snapshot,saved);
  assert(restored.migrated);assert(RG.validateGuide(input,restored.guide).ok);assert.equal(restored.review,undefined);assert.equal(JSON.stringify(saved),before);
  assert.equal(RG.restoreGuideDraft(input,{...snapshot,model:'other'},saved),null);
  const changed=structuredClone(input);changed.sections[0].sources[0].text+='上游已改变';
  assert.equal(RG.restoreGuideDraft(changed,snapshot,saved),null);
  assert.equal(RG.restoreGuideDraft(input,snapshot,{...saved,key:'bad'}),null);
  assert.equal(RG.restoreGuideDraft(input,snapshot,{...saved,inputHash:'bad'}),null);
  // No outer v/key binding means an imported guide cannot use this path.
  assert.equal(RG.restoreGuideDraft(input,snapshot,restored.guide),null);
});
