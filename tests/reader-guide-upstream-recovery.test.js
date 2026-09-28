'use strict';
// Abstract controlled responses verify orchestration, not actual LLM quality.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const H = require('../executor/host-node'), PC = require('../pipeline-controller');
const RG = require('../scripts/reader-guide'), RR = require('../render-report');
const S = require('../executor/sc-original-integration');
const source = '正方一辩 甲：理由 p 在条件 d 下支持 q。\n反方一辩 乙：需要确认条件 d。\n正方二辩 丙：结论仅限已经确认 d 的范围。';
const issue = {action:'upstream_review',targetRound:'R6',message:'同一理由在明细中是重要，在汇总中变成致命，需核实是否有后续修订。'};
const check = () => ({approved:true,cardChecks:RG.SECTION_IDS.map(sectionId=>({sectionId,noNewJudgment:true,factsConsistent:true,anchorsConsistent:true})),semanticIssues:[]});
const pending = () => ({inputHash:'saved-original-input',review:{...check(),semanticIssues:[issue]}});
const decision = action => ({decisions:[{issueIndex:0,action,...(action==='reopen'?{targetRound:'R1'}:{}),reason:'复核原文与登记后发现，后续实际作用没有同步到逐项说明。',impact:'核对同一判断的最终重要性及其评分解释，不预设胜负。'}]});
const cfg = {provider:'mock',model:'recovery-flow-test'};
function setup(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'judge-260925.040000-test-'));
  fs.writeFileSync(path.join(d,'.tmp-debate.txt'),source);
  PC.runAll(path.join(d,'.tmp-debate.txt'),{outputDir:d});
  return d;
}
function read(d,n){return JSON.parse(fs.readFileSync(path.join(d,n),'utf8'));}
function guide(d){
  const input=H.buildReaderGuideInputFromWorkDir(d,RG,RR,PC,{}).input;
  return {cards:RG.SECTION_IDS.map(sectionId=>({sectionId,what:'本章说明结论的适用范围。',why:'帮助理解条件的作用。',conclusion:'理由只在给定条件下成立。',evidence:['R6:'+sectionId],anchors:[],anchorNote:'依据本章及完整原文，不作直接引文。'}))};
}
const plainReview=()=>({approved:true,cardChecks:RG.SECTION_IDS.map(sectionId=>({sectionId,semanticEquivalent:true,noJudgmentChange:true,factsConsistent:true,zeroBackgroundReadable:true,naturalReadable:true,noLocatorDependency:true}))});
const quiet=()=>{};

test('责任定位按语义处置逐项说明，发现于R6不强制回R6；自然语言理由无关键词门',()=>{
  const r=pending().review;
  assert.equal(RG.validateUpstreamResolution(r,decision('reopen')).targetRound,'R1');
  assert.equal(RG.validateUpstreamResolution(r,decision('note')).targetRound,null);
  assert.equal(RG.validateUpstreamResolution(r,decision('unresolved')).unresolved.length,1);
  assert.throws(()=>RG.validateUpstreamResolution(r,{decisions:[]}));
  assert.throws(()=>RG.validateUpstreamResolution(r,{decisions:[{...decision('reopen').decisions[0],targetRound:'R6'}]}));
  assert(RG.buildUpstreamReviewPrompt(r,{'.tmp-debate.txt':source}).includes(source.split('\n')[0]));
});

test('现有和已升级 prompt 都使用最终判断；允许初始权重被语义修订',()=>{
  for(const rn of ['1','3','4.5','5']){
    const p=PC.buildRoundPrompt(PC.loadRoundPrompt(rn),rn,source,''), twice=S.adaptPrompt(p,rn);
    assert(!p.includes('权重从S3引用'));assert(p.includes('CLASH_FINAL_ASSESSMENT_V1'));
    assert(twice.includes('CLASH_FINAL_ASSESSMENT_V1'));
    assert.equal((twice.match(/<!--CLASH_FINAL_ASSESSMENT_V1-->/g)||[]).length,1);
    assert(p.includes('可以修订初始权重'));assert(p.includes('计数仅用于核对表达'));
  }
});

