'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const os=require('os');const Module=require('module');
const ROOT=path.resolve(__dirname,'..');const V9=path.resolve(ROOT,'..','SemanticFirst-E2E-V9-Production-Release-Candidate-20260917');
const original=Module._resolveFilename;
Module._resolveFilename=function(request,parent,isMain,options){
  if(parent&&parent.filename&&/^\.\.?[\\/]/.test(request)&&path.resolve(parent.filename).startsWith(ROOT+path.sep)){
    const local=path.resolve(path.dirname(parent.filename),request),rel=path.relative(ROOT,local);
    if(!fs.existsSync(local)&&rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&fs.existsSync(path.join(V9,rel)))return path.join(V9,rel);
  }
  return original.call(this,request,parent,isMain,options);
};
globalThis.fetch=async()=>{throw new Error('TENTH_ZERO_MODEL_NETWORK_FORBIDDEN');};
const Host=require('../executor/host-node.js');const API=require('../executor/api-provider.js');
async function fixture(t){
  const workDir=fs.mkdtempSync(path.join(os.tmpdir(),'judge-tenth-reopen-'));t.after(()=>fs.rmSync(workDir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：公共图书馆周末开放有助于服务轮班劳动者。\n反方：我承认可达性重要，但运营预算必须可持续。');
  const state={fault:null,ordinal:0,calls:0};
  const opts={cfg:{provider:'mock',model:'mock'},semanticFirstMode:'active',mockResponder:Host.goodMockResponder,
    apiStub:async(cfg,messages,options)=>{
      assert.equal(cfg.provider,'mock');state.calls++;if(state.fault)state.ordinal++;
      if(state.fault==='crash-before-review'&&state.ordinal===1)throw new Error('synthetic process interruption after durable issue');
      const response=await API.requestCompletion(cfg,messages,options);
      if(!state.fault)return response;
      if(state.fault==='incomplete-review'&&state.ordinal===1)return {...response,completion_status:'incomplete'};
      if(state.scAuthority&&state.fault==='fidelity-reject'&&state.ordinal===1){
        const doc=JSON.parse(response.text);doc.decision='revise';doc.reason='synthetic reviewed replacement without inventory changes';doc.authority=state.scAuthority;
        return {...response,text:JSON.stringify(doc)};
      }
      if(['reject','unresolved','maintain'].includes(state.fault)&&state.ordinal===1){
        const doc=JSON.parse(response.text);doc.decision=state.fault;doc.reason='synthetic independent terminal review';
        return {...response,text:JSON.stringify(doc)};
      }
      if(state.fault==='fidelity-reject'&&state.ordinal===3){
        const doc=JSON.parse(response.text);doc.decision='reject';doc.reason='synthetic projection-fidelity rejection';doc.issues=['projection does not preserve the reviewed proposition'];
        return {...response,text:JSON.stringify(doc)};
      }
      return response;
    }};
  const prepared=await Host.prepareTestSemanticAuthority(workDir,opts);
  return {workDir,state,opts,prepared};
}
for(const fault of ['crash-before-review','incomplete-review','reject','unresolved','fidelity-reject']){
  test('global reopen failure atomicity and exact retry disposition: '+fault,async t=>{
    const f=await fixture(t);const before=f.prepared.active.store.readCurrent(f.prepared.active.sessionId);
    const request={expectedRevision:before.revision,issue:'核对预算条件是否在比较中被遗漏：'+fault,evidence:[]};
    f.state.fault=fault;f.state.ordinal=0;
    let outcome=null;let thrown=null;
    try{outcome=await Host.publishTestR3Reopen(f.workDir,f.prepared,request,f.opts);}catch(e){thrown=e;}
    assert.ok(thrown||(outcome&&outcome.published===false),'challenged projection must not gain authority on failure');
    assert.deepEqual(f.prepared.active.store.readCurrent(f.prepared.active.sessionId),before,'current and semantic identity are failure atomic');
    const fingerprints=Host.collectPersistedReopenFingerprints(f.prepared.active.store,f.prepared.active.sessionId,'global');
    const fingerprint=Host.semanticReopenRequestFingerprint('global',request);
    assert.equal(fingerprints.has(fingerprint),fault==='reject'||fault==='unresolved','only a completed terminal review may consume the challenge identity');
    const resumed=await Host.prepareTestSemanticAuthority(f.workDir,{...f.opts,apiStub:async()=>{throw new Error('resume must not call a model');}});
    assert.equal(resumed.reused,true);assert.equal(resumed.current.revision,before.revision);
    if(fault!=='reject'&&fault!=='unresolved'){
      f.state.fault=null;
      const retry=await Host.publishTestR3Reopen(f.workDir,f.prepared,request,f.opts);
      assert.equal(retry.published,true,'a crash or failed projection must not permanently lock the semantic challenge');
    }
  });
}

for(const fault of ['crash-before-review','incomplete-review','maintain','reject','unresolved','fidelity-reject']){
  test('SC reopen failure atomicity and exact retry disposition: '+fault,async t=>{
    const f=await fixture(t);
    const sc=await Host.prepareTestScAuthority(f.workDir,f.prepared,f.opts);
    const sessionId='test-sc-current';
    const before=sc.store.readCurrent(sessionId);
    f.state.scAuthority=JSON.parse(sc.store.readObject(before.semanticRef).content);
    f.state.fault=fault;f.state.ordinal=0;
    const request={expectedRevision:before.revision,issue:'SC 依赖范围需要独立复核：'+fault,evidence:[]};
    // This suite exercises SC failure atomicity, not execution-class promotion.
    // Keep the exact same explicit mock execution class so cross-class authority
    // reuse is tested only by the dedicated control-plane regression.
    const options={...f.opts};
    let outcome=null;let thrown=null;
    try{outcome=await Host.publishTestScReopen(f.workDir,f.prepared,sc,request,options);}catch(e){thrown=e;}
    assert.ok(thrown||(outcome&&outcome.published===false));
    assert.deepEqual(sc.store.readCurrent(sessionId),before);
    const fingerprints=Host.collectPersistedReopenFingerprints(sc.store,sessionId,'sc');
    assert.equal(fingerprints.has(Host.semanticReopenRequestFingerprint('sc',request)),['maintain','reject','unresolved'].includes(fault));
    const resumed=await Host.prepareTestScAuthority(f.workDir,f.prepared,{...f.opts,apiStub:async()=>{throw new Error('SC resume must not call a model');}});
    assert.equal(resumed.reused,true);assert.equal(resumed.current.revision,before.revision);
    if(!['maintain','reject','unresolved'].includes(fault)){
      f.state.fault=null;const calls=f.state.calls;
      const retry=await Host.publishTestScReopen(f.workDir,f.prepared,sc,request,options);
      assert.equal(retry.published,false);assert.equal(f.state.calls,calls+1,'retry must reach the independent reviewer exactly once');
    }
  });
}

test('direct SC reopen proves global and SC execution classes before calls or CAS',async t=>{
  const f=await fixture(t);
  const sc=await Host.prepareTestScAuthority(f.workDir,f.prepared,f.opts);
  const sessionId='test-sc-current';
  const before=sc.store.readCurrent(sessionId);
  const scAuthority=JSON.parse(sc.store.readObject(before.semanticRef).content);
  const forgedGlobal={...f.prepared,executionClass:'non-mock',
    provenance:{...f.prepared.provenance,executionClass:'non-mock'}};
  const forgedSc={...sc,executionClass:'non-mock',
    provenance:{...sc.provenance,executionClass:'non-mock'}};
  let calls=0;
  const nonmockStub=async(_cfg,messages)=>{
    calls++;
    let text=Host.goodMockResponder(messages);
    if(calls===1){
      const doc=JSON.parse(text);
      doc.decision='revise';
      doc.reason='synthetic same-inventory review used only to reach the publication seam';
      doc.authority=scAuthority;
      text=JSON.stringify(doc);
    }
    return {text,completion_status:'verified_complete',completion_evidence:{synthetic_zero_model:true}};
  };
  await assert.rejects(
    Host.publishTestScReopen(f.workDir,forgedGlobal,forgedSc,{
      expectedRevision:before.revision,
      issue:'direct SC helper must not trust caller-mutable execution class',
      evidence:[]
    },{
      cfg:{provider:'openai',model:'synthetic-nonmock'},
      apiStub:nonmockStub
    }),
    e=>e&&e.code==='ERR_TEST_EXECUTION_CLASS_MISMATCH'
  );
  assert.equal(calls,0,'mixed execution class must fail before independent SC review');
  assert.deepEqual(sc.store.readCurrent(sessionId),before,'mixed execution class must fail before SC CAS');
});

test('global rev3 recovers from provenance exactly one revision behind without model calls',async t=>{
  const f=await fixture(t);
  const r2=await Host.publishTestR3Reopen(f.workDir,f.prepared,{
    expectedRevision:1,
    issue:'first bounded review before crash-window reconstruction',
    evidence:[]
  },f.opts);
  assert.equal(r2.published,true);
  assert.equal(r2.current.revision,2);

  let firstRecoveryCalls=0;
  const p2=await Host.prepareTestSemanticAuthority(f.workDir,{
    ...f.opts,
    apiStub:async()=>{firstRecoveryCalls++;throw new Error('rev2 recovery must not call a model');}
  });
  assert.equal(p2.recovered,true);
  assert.equal(p2.recoveredFromRevision,1);
  assert.equal(p2.current.revision,2);
  assert.equal(firstRecoveryCalls,0);

  const r3=await Host.publishTestR3Reopen(f.workDir,p2,{
    expectedRevision:2,
    issue:'second bounded review leaves current one revision ahead of provenance',
    evidence:[]
  },f.opts);
  assert.equal(r3.published,true);
  assert.equal(r3.current.revision,3);
  const stale=Host.readTestProvenance(f.workDir);
  assert.equal(stale.authority.revision,2,'fixture must model CAS/current rev3 with durable provenance still at rev2');

  let finalRecoveryCalls=0;
  const p3=await Host.prepareTestSemanticAuthority(f.workDir,{
    ...f.opts,
    apiStub:async()=>{finalRecoveryCalls++;throw new Error('rev3 recovery must not call a model');}
  });
  assert.equal(p3.recovered,true);
  assert.equal(p3.recoveredFromRevision,2);
  assert.equal(p3.current.revision,3);
  assert.equal(finalRecoveryCalls,0);
  assert.equal(Host.readTestProvenance(f.workDir).authority.revision,3);
});

test('global recovery rejects mixed execution class hidden in a historical reopen project receipt',async t=>{
  const f=await fixture(t);
  const r2=await Host.publishTestR3Reopen(f.workDir,f.prepared,{
    expectedRevision:1,
    issue:'first revision for historical execution-class attack',
    evidence:[]
  },f.opts);
  assert.equal(r2.published,true);
  const p2=await Host.prepareTestSemanticAuthority(f.workDir,{
    ...f.opts,
    apiStub:async()=>{throw new Error('rev2 recovery must be zero-call');}
  });
  assert.equal(p2.current.revision,2);
  const r3=await Host.publishTestR3Reopen(f.workDir,p2,{
    expectedRevision:2,
    issue:'second revision makes rev2 project receipt historical',
    evidence:[]
  },f.opts);
  assert.equal(r3.published,true);
  assert.equal(r3.current.revision,3);

  const stale=Host.readTestProvenance(f.workDir);
  assert.equal(stale.authority.revision,2);
  const rev2Row=stale.reopens.find(x=>x&&x.newRevision===2);
  assert.ok(rev2Row&&rev2Row.commitRef);
  const commitDoc=JSON.parse(p2.active.store.readObject(rev2Row.commitRef).content);
  const projection=p2.active.store.readObject(commitDoc.projectionRef);
  const rawRef=projection.metadata.rawRef;
  assert.ok(rawRef&&rawRef.metadataPath);
  const metaPath=path.join(f.workDir,'.semantic-first-production-v1',...rawRef.metadataPath.split('/'));
  const metaDoc=JSON.parse(fs.readFileSync(metaPath,'utf8'));
  assert.equal(metaDoc.metadata.configRef.provider,'mock');
  metaDoc.metadata.configRef={...metaDoc.metadata.configRef,provider:'openai',model:'forged-historical-nonmock'};
  fs.writeFileSync(metaPath,JSON.stringify(metaDoc,null,2)+'\n','utf8');

  let calls=0;
  await assert.rejects(
    Host.prepareTestSemanticAuthority(f.workDir,{
      ...f.opts,
      apiStub:async()=>{calls++;throw new Error('mixed historical class must fail before model calls');}
    }),
    e=>e&&(e.code==='ERR_TEST_SEMANTIC_RECOVERY_REQUIRED'||e.code==='ERR_TEST_EXECUTION_CLASS_MISMATCH')
  );
  assert.equal(calls,0);
});

test('revision five global authority resumes with immutable ancestry and zero synthetic calls',async t=>{
  const f=await fixture(t);let prepared=f.prepared;
  for(let index=0;index<4;index++){
    const request={expectedRevision:prepared.current.revision,issue:'独立的具体复核控制项 '+index,evidence:[]};
    const before=prepared.active.store.readCurrent(prepared.active.sessionId);
    const result=await Host.publishTestR3Reopen(f.workDir,prepared,request,f.opts);
    assert.equal(result.published,true);
    const provenance=Host.buildTestProvenance(prepared.active,result.publication,result.consumerBinding,prepared.provenance,{semanticIdentityPreserved:true});
    provenance.reopens.push({status:'published',requestedRevision:request.expectedRevision,oldRevision:before.revision,newRevision:result.current.revision,
      issue:request.issue,evidence:request.evidence,issueRef:result.publication.refs.reopenIssueRef,reviewRef:result.publication.refs.reviewRef,
      fidelityRef:result.publication.refs.fidelityRef,commitRef:result.publication.refs.commitRef||null});
    Host.validateTestProvenance(f.workDir,prepared.active,result.current,provenance);Host.writeTestProvenance(f.workDir,provenance);
    prepared={...prepared,current:result.current,consumerBinding:result.consumerBinding,publication:result.publication,provenance};
  }
  assert.equal(prepared.current.revision,5);
  const resumed=await Host.prepareTestSemanticAuthority(f.workDir,{...f.opts,apiStub:async()=>{throw new Error('revision-five resume must be zero model');}});
  assert.equal(resumed.current.revision,5);assert.equal(resumed.reused,true);
});

test('duplicate control identity ignores reason/order while genuinely different issues and scope remain reviewable',()=>{
  const one={expectedRevision:3,issue:'预算限定是否被遗漏',evidence:[{quote:'甲',reason:'first'},{quote:'乙',reason:'second'}]};
  const equivalent={...one,evidence:[{quote:'乙',reason:'other'},{quote:'甲',reason:'changed'}]};
  const global=Host.semanticReopenRequestFingerprint('global',one);
  assert.equal(Host.semanticReopenRequestFingerprint('global',equivalent),global);
  assert.notEqual(Host.semanticReopenRequestFingerprint('global',{...one,issue:'可达性限定是否被遗漏'}),global);
  assert.notEqual(Host.semanticReopenRequestFingerprint('sc',one),global);
  assert.ok(Host.duplicateReopenProjectionGate('global',equivalent,new Set([global])));
  assert.equal(Host.duplicateReopenProjectionGate('global',null,new Set([global])),null,'legitimate projection rewrite without repeated challenge must remain available');
});

test('blocked R3 projection invalidation preserves upstream P1/P2/P2.5',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'judge-tenth-invalidation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['P1.md','P2.md','P2.5.md','P3.md','transition-final.md','structure.json','adjudication.json','report.html'])fs.writeFileSync(path.join(dir,name),'synthetic '+name);
  Host.invalidateBlockedR3Projection(dir);
  for(const name of ['P1.md','P2.md','P2.5.md'])assert.equal(fs.readFileSync(path.join(dir,name),'utf8'),'synthetic '+name);
  assert.equal(fs.existsSync(path.join(dir,'P3.md')),false);
  assert.equal(fs.existsSync(path.join(dir,'report.html')),false);
});
