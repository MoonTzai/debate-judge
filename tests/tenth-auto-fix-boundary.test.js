'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const Module=require('module');
const ROOT=path.resolve(__dirname,'..');
const V9=path.resolve(ROOT,'..','SemanticFirst-E2E-V9-Production-Release-Candidate-20260917');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,isMain,options){
  if(parent&&parent.filename&&/^\.\.?[\\/]/.test(request)&&path.resolve(parent.filename).startsWith(ROOT+path.sep)){
    const local=path.resolve(path.dirname(parent.filename),request);
    const rel=path.relative(ROOT,local);
    if(!fs.existsSync(local)&&rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&fs.existsSync(path.join(V9,rel)))return path.join(V9,rel);
  }
  return resolve.call(this,request,parent,isMain,options);
};
const PC=require('../pipeline-controller.js');
const RT=require('../render-tables.js');

test('status presentation must not label a negative integrity result as a green pass',()=>{
  const input='| 项目 | 状态 |\n|---|---|\n| 证据校验 | 不通过 |\n';
  const rendered=RT.renderTable({attrs:'类型=integrity,列=项目|状态',body:input});
  assert.ok(!rendered.html.includes('🟢'),'negative status must never borrow the positive substring icon: '+rendered.html);
  assert.ok(rendered.html.includes('不通过'),'rendering must preserve the authored negative result');
});

test('exact status values keep their badges and unrestricted presentation prose is not forced into enums',()=>{
  for(const [status,expected]of [['通过','🟢 通过'],['不通过','🔴 不通过'],['警告','🟡 警告'],
    ['并非不通过','并非不通过'],['通过但仍有未核实条件','通过但仍有未核实条件'],['无警告不代表通过','无警告不代表通过']]){
    const rendered=RT.renderTable({attrs:'列=项目|状态',body:'| 项目 | 状态 |\n|---|---|\n| 一般记录 | '+status+' |\n'});
    assert.ok(rendered.html.includes('<td>'+expected+'</td>'),status+' must be faithfully rendered without choosing its semantic direction');
    assert.deepEqual(rendered.warnings,[],'free-text presentation is allowed, not a schema error');
  }
});

test('table representation repair retains authored unknown-value data rows',()=>{
  const input='| 已确认 | 待确认 |\n| --- | --- |\n| - | - |\n';
  const result=PC.autoFixTables(input);
  assert.ok(result.includes('\n| - | - |\n'), 'legal two-cell data row must not be swallowed into a separator: '+JSON.stringify(result));
  assert.equal(result.split('\n').length,input.split('\n').length,'repair must not erase row boundaries');
});

test('deletion control: existing renderer accepts legal separator variants without a normalization layer',()=>{
  const separators=['|---|---|','| --- | --- |','| :--- | ---: |','| :---: | :---: |',' | --- | --- | ','|-------|-----|','|\t---\t|\t---:\t|'];
  for(const separator of separators){
    const input='| 项目甲 | 项目乙 |\n'+separator+'\n| - | - |\n';
    const direct=RT.renderTable({attrs:'列=项目甲|项目乙',body:input});
    const throughCompatibility=RT.renderTable({attrs:'列=项目甲|项目乙',body:PC.autoFixTables(input)});
    assert.deepEqual(throughCompatibility,direct,'removing normalization must not require a replacement policy: '+separator);
    assert.equal((direct.html.match(/<td>-<\/td>/g)||[]).length,2);
    assert.deepEqual(direct.warnings,[]);
  }
});

test('presentation literal text, code fences, colspans and transport spelling remain unmodified',()=>{
  const fixtures=[
    '```text\n| - | : |\n```\n',
    '| 项目甲 | 项目乙 |\r\n| --- | --- |\r\n| - | - |\r\n',
    '<!--COLSPAN-->\n| 通宽标题 |\n|---|\n| 项目甲 | 项目乙 |\n|---|---|\n| - | - |\n',
    '| - | : |\n',
    '普通正文\n\n|---|---|\n\n后续正文'
  ];
  for(const input of fixtures)assert.equal(PC.autoFixTables(input),input);
});

test('deleting cosmetic normalization does not suppress the independent table pairing contract',()=>{
  const malformed='<!--TABLE:列=项目甲|项目乙-->\n| 项目甲 | 项目乙 |\n|---|---|\n| - | - |\n';
  assert.equal(PC.validateTablePairing(PC.autoFixTables(malformed)).passed,false);
  const valid=malformed+'<!--/TABLE-->\n';
  assert.equal(PC.validateTablePairing(PC.autoFixTables(valid)).passed,true);
});

test('S-marker compatibility seam cannot invent semantic section scope from orphan markers',()=>{
  const orphanEnd='这段文字尚未被任何 S15 边界授权。\n[S_END=S15]\n';
  const orphanStart='[S_START=S15]\n这段文字没有获授权的闭合边界。\n';
  const fenced='\`\`\`text\n[S_END=S15]\n\`\`\`\n';
  for(const input of [orphanEnd,orphanStart,fenced]){
    assert.equal(PC.autoFixSMarkers(input),input,'mechanical compatibility code must not manufacture section ownership');
  }
  const validation=PC.validate(orphanEnd,'R3',{final:false,newContract:false});
  assert.ok((validation.blocking||[]).some(row=>row&&row.rule==='F2'),
    'formal representation validation must still reject the orphan marker after auto-repair is removed');
});

test('valid S-marker representation remains byte-identical',()=>{
  const valid='[S_START=S15]\n### 结论\n<!--DATA: S15.COMPLETE=是 -->\n[S_END=S15]\n';
  assert.equal(PC.autoFixSMarkers(valid),valid);
});

test('structure ID normalization cannot edit literal evidence or citation prose',()=>{
  const evidence='原文记号“正方-1”和“M-正-1”并不声明它们就是同一对象。';
  const doc={meta:{schema_version:'v2'},items:[{m_id:'M-正-1',evidence,citation_basis:evidence}]};
  const parsed=PC.parseStructureJson(JSON.stringify(doc));
  assert.equal(parsed.items[0].evidence,evidence,'literal source evidence must survive representation parsing byte-for-byte');
  assert.equal(parsed.items[0].citation_basis,evidence,'citation prose must not be globally rewritten as an ID alias');
  assert.equal(parsed.items[0].m_id,'M-ZH-1','typed ID compatibility must remain available');
});

test('typed cross-format references remain compatible while nested literal evidence stays exact',()=>{
  const quote='证词保留 cp-3、反方-2 与 M-正-1 的原始写法。';
  const input={m_ids:['M-正-1','M-反-2','cp-3'],m_to_layer:[{m_id:'正方-2',layer:'L1'}],
    from_m:'m-zh-1',to_m:'反方-2',evidence:[{quote,m_id:'m-fa-2'},quote],citation_basis:quote};
  const output=PC.parseStructureJson(JSON.stringify(input));
  assert.deepEqual(output.m_ids,['M-ZH-1','M-FA-2','CP-3']);
  assert.equal(output.m_to_layer[0].m_id,'M-ZH-2');assert.equal(output.from_m,'M-ZH-1');assert.equal(output.to_m,'M-FA-2');
  assert.equal(output.evidence[0].quote,quote);assert.equal(output.evidence[1],quote);assert.equal(output.citation_basis,quote);
  assert.equal(output.evidence[0].m_id,'M-FA-2');
  assert.equal(input.m_ids[0],'M-正-1','parse must not mutate its source object');
});
