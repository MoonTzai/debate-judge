'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),test=require('node:test');
const H=require('../executor/host-node'),R=require('../render-report'),P=require('../pipeline-controller'),RG=require('../scripts/reader-guide'),core=require('../executor/core');
const SOURCE='正方一辩 原始姓名：理由 p 只适用于条件 d。\n\n反方二辩：尚未证明条件 d 在本情境成立。\n\n正方三辩：暂且接受这一不确定性，结论应限定于已经确认 d 的范围。';
function setup(){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'r8-semantic-flow-'));
 const tf='<!--DATA: S1.辩题=抽象方案适用范围 -->\n<!--DATA: S15.正方得分=4 -->\n<!--DATA: S15.反方得分=6 -->\n<!--DATA: S15.获胜方=反方 -->';
 const narrative=RG.SECTION_IDS.map(id=>'## '+id+' 标题\n<!--XP:本章说明-->\n<!--INSERT_'+id+'_MAIN-->\n只说明条件 d 的范围。\n<!--INSERT_'+id+'_MAIN-->').join('\n\n');
 const structure={meta:{schema_version:'v2'},layers:[]};
 for(const [f,t] of Object.entries({'transition-final.md':tf,'.tmp-adjudicated-data.md':tf,'叙事.md':narrative,'structure.json':JSON.stringify(structure),'.tmp-debate.txt':SOURCE})){fs.writeFileSync(path.join(d,f),t);}
 const html=R.renderHTML(R.normalizePhase1(tf,narrative),{structure});
 fs.writeFileSync(path.join(d,'report.html'),html);fs.writeFileSync(path.join(d,'report-plain.html'),html);
 return {d,html,input:H.buildReaderGuideInputFromWorkDir(d,RG,R,P,{}).input};
}
function guide(input,snapshot){
 const src=input.sharedSources[0];
 return {schemaVersion:RG.SCHEMA_VERSION,inputHash:RG.hashGuideInput(input),promptVersion:RG.PROMPT_VERSION,modelSnapshot:snapshot,cards:RG.SECTION_IDS.map(id=>({
 sectionId:id,what:'本章说明论证范围。',why:'帮助理解结论在什么条件下成立。',conclusion:'条件 d 的实际成立情况仍需核对。',
 evidence:[src.id,'R6:'+id],anchors:[{sourceId:src.id,speaker:'正方一辩 原始姓名',stage:src.anchor.stage,quote:'理由 p 只适用于条件 d。'}]
 }))};
}
function review(failed){
 return {approved:true,cardChecks:RG.SECTION_IDS.map(id=>({sectionId:id,noNewJudgment:true,factsConsistent:id!==failed,anchorsConsistent:true})),semanticIssues:[]};
}
function plainReview(){
 return {approved:true,cardChecks:RG.SECTION_IDS.map(sectionId=>({sectionId,semanticEquivalent:true,noJudgmentChange:true,factsConsistent:true,zeroBackgroundReadable:true,naturalReadable:true,noLocatorDependency:true}))};
}
test('原文进入生成/复核/定点修复；失败复核修正文稿后重新审，不反复投票',async()=>{
 const {d,html,input}=setup(),cfg={provider:'mock',model:'test-semantic-review'},initial=guide(input,cfg);
 initial.cards[4].conclusion='条件 d 对全部情形均已得到证明。';
 const calls=[],previousDelay=core.retryDelayMs;core.retryDelayMs=()=>0;
 let reviews=0,hasRaw=0;
 try{
  await H.applyReaderGuide(d,cfg,()=>{},{requestCompletion:async(_cfg,messages,opts)=>{
   const p=messages[0].content;calls.push((opts.system||'').includes('白话层的独立语义复核器')?'plain-review':p.includes('R8 章节导览定点修复')?'repair':p.includes('\n\nreader-guide:\n')?'review':'generate');
   if(p.includes(SOURCE.split('\n')[0]))hasRaw++;
   if(calls.at(-1)==='repair'){assert(p.includes('"sectionId":"C4"'));assert(p.includes('只重写点名失败卡'));const fixed=JSON.parse(JSON.stringify(initial.cards[4]));fixed.conclusion='条件 d 尚未普遍成立，只能作范围内判断。';return JSON.stringify({cards:[fixed]});}
   if(calls.at(-1)==='review'){reviews++;return JSON.stringify(review(reviews===1?'C5':null));}
   if(calls.at(-1)==='plain-review')return JSON.stringify(plainReview());
   return JSON.stringify(initial);
  }});
  assert.deepEqual(calls,['generate','review','repair','review','plain-review']);assert.equal(hasRaw,4);
  const saved=JSON.parse(fs.readFileSync(path.join(d,'reader-guide.json'),'utf8'));
  assert(saved.cards[4].conclusion.includes('只能作范围内'));assert.deepEqual(saved.cards.filter(c=>c.sectionId!=='C5'),initial.cards.filter(c=>c.sectionId!=='C5'));
  assert.equal(fs.readFileSync(path.join(d,'.tmp-debate.txt'),'utf8'),SOURCE);
  const after=fs.readFileSync(path.join(d,'report.html'),'utf8');assert.equal(R.stripEmbeddedReaderGuide(after).html,R.stripEmbeddedReaderGuide(html).html);
 }finally{core.retryDelayMs=previousDelay;fs.rmSync(d,{recursive:true,force:true});}
});
test('复核发现上游实质问题时保留问题和报告；不让导览改判或再次求批准',async()=>{
 const {d,html,input}=setup(),cfg={provider:'mock',model:'test-upstream'},g=guide(input,cfg);let calls=0;
 try{
  await assert.rejects(H.applyReaderGuide(d,cfg,()=>{},{requestCompletion:async()=>{calls++;return JSON.stringify(calls===1?g:{...review(),approved:false,semanticIssues:[{reason:'原始范围与上游全称结论冲突',sourceId:input.sharedSources[0].id,stage:'R3',action:'upstream_review',targetRound:'R3'}]});}}),/上游语义问题/);
  assert.equal(calls,2);assert.equal(fs.readFileSync(path.join(d,'report.html'),'utf8'),html);
  const issue=JSON.parse(fs.readFileSync(path.join(d,'.tmp-reader-guide-review.json'),'utf8'));assert.equal(issue.reopenNode,'R3');assert.equal(issue.review.semanticIssues.length,1);
  assert(!fs.existsSync(path.join(d,'reader-guide.json')));
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('语义定点修复失败后保存拒绝结果，不对未修改稿重新求通过',async()=>{
 const {d,html,input}=setup(),cfg={provider:'mock',model:'test-repair-failure'},g=guide(input,cfg);let calls=0;
 try{
  await assert.rejects(H.applyReaderGuide(d,cfg,()=>{},{requestCompletion:async()=>{calls++;if(calls===1)return JSON.stringify(g);if(calls===2)return JSON.stringify(review('C5'));throw Error('controlled repair failure');}}),/controlled repair failure/);
  assert.equal(calls,3);assert.equal(fs.readFileSync(path.join(d,'report.html'),'utf8'),html);
  assert(fs.existsSync(path.join(d,'.tmp-reader-guide-review.json')));
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});


test('普通备注由模型明确分类，不因字词或出现异议阻断，并保存到复核记录',async()=>{
 const {d,input}=setup(),cfg={provider:'mock',model:'test-note'},g=guide(input,cfg);let calls=0;
 const note={action:'note',sectionId:'C12',issue:'这里讨论了“上游语义错误”这个措辞，但语境为附注，不否定来源与导览。'};
 try{
  await H.applyReaderGuide(d,cfg,()=>{},{requestCompletion:async(_cfg,messages)=>{
   calls++;const p=messages[0].content;
   if(p.includes('reader-guide-plain')&&p.includes('semanticEquivalent'))return JSON.stringify(plainReview());
   if(p.includes('\n\nreader-guide:\n'))return JSON.stringify({...review(),semanticIssues:[note]});
   return JSON.stringify(g);
  }});
  assert(fs.existsSync(path.join(d,'reader-guide.json')));
  const proof=JSON.parse(fs.readFileSync(path.join(d,'.tmp-reader-guide-review.json'),'utf8'));
  assert.equal(proof.disposition,'accepted_with_notes');assert.equal(proof.reopenNode,null);
  assert.deepEqual(proof.review.semanticIssues,[note]);assert.equal(calls,3);
  await H.applyReaderGuide(d,cfg,()=>{},{requestCompletion:async()=>{throw Error('cache should suffice');}});
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('approved=true 不能抹去实质异议；回查模型所指R5B而非硬编码R3，且不谎报预算耗尽',async()=>{
 const {d,html,input}=setup(),cfg={provider:'mock',model:'test-target'},g=guide(input,cfg);let calls=0;
 try{
  await assert.rejects(H.applyReaderGuide(d,cfg,()=>{},{requestCompletion:async()=>{
   calls++;return JSON.stringify(calls===1?g:{...review(),semanticIssues:[{action:'upstream_review',targetRound:'R5B',issue:'报告叙事遗漏了原裁决的必要条件，影响结论的实际范围。'}]});
  }}),e=>/上游语义回查待处理/.test(e.message)&&!/预算耗尽/.test(e.message));
  assert.equal(calls,2);const proof=JSON.parse(fs.readFileSync(path.join(d,'.tmp-reader-guide-review.json'),'utf8'));
  assert.equal(proof.reopenNode,'R5B');assert.deepEqual(proof.reopenNodes,['R5B']);
  assert.equal(fs.readFileSync(path.join(d,'report.html'),'utf8'),html);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('缺少异议处置只请求补充说明，不由程序猜语义或擅自指定R3',async()=>{
 const {d,input}=setup(),cfg={provider:'mock',model:'test-clarify'},g=guide(input,cfg);let reviews=0;
 const previousDelay=core.retryDelayMs;core.retryDelayMs=()=>0;
 try{
  await H.applyReaderGuide(d,cfg,()=>{},{requestCompletion:async(_cfg,messages)=>{
   const p=messages[0].content;
   if(p.includes('reader-guide-plain')&&p.includes('semanticEquivalent'))return JSON.stringify(plainReview());
   if(p.includes('\n\nreader-guide:\n')){
    reviews++;
    if(reviews===2){assert(p.includes('上一版复核：'));assert(p.includes('保留已有实质判断'));}
    return JSON.stringify({...review(),semanticIssues:[{issue:'工作分工文字的所指需说明',...(reviews===1?{}:{action:'note'})}]});
   }
   return JSON.stringify(g);
  }});
  assert.equal(reviews,2);assert(fs.existsSync(path.join(d,'reader-guide.json')));
 }finally{core.retryDelayMs=previousDelay;fs.rmSync(d,{recursive:true,force:true});}
});