test('旧会话异议从R6重新定位到R1；新版规则回查并重建下游，保留完整旧稿',async()=>{
  const d=setup(),calls=[],rounds=[];
  try{
    fs.writeFileSync(path.join(d,'P1.md'),'旧登记与汇总有未解决分歧');
    fs.writeFileSync(path.join(d,'report.html'),'<p>旧版完整报告</p>');
    fs.writeFileSync(path.join(d,'.tmp-reader-guide-review.json'),JSON.stringify(pending()));
    fs.writeFileSync(path.join(d,'.analysis-pristine-prompts.json'),JSON.stringify({'.tmp-R1-prompt.md':'OLD_EXECUTABLE_PROMPT'}));
    const options={workDir:d,cfg,plain:false,onLog:quiet,onRound:r=>rounds.push(r),
      requestCompletion:async(_c,m)=>{calls.push(m[0].content);return JSON.stringify(decision('reopen'));},
      mockResponder:m=>{calls.push(m[0].content);return H.goodMockResponder(m);}};
    const result=await H.runPipeline(options);assert(result.ok,JSON.stringify(result.results));
    const recovery=read(d,'.analysis-review.json');
    assert.equal(recovery.state,'awaiting-guide');assert.equal(recovery.targetRound,'R1');
    assert.equal(recovery.previousFiles['report.html'],'<p>旧版完整报告</p>');
    assert.equal(recovery.previousFiles['P1.md'],'旧登记与汇总有未解决分歧');
    assert.equal(fs.readFileSync(path.join(d,'.tmp-debate.txt'),'utf8'),source);
    assert(result.results.some(r=>r.round==='R1'&&r.ok&&!r.skipped));
    assert(calls.some(p=>p.includes('本次上游回查')&&p.includes('CLASH_FINAL_ASSESSMENT_V1')));
    assert(!calls.some(p=>p.includes('OLD_EXECUTABLE_PROMPT')));
    H.renderReport(d);
    let reviewed=false;
    await H.applyReaderGuide(d,cfg,quiet,{requestCompletion:async(_c,m)=>{
      const p=m[0].content;
      if(p.includes('reader-guide-plain')&&p.includes('semanticEquivalent'))return JSON.stringify(plainReview());
      if(p.includes('\n\nreader-guide:\n')){reviewed=true;assert(p.includes('已执行的定点回查'));return JSON.stringify(check());}
      return JSON.stringify(guide(d));
    }});
    assert(reviewed);assert.equal(read(d,'.analysis-review.json').state,'resolved');
    assert(fs.existsSync(path.join(d,'reader-guide.html')));
    await H.applyReaderGuide(d,cfg,quiet,{requestCompletion:async()=>{throw Error('approved cache must suffice');}});
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('回查后异议仍成立：保留原异议和新异议，重复续跑不会反复求批准',async()=>{
  const d=setup();let calls=0;
  try{
    const result=await H.runPipeline({workDir:d,cfg,mockResponder:H.goodMockResponder,onLog:quiet});assert(result.ok);
    H.renderReport(d);
    fs.writeFileSync(path.join(d,'.analysis-review.json'),JSON.stringify({origin:'R8',state:'awaiting-guide',originalReview:pending().review,resolution:decision('reopen'),previousFiles:{}}));
    await assert.rejects(H.applyReaderGuide(d,cfg,quiet,{requestCompletion:async(_c,m)=>{
      calls++;return JSON.stringify(m[0].content.includes('\n\nreader-guide:\n')?pending().review:guide(d));
    }}),e=>e.code==='R8_UPSTREAM_REVIEW');
    assert.equal(read(d,'.analysis-review.json').state,'blocked');
    const stopped=await H.runPipeline({workDir:d,cfg,onLog:quiet,requestCompletion:async()=>{calls++;throw Error('must not re-vote');}});
    assert.equal(stopped.ok,false);assert.equal(calls,2);
    assert.equal(read(d,'.analysis-review.json').originalReview.semanticIssues[0].message,issue.message);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('网络中断后继续责任定位；已取得处置不重复付费；真实不确定不能强制放行',async()=>{
  const d=setup();let calls=0;
  try{
    fs.writeFileSync(path.join(d,'.tmp-reader-guide-review.json'),JSON.stringify(pending()));
    await assert.rejects(H.prepareReaderGuideRecovery(d,cfg,quiet,{requestCompletion:async()=>{calls++;throw Error('controlled network interruption');}}),/controlled/);
    assert.equal(read(d,'.analysis-review.json').state,'routing');
    await assert.rejects(H.prepareReaderGuideRecovery(d,cfg,quiet,{requestCompletion:async()=>{calls++;return JSON.stringify(decision('unresolved'));}}),e=>e.code==='R8_UPSTREAM_REVIEW');
    assert.equal(read(d,'.analysis-review.json').state,'blocked');
    await H.prepareReaderGuideRecovery(d,cfg,quiet,{requestCompletion:async()=>{calls++;throw Error('must not repeat');}});
    assert.equal(calls,2);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('备注处置也先提交断点；提交中断恢复时复用已取得的解释',async()=>{
  const d=setup();let calls=0,checkpoints=0;
  try{
    fs.writeFileSync(path.join(d,'.tmp-reader-guide-review.json'),JSON.stringify(pending()));
    const opts={requestCompletion:async()=>{calls++;return JSON.stringify(decision('note'));},
      onAnalysisReviewCheckpoint:async()=>{checkpoints++;if(checkpoints===2)throw Error('controlled checkpoint interruption');}};
    await assert.rejects(H.prepareReaderGuideRecovery(d,cfg,quiet,opts),/checkpoint interruption/);
    assert.equal(read(d,'.analysis-review.json').resolution.decisions[0].action,'note');
    await H.prepareReaderGuideRecovery(d,cfg,quiet,{requestCompletion:async()=>{throw Error('must reuse saved decision');}});
    assert.equal(calls,1);assert.equal(read(d,'.analysis-review.json').state,'awaiting-guide');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
