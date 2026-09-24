'use strict';
// Synthetic, content-independent cases; none of these examples enters runtime prompts.
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os');
const PL=require('../scripts/plain-language'),PV=require('../scripts/plain-comprehension');
const H=require('../executor/host-node');
let passed=0;
const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
function unitsAt(messages){const text=messages[0].content;const after=text.split('输入单元（JSON）：\n')[1];let i=after.indexOf('}');for(;i>=0;i=after.indexOf('}',i+1)){try{return JSON.parse(after.slice(0,i+1)).units;}catch{}}throw Error('missing units');}
function idsAt(messages){return JSON.parse(messages[0].content.match(/targetIds=(\[[^\n]*\])/)[1]);}
async function main(){
 const html='<html><body><section id="c2"><h2>C2 判断理由</h2><p class="in">根据 N1，<strong>局部完成</strong>并不表示整体获胜。</p><p class="in">比分 4:6，区别来自其余比较。</p><table><thead><tr><th>主张</th><th>回应效力</th></tr></thead><tr><td>方案甲</td><td>这一回应只削弱必要条件。</td></tr></table><p>成长建议：应交代适用条件。</p><p class="wn">反方胜（4:6）</p></section></body></html>';
 const all=PL.extractUnits(PL.parseHtml(html)), units=all.filter(u=>PL.classifyUnit(u)==='translate');
 const group=units.filter(u=>u.containerTag==='p').slice(0,3);
 check('真实段落身份、排版语境与片段连读',()=>{assert(group.every(u=>u.semanticBlockId===group[0].semanticBlockId));assert.notEqual(group[0].semanticBlockId,units.find(u=>u.text.startsWith('比分')).semanticBlockId);assert.equal(group[0].readingContext.originalText,'根据 N1，局部完成并不表示整体获胜。');assert.deepEqual(group[1].inlineTags,['strong']);});
 check('比分正文/结构标记正文/表头/关键解释块可译，纯结果保留',()=>{for(const text of ['比分 4:6，区别来自其余比较。','成长建议：应交代适用条件。','回应效力'])assert(units.some(u=>u.text===text));assert(!units.some(u=>u.text==='反方胜（4:6）'));assert.equal(PL.classifyUnit({text:'理由包含比分 4:6，但胜负不能仅靠局部完成。',containerClasses:'po'}),'translate');});
 check('表格保留行与表头语境，邻段只读',()=>{const u=units.find(u=>u.text.includes('必要条件'));assert.deepEqual(u.readingContext.tableHeaders,['主张','回应效力']);assert.deepEqual(u.readingContext.tableRow,['方案甲','这一回应只削弱必要条件。']);assert(group[0].readingContext.next.includes('比分'));});
 const transformed=await PL.processReportAsync(html,{strictIdentity:false,translateUnits:us=>new Map(us.map(u=>[u.id,u.id===group[0].id?'根据 N1，这一处回应虽然成立，':u.id===group[1].id?'':u.id===group[2].id?'却还不能说明全场获胜。':u.text]))});
 check('空片段保留位置，后段无错位，元素结构不变',()=>{assert.equal(PL.structureDiff(PL.parseHtml(html),PL.parseHtml(transformed.html)),null);const aligned=PL.alignedPlainUnits(html,transformed.html);assert.equal(aligned.find(u=>u.id===group[1].id).text,' ');assert.equal(aligned.find(u=>u.text.startsWith('比分')).id,all.find(u=>u.text.startsWith('比分')).id);assert(PL.compareVersions(html,transformed.html).ok);assert(PL.mergePlainIntoOriginal(html,transformed.html).includes('data-plain='));});
 check('修复展开完整段落而不误扩相同 class 邻段',()=>assert.deepEqual(PV.expandSemanticBlockIds(units,[group[1].id]),group.map(u=>u.id)));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpt6-plain-context-'));
 try {
  let calls=0;const requests=[];
  const responder=async(_cfg,messages)=>{calls++;const batch=unitsAt(messages);requests.push(batch);return JSON.stringify({units:batch.map(u=>({id:u.id,text:u.id===group[0].id?'':u.id===group[1].id?'根据 N1，这一处回应成立':u.text}))});};
  const cfg={provider:'custom',model:'offline-fixture',baseUrl:'http://127.0.0.1'};
  const results=await H.translateUnitsLLM(cfg,units,()=>{},{},{cacheDir:dir,requestCompletion:responder});
  check('生成器收到完整块，定位码可在同段槽位间移动',()=>{assert(requests.some(batch=>group.every(u=>batch.some(x=>x.id===u.id))));assert.equal(results.get(group[0].id),'');});
  const initialCalls=calls;await H.translateUnitsLLM(cfg,units,()=>{},{},{cacheDir:dir,requestCompletion:responder});
  check('同源上下文 draft 缓存命中 0 调用',()=>assert.equal(calls,initialCalls));
  const drift=units.map(u=>({...u,readingContext:u.readingContext?{...u.readingContext,previous:'上下文发生实际变化'}:undefined}));
  await H.translateUnitsLLM(cfg,drift,()=>{},{},{cacheDir:dir,requestCompletion:responder});
  check('源文相同而上下文变化必须使缓存失效',()=>assert(calls>initialCalls));
  let phase=0;const scope=[];const originalMap=new Map(units.map(u=>[u.id,u.text]));
  const reviewed=await H.reviewPlainUnits(cfg,units,originalMap,()=>{},{},{requestCompletion:async(_cfg,messages)=>{
    const ids=idsAt(messages);scope.push(ids);
    if(phase++===0)return JSON.stringify({approved:false,checkedIds:ids,issues:[{id:group[1].id,codes:['zeroBackgroundReadable'],message:'请按整句解释这处成立为何不足以决定全场。'}]});
    if(phase===2)return JSON.stringify({units:ids.map(id=>({id,text:id===group[0].id?'根据 N1，这一处回应虽然成立，':id===group[1].id?'': '却还不足以决定全场。'}))});
    return JSON.stringify({approved:true,checkedIds:ids,issues:[]});
  }});
  check('独立复核失败→整段修复→整段复审，无关段字节冻结',()=>{assert.deepEqual(scope[1],group.map(u=>u.id));assert.deepEqual(scope[2],group.map(u=>u.id));for(const u of units.filter(u=>!group.includes(u)))assert.equal(reviewed.results.get(u.id),u.text);});
  let emptyError='';try{await H.reviewPlainUnits(cfg,group,new Map(group.map(u=>[u.id,''])),()=>{},{},{});}catch(e){emptyError=e.message;}
  check('整段丢空被拦截，无元数据的 R8 字段仍独立检查',()=>{assert(emptyError.includes('empty'));assert(!PV.inspectPlainText('本字段有内容','',{profile:PV.PROFILE_GUIDE}).ok);});
  const many=Array.from({length:45},(_,i)=>({id:'x'+i,text:'片段'+i,semanticBlockId:'single-long-paragraph'}));let batches=[];
  await H.translateUnitsLLM(cfg,many,()=>{},{},{requestCompletion:async(_cfg,messages)=>{const items=unitsAt(messages);batches.push(items);return JSON.stringify({units:items});}});
  check('超过 40 片段的单段不被配额拆分',()=>assert.equal(batches.length,1));
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
 console.log('ALL PASS '+passed);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
