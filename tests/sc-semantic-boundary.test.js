'use strict';
// Run: node tests/sc-semantic-boundary.test.js
// Synthetic inputs exercise interpretation boundaries, not debate-specific answers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RR = require('../render-report.js');
const V = require('../executor/validator.js');
const C = require('../executor/contract.js');
const RG = require('../scripts/reader-guide.js');
const P = require('../scripts/plain-comprehension.js');
let failed = 0, total = 0;
function test(name, run) { total++; try { run(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function cp(content, extra) { return Object.assign({ id: 'CP-1', content, verdict: '正方胜（重要）', who: '正方', weight: '重要', pen: '高', oldContract: true }, extra); }
test('未明确作用环的旧 CP 不由题域名词猜测', () => {
  for (const content of ['特性依赖环境', '性能依赖环境']) {
    const x = RR.heuristicAttackMap([cp(content)]);
    assert.equal(x.con.A_B0.length + x.con.B0_C.length, 0);
    assert.equal(x.unmapped.length, 1);
  }
});
test('明确作用环按声明消费，不解析靶心中的否定或题域', () => {
  const x = RR.heuristicAttackMap([cp('p 的作用发生变化', { oldContract: false, target: '不是类比，而是核心主张', ring: 'B0→C', attackedSide: '反方', attackResult: '被削弱' })]);
  assert.equal(x.con.B0_C.length, 1);
  assert.equal(x.con.A_B0.length, 0);
});
test('状态不剥否定或限定，准确单值仍可读', () => {
  assert.equal(RR.normalizeStatus('不充分'), null);
  assert.equal(RR.normalizeStatus('充分（仅限子问题）'), null);
  assert.equal(RR.normalizeStatus(' 充分 '), '充分');
});
test('矩阵不把无法归类的状态算作充分，不删原句', () => {
  const md = '[S_START=S2]\n### 正方\n| 层级 | 支撑环节 | 作用环 | 状态 |\n| --- | --- | --- | --- |\n| 正方分论点 | p | A→B0 | 不充分 |\n[S_END=S2]';
  const data = {}; for (const side of ['正方','反方']) for (const st of ['充分','初步','未论证','被击穿']) data['S2.'+side+'.论证完成度.'+st]=0;
  const errors=[]; V.checkCompletionMatrix(md,data,errors);
  assert(!errors.some(x=>x.severity==='BLOCKING' && /充分=1/.test(x.message)));
  const parsed=RR.parseArrowStatusFromS2(md);
  assert.equal(parsed.counts.A_B0.pro[0],0);
  assert(RR.buildC5V2Ui(parsed.rows,md).includes('不充分'));
});
test('C5 净状态由范围明确的语义判断提供，不按致命计数改判', () => {
  const rows=[{side:'pro',label:'理由 p',ring:'A→B0',a:0,b:null}];
  const raw='<!--DATA: S2.正方.A_B0.自证状态=充分 -->\n<!--DATA: S2.正方.A_B0.判据=本范围内理由成立 -->\n<!--DATA: S10.C5.正方.A_B0.净状态=初步 -->\n<!--DATA: S10.C5.正方.A_B0.判据=回应留下条件缺口 -->';
  const html=RR.buildC5V2Ui(rows,raw);
  assert(html.includes('回应留下条件缺口')); assert(html.includes('初步')); assert(!html.includes('关键词反推'));
});
for (const reason of ['并非偷换外延；该范围有独立根据','偷换外延']) test('发现辩手缺陷不等于运行无效：'+reason,()=>{
  const e=[];V.checkC1_C7({'S8.PhaseIII.④外延漂移.检查完成':'是','S8.PhaseIII.④外延漂移信号':'有：范围变化','S8.PhaseIII.④外延漂移.合理性':reason},e,{});
  assert(!e.some(x=>x.rule==='C10b'&&x.severity==='BLOCKING'));
  assert(e.some(x=>x.rule==='C10b'&&x.severity==='WARNING'));
});
function adjudication(reason) {return {schema_version:'0.1.0',conflicts:[{conflict_id:'CF-001',dimension:'S11↔structure类型',pair:['S11.类型=1a','structure.s11_original_type=1c'],adjudicated:'reject',paradigm:'semantic_fit',reason,confidence:'高',reviewed_by:'R4.5'}],authoritative:{'S11.类型':'1a'}};}
test('裁决理由不因否定多数/投票或简短而阻断',()=>{
  assert(C.validateAdjudication(adjudication('不能靠多数或投票裁决；此处按原文桥接关系判断。'),{}).passed);
  assert(C.validateAdjudication(adjudication('结构未保留原文的条件限定。'),{}).passed);
  assert(!C.validateAdjudication(adjudication(''),{}).passed);
  const bad=adjudication('结构未保留原文的条件限定。');bad.authoritative['secret.unowned']='x';
  assert(!C.validateAdjudication(bad,{}).passed);
});
const modules=Object.fromEntries(RG.SECTION_IDS.map(id=>[id,{prose:'解释当前章节的论证关系。'}]));
const norm={modules,data:{'S15.获胜方':'反方','S15.正方得分':4,'S15.反方得分':6}};
const trajectory='| CP-ID | 回合 | 发言方 | 动作 | 该点临时状态 | 辩词引用 |\n| --- | --- | --- | --- | --- | --- |\n| CP-1 | 1 | 正方 | 攻击 | 未定 | p支持q |\n| CP-2 | 4 | 反方 | 追加回应 | 被削弱 | p只在d下支持q |';
function guide(input) {
 return {schemaVersion:RG.SCHEMA_VERSION,promptVersion:RG.PROMPT_VERSION,inputHash:RG.hashGuideInput(input),modelSnapshot:{},cards:input.sections.map(s=>({
 sectionId:s.sectionId,what:'本章讨论当前论证。',why:'说明判断依据。',conclusion:'并不代表正方获胜。',
 evidence:[s.sources[0].id,'DATA:S15.获胜方'].filter(id=>(s.sources||[]).some(x=>x.id===id)),
 anchors:[],anchorNote:'本卡概括本章判断，具体引文请参阅本章正文。'
 }))};
}
test('R8 不强制同 CP 攻击/回应，追加回应及跨 CP 不丢失',()=>{
 const i=RG.buildGuideInput(norm,null,null,trajectory);
 const c3=i.sections.find(s=>s.sectionId==='C3');
 assert(c3.sources.concat(i.sharedSources).some(s=>s.id==='SPEECH:CP-2:4'));
});
test('R8 完整原文单份共享，没有预登记 CP 的段落仍可选',()=>{
 const raw='正方：p支持q。\n\n反方：p在d下有不同作用。\n\n没有登记编号的后续说明。';
 const i=RG.buildGuideInput(norm,null,null,trajectory,raw);
 assert(i.sharedSources.some(s=>s.text.includes('没有登记编号')));
 const wire=JSON.stringify(i);assert.equal(wire.split('没有登记编号').length-1,1);
 const g=guide(i);const source=i.sharedSources.find(s=>s.text.includes('没有登记编号'));
 g.cards[2].evidence.push(source.id);
 g.cards[2].anchors=[{sourceId:source.id,speaker:'原文未标注发言者',stage:source.anchor.stage,quote:'没有登记编号的后续说明。'}];
 assert(RG.validateGuide(i,g).ok,JSON.stringify(RG.validateGuide(i,g).errors));
 g.cards[2].anchors[0].quote='原文没有说过的另一句话。';
 assert(!RG.validateGuide(i,g).ok);
});
test('R8 正文否定不被机械当成胜负结论；独立复核不可跳过',()=>{
 const i=RG.buildGuideInput(norm,null,null,trajectory);const g=guide(i);
 assert(RG.validateGuide(i,g).ok,JSON.stringify(RG.validateGuide(i,g).errors));
 assert(!RG.validateReview(i,g,null).ok);
 const review={approved:false,cardChecks:RG.SECTION_IDS.map(sectionId=>({sectionId,noNewJudgment:true,factsConsistent:false,anchorsConsistent:true}))};
 assert(!RG.validateReview(i,g,review).ok);
});
test('PLAIN 轮次数字等价与定位码重复次数不是语义门',()=>{
 assert(P.inspectPlainText('说明第2轮回应。','说明第二轮回应。').ok);
 assert(P.inspectPlainText('CP-1 是定位，CP-1 的理由已在邻句说明。','CP-1 是定位，理由已在邻句说明。').ok);
 assert(!P.inspectPlainText('依据 CP-1。','依据 CP-9。').ok);
});
test('PLAIN 自由正文数字变化必须进入语义复核线索',()=>{
 const r=P.inspectPlainText('比分为4:6。','比分为6:4。');
 assert((r.warnings||[]).length>0 || !r.ok);
 assert(!P.validateReadabilityReview({approved:false,checkedIds:['u'],issues:[{id:'u',codes:['semanticEquivalent'],message:'比分方向改变'}]},['u']).ok);
});
test('固定提示种子无真实比赛教学及机械阈值压力',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../Skill-Judge.md'),'utf8').split('<!-- PIPELINE_CONTROLLER_START -->')[0];
 for (const literal of ['陈瑞华','樊登','樊　登','郭宇宽','陈政鞃','陈勋亮','胡渐彪','西安交通大学','美是客观存在','补足至≥5个','单 CP 回合数≤3','守住 为终态','按真价值标准直接零分']) assert(!text.includes(literal),literal);
});
console.log(JSON.stringify({total,failed})); process.exitCode=failed?1:0;

