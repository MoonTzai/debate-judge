'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const Module=require('module');
const crypto=require('crypto');
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const ROOT=path.resolve(__dirname,'..');
const V9=path.resolve(ROOT,'..','SemanticFirst-E2E-V9-Production-Release-Candidate-20260917');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,isMain,options){
  if(parent&&parent.filename&&/^\.\.?[\\/]/.test(request)&&path.resolve(parent.filename).startsWith(ROOT+path.sep)){
    const local=path.resolve(path.dirname(parent.filename),request);const rel=path.relative(ROOT,local);
    if(!fs.existsSync(local)&&rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&fs.existsSync(path.join(V9,rel)))return path.join(V9,rel);
  }
  return resolve.call(this,request,parent,isMain,options);
};
// All provider-labelled cases below use an explicit synthetic function. Real network is forbidden.
globalThis.fetch=async()=>{throw new Error('TENTH_ZERO_MODEL_NETWORK_FORBIDDEN');};
const Host=require('../executor/host-node.js');
const PC=require('../pipeline-controller.js');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'judge-tenth-control-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('real provider cannot use a mock-only validation switch to publish an unreviewed R3 winner',async t=>{
  const workDir=temp(t);let calls=0;
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方主张保留夜间服务。\n反方提出财政压力。');
  fs.writeFileSync(path.join(workDir,'.tmp-R3-prompt.md'),'synthetic projection request; no live model');
  const opts={workDir,round:{name:'R3',promptFile:'.tmp-R3-prompt.md',outFile:'P3.md'},
    cfg:{provider:'openai',model:'synthetic-transport-only'},semanticFirstMode:'active',realValidate:false,force:true,onLog:()=>{},
    activeSemanticAuthorityText:'SEMANTIC-FIRST ACTIVE AUTHORITY\nroute: PRODUCTION_ACTIVE\nreviewed net favors affirmative',
    globalReviewDecision:{decision:'maintain',net:{review_direction:'affirmative'}},
    apiStub:async()=>{calls++;return '[S_START=S15]\n<!--DATA: S15.获胜方=反方 -->\n[S_END=S15]\n';}};
  let error=null;let result=null;
  try{result=await Host.runRound(opts);}catch(e){error=e;}
  if(!error)console.log('REAL_VALIDATE_BYPASS_OBSERVED:'+JSON.stringify({result,calls,winner:PC.extractDataMarkers(fs.readFileSync(path.join(workDir,'P3.md'),'utf8'))['S15.获胜方']}));
  assert.equal(error&&error.code,'ERR_REAL_VALIDATION_REQUIRED','non-mock execution must reject the relaxed switch before publishing projection bytes');
  assert.equal(calls,0,'configuration mismatch must fail before even the synthetic transport');
  assert.equal(fs.existsSync(path.join(workDir,'P3.md')),false);
});

test('pipeline entry cannot bypass the same active real validation policy',async t=>{
  for(const provider of ['openai','anthropic','codex-cli','auto']){
    const workDir=temp(t);let calls=0;
    await assert.rejects(Host.runPipeline({workDir,cfg:{provider},semanticFirstMode:'active',realValidate:false,
      apiStub:async()=>{calls++;throw new Error('must not reach synthetic model');},onLog:()=>{}}),
      e=>e.code==='ERR_REAL_VALIDATION_REQUIRED');
    assert.equal(calls,0);assert.deepEqual(fs.readdirSync(workDir),[]);
  }
});

test('host-fresh source control cannot be replaced while semantic review is awaiting a response',async t=>{
  const workDir=temp(t);let calls=0;let replaced=false;let injectedSha=null;
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：博物馆夜间开放能改善劳动者的可达性。\n反方：我反对忽略夜间运营的额外成本。');
  let failure=null;
  try {await Host.runPipeline({workDir,cfg:{provider:'mock',model:'mock'},semanticFirstMode:'active',onLog:()=>{},
    mockResponder:messages=>{
      calls++;
      const anchorPath=path.join(workDir,'source-anchor.json');
      if(!replaced&&fs.existsSync(anchorPath)){
        const anchor=JSON.parse(fs.readFileSync(anchorPath,'utf8'));
        anchor.rosterHash='archive-substitution-not-verified-this-run';anchor.disclaimer=false;
        const bytes=JSON.stringify(anchor,null,2);fs.writeFileSync(anchorPath,bytes);injectedSha=sha(bytes);replaced=true;
      }
      return Host.goodMockResponder(messages);
    }});
  }catch(e){failure=e;}
  assert.equal(replaced,true,'attack must occur inside the real active pipeline after host extraction');
  assert.ok(calls>0,'exercise asynchronous semantic preparation, not only a source helper');
  const provenance=Host.readTestProvenance(workDir);
  const boundSha=provenance&&provenance.consumerBinding&&provenance.consumerBinding.views&&provenance.consumerBinding.views.sourceAnchor&&provenance.consumerBinding.views.sourceAnchor.sha256;
  console.log('CONTROL_REBIND_OBSERVED:'+JSON.stringify({calls,boundSha,injectedSha,error:failure&&failure.code}));
  assert.notEqual(boundSha,injectedSha,'a historical/substituted control file must not borrow the earlier fresh boolean and acquire current view authority');
  assert.equal(failure&&failure.code,'ERR_FRESH_CONTROL_IDENTITY');
  // A failed control publication is not a semantic rollback or a permanent lock.
  // A new normal run must freshly extract control bytes and reuse verified current.
  const revision=provenance&&provenance.revision;let resumedCalls=0;
  await Host.runPipeline({workDir,cfg:{provider:'mock',model:'mock'},semanticFirstMode:'active',onLog:()=>{},
    mockResponder:messages=>{resumedCalls++;return Host.goodMockResponder(messages);}});
  const resumed=Host.readTestProvenance(workDir);
  assert.ok(resumed.consumerBinding.views.sourceAnchor);
  assert.equal(resumed.consumerBinding.views.sourceAnchor.sha256,sha(fs.readFileSync(path.join(workDir,'source-anchor.json'))));
  assert.notEqual(resumed.consumerBinding.views.sourceAnchor.sha256,injectedSha);
  assert.equal(resumed.revision,revision);
  assert.equal(resumedCalls,0,'verified semantic and SC state must survive the failed control publication');
});

test('an exemption created after the fresh absence check cannot be imported as current control input',async t=>{
  const workDir=temp(t);let inserted=false;
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：图书馆应延长周末开放时间。\n反方：人员成本必须获得可持续的预算支持。');
  await assert.rejects(Host.runPipeline({workDir,cfg:{provider:'mock'},semanticFirstMode:'active',onLog:()=>{},
    mockResponder:messages=>{
      if(!inserted){fs.writeFileSync(path.join(workDir,'source-anchor-exemptions.json'),JSON.stringify({version:1,entries:[{historical:true}]}));inserted=true;}
      return Host.goodMockResponder(messages);
    }}),e=>e.code==='ERR_FRESH_CONTROL_IDENTITY');
  const provenance=Host.readTestProvenance(workDir);
  assert.ok(inserted);assert.ok(!provenance.consumerBinding.views.sourceAnchorExemptions);
});

test('verified exemption loader records exact bytes and rejects changed source or signed P2 identity',t=>{
  const workDir=temp(t);
  const source='正方：延长开放能扩大使用机会。\n反方：值班成本必须明确。';
  const p2='specific signed projection';
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),source);fs.writeFileSync(path.join(workDir,'P2.md'),p2);
  const anchor={extracted:true,rosterHash:'current-roster'};
  const doc={version:1,transcript_sha256:sha(source),roster_hash:anchor.rosterHash,entries:[{
    scope:'A3_ROSTER_MATCH',artifact:'P2.md',artifact_sha256:sha(p2),table_row:1,node_id:'M-ZH-1',
    turn_raw:'正方',operator_side:'正方',by:'synthetic human review',reason:'current-source identity checked',at:'2026-09-21T00:00:00Z',evidence_lines:[1]}]};
  const bytes=JSON.stringify(doc,null,2);fs.writeFileSync(path.join(workDir,'source-anchor-exemptions.json'),bytes);
  let recorded=null;
  assert.equal(Host.loadSourceAnchorExemptions(workDir,anchor,{onVerifiedBytes:value=>{recorded=value;}}).length,1);
  assert.equal(sha(recorded),sha(bytes));
  fs.writeFileSync(path.join(workDir,'P2.md'),p2+' changed');recorded=null;
  assert.throws(()=>Host.loadSourceAnchorExemptions(workDir,anchor,{onVerifiedBytes:value=>{recorded=value;}}),e=>e.code==='ERR_SOURCE_ANCHOR_EXEMPTION');
  assert.equal(recorded,null,'unverified bytes must never acquire a fresh snapshot');
});

test('mock semantic authority cannot cross into active non-mock resume',async t=>{
  const workDir=temp(t);
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：夜间公共服务能覆盖轮班劳动者。\n反方：额外预算必须保持可持续。');
  const mockOpts={cfg:{provider:'mock',model:'mock'},semanticFirstMode:'active',
    mockResponder:Host.goodMockResponder,onLog:()=>{}};
  const globalPrepared=await Host.prepareTestSemanticAuthority(workDir,mockOpts);
  const scPrepared=await Host.prepareTestScAuthority(workDir,globalPrepared,mockOpts);
  assert.equal(globalPrepared.current.revision,1);
  assert.equal(scPrepared.current.revision,1);

  let globalCalls=0;
  await assert.rejects(
    Host.prepareTestSemanticAuthority(workDir,{
      cfg:{provider:'openai',model:'synthetic-nonmock'},semanticFirstMode:'active',
      apiStub:async()=>{globalCalls++;throw new Error('execution-class mismatch must fail before global model call');},
      onLog:()=>{}
    }),
    e=>e&&e.code==='ERR_TEST_EXECUTION_CLASS_MISMATCH'
  );
  assert.equal(globalCalls,0);

  let scCalls=0;
  await assert.rejects(
    Host.prepareTestScAuthority(workDir,globalPrepared,{
      cfg:{provider:'openai',model:'synthetic-nonmock'},
      apiStub:async()=>{scCalls++;throw new Error('execution-class mismatch must fail before SC model call');}
    }),
    e=>e&&e.code==='ERR_TEST_EXECUTION_CLASS_MISMATCH'
  );
  assert.equal(scCalls,0);
});

test('non-mock authority may resume across provider/model changes without model calls',async t=>{
  const workDir=temp(t);
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：公共交通夜间覆盖能改善基本可达性。\n反方：预算约束仍需被认真比较。');
  let seedCalls=0;
  const syntheticVerified=async(_cfg,messages)=>{
    seedCalls++;
    return {
      text:Host.goodMockResponder(messages),
      completion_status:'verified_complete',
      completion_evidence:{synthetic_zero_model:true}
    };
  };
  const seedOpts={
    cfg:{provider:'openai',model:'synthetic-a'},
    semanticFirstMode:'active',
    apiStub:syntheticVerified,
    onLog:()=>{}
  };
  const globalPrepared=await Host.prepareTestSemanticAuthority(workDir,seedOpts);
  const scPrepared=await Host.prepareTestScAuthority(workDir,globalPrepared,seedOpts);
  assert.equal(globalPrepared.executionClass,'non-mock');
  assert.equal(scPrepared.executionClass,'non-mock');
  assert.ok(seedCalls>0);

  let globalResumeCalls=0;
  const resumedGlobal=await Host.prepareTestSemanticAuthority(workDir,{
    cfg:{provider:'codex-cli',model:'synthetic-b'},
    semanticFirstMode:'active',
    apiStub:async()=>{globalResumeCalls++;throw new Error('same non-mock class resume must be zero-call');},
    onLog:()=>{}
  });
  assert.equal(resumedGlobal.reused,true);
  assert.equal(resumedGlobal.executionClass,'non-mock');
  assert.equal(globalResumeCalls,0);

  let scResumeCalls=0;
  const resumedSc=await Host.prepareTestScAuthority(workDir,resumedGlobal,{
    cfg:{provider:'anthropic',model:'synthetic-c'},
    apiStub:async()=>{scResumeCalls++;throw new Error('same non-mock SC resume must be zero-call');}
  });
  assert.equal(resumedSc.reused,true);
  assert.equal(resumedSc.executionClass,'non-mock');
  assert.equal(scResumeCalls,0);
});

test('explicit mock smoke and historical off-mode transport retain their legitimate relaxed paths',async t=>{
  for(const [provider,mode]of [['mock','active'],['openai','off']]){
    const workDir=temp(t);let calls=0;
    fs.writeFileSync(path.join(workDir,'.tmp-R3-prompt.md'),'synthetic prompt');
    const result=await Host.runRound({workDir,round:{name:'R3',promptFile:'.tmp-R3-prompt.md',outFile:'P3.md'},
      cfg:{provider},semanticFirstMode:mode,realValidate:false,force:true,onLog:()=>{},
      activeSemanticAuthorityText:'SEMANTIC-FIRST ACTIVE AUTHORITY\nroute: PRODUCTION_ACTIVE\nmock fixture only',
      apiStub:async()=>{calls++;return 'synthetic projection fixture';}});
    assert.equal(result.ok,true);assert.equal(calls,1);
  }
});

test('direct global reopen reconstructs execution class from immutable ancestry before any new review',async t=>{
  const workDir=temp(t);
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：延长公共服务时段能改善轮班劳动者的可达性。\n反方：新增运营成本仍需纳入可持续预算。');
  let transportCalls=0;
  const mockOpts={
    cfg:{provider:'mock',model:'mock'},
    semanticFirstMode:'active',
    mockResponder:messages=>{transportCalls++;return Host.goodMockResponder(messages);},
    onLog:()=>{}
  };
  const prepared=await Host.prepareTestSemanticAuthority(workDir,mockOpts);
  const before=prepared.active.store.readCurrent(prepared.active.sessionId);
  const callsBefore=transportCalls;
  const forged={
    ...prepared,
    executionClass:'non-mock',
    provenance:{...prepared.provenance,executionClass:'non-mock'}
  };
  await assert.rejects(
    Host.publishTestR3Reopen(workDir,forged,{
      expectedRevision:before.revision,
      issue:'direct helper must prove execution class from immutable ancestry',
      evidence:[]
    },{
      cfg:{provider:'openai',model:'synthetic-nonmock'},
      onLog:()=>{}
    }),
    e=>e&&e.code==='ERR_TEST_EXECUTION_CLASS_MISMATCH'
  );
  assert.equal(transportCalls,callsBefore,'class mismatch must fail before the prepared mock transport is reused');
  assert.deepEqual(prepared.active.store.readCurrent(prepared.active.sessionId),before,
    'class mismatch must not publish a mixed-class revision');
});

test('direct global reopen keeps same-class non-mock provider migration and stale-provenance recovery zero-call',async t=>{
  const workDir=temp(t);
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：公共交通夜间覆盖能改善基本可达性。\n反方：预算约束仍需被认真比较。');
  let seedCalls=0;
  const seedOpts={
    cfg:{provider:'openai',model:'synthetic-a'},
    semanticFirstMode:'active',
    apiStub:async(_cfg,messages)=>{
      seedCalls++;
      return {text:Host.goodMockResponder(messages),completion_status:'verified_complete',
        completion_evidence:{synthetic_zero_model:true}};
    },
    onLog:()=>{}
  };
  const prepared=await Host.prepareTestSemanticAuthority(workDir,seedOpts);
  assert.equal(prepared.executionClass,'non-mock');
  assert.equal(prepared.current.revision,1);
  assert.ok(seedCalls>0);

  let reopenCalls=0;
  const reopened=await Host.publishTestR3Reopen(workDir,prepared,{
    expectedRevision:1,
    issue:'same non-mock class may change provider/model without changing semantic truth',
    evidence:[]
  },{
    cfg:{provider:'anthropic',model:'synthetic-b'},
    semanticFirstMode:'active',
    apiStub:async(_cfg,messages)=>{
      reopenCalls++;
      return {text:Host.goodMockResponder(messages),completion_status:'verified_complete',
        completion_evidence:{synthetic_zero_model:true}};
    },
    onLog:()=>{}
  });
  assert.equal(reopened.published,true);
  assert.equal(reopened.current.revision,2);
  assert.ok(reopenCalls>0,'direct reopen must use the newly supplied same-class transport');

  let resumeCalls=0;
  const resumed=await Host.prepareTestSemanticAuthority(workDir,{
    cfg:{provider:'codex-cli',model:'synthetic-c'},
    semanticFirstMode:'active',
    apiStub:async()=>{resumeCalls++;throw new Error('stale-provenance recovery must remain zero-call');},
    onLog:()=>{}
  });
  assert.equal(resumed.recovered,true,'revision-2 current with revision-1 provenance must use immutable recovery');
  assert.equal(resumed.recoveredFromRevision,1);
  assert.equal(resumed.executionClass,'non-mock');
  assert.equal(resumed.current.revision,2);
  assert.equal(resumeCalls,0);
});

test('direct SC prepare cannot forge the global execution class through caller-owned prepared fields',async t=>{
  const workDir=temp(t);
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：公共服务延长时段能改善轮班劳动者的可达性。\n反方：运营成本仍需纳入可持续预算。');
  let globalCalls=0;
  const globalPrepared=await Host.prepareTestSemanticAuthority(workDir,{
    cfg:{provider:'openai',model:'synthetic-global-nonmock'},
    semanticFirstMode:'active',
    apiStub:async(_cfg,messages)=>{
      globalCalls++;
      return {text:Host.goodMockResponder(messages),completion_status:'verified_complete',
        completion_evidence:{synthetic_zero_model:true}};
    },
    onLog:()=>{}
  });
  assert.equal(globalPrepared.executionClass,'non-mock');
  assert.ok(globalCalls>0);
  const forged={
    ...globalPrepared,
    executionClass:'mock',
    provenance:{...globalPrepared.provenance,executionClass:'mock'}
  };
  let scCalls=0;
  await assert.rejects(
    Host.prepareTestScAuthority(workDir,forged,{
      cfg:{provider:'mock',model:'mock'},
      mockResponder:messages=>{scCalls++;return Host.goodMockResponder(messages);}
    }),
    e=>e&&e.code==='ERR_TEST_EXECUTION_CLASS_MISMATCH'
  );
  assert.equal(scCalls,0,'global/SC execution-class mismatch must fail before SC semantic calls');
  assert.equal(globalPrepared.active.store.readCurrent('test-sc-current').revision,0,
    'global/SC execution-class mismatch must fail before SC CAS');
});

test('direct SC prepare allows same-class non-mock provider/model migration',async t=>{
  const workDir=temp(t);
  fs.writeFileSync(path.join(workDir,'.tmp-debate.txt'),'正方：延长公共服务能改善基本可达性。\n反方：新增成本仍需在预算约束内比较。');
  let globalCalls=0;
  const globalPrepared=await Host.prepareTestSemanticAuthority(workDir,{
    cfg:{provider:'openai',model:'synthetic-global-a'},
    semanticFirstMode:'active',
    apiStub:async(_cfg,messages)=>{
      globalCalls++;
      return {text:Host.goodMockResponder(messages),completion_status:'verified_complete',
        completion_evidence:{synthetic_zero_model:true}};
    },
    onLog:()=>{}
  });
  assert.equal(globalPrepared.executionClass,'non-mock');
  assert.ok(globalCalls>0);
  let scCalls=0;
  const scPrepared=await Host.prepareTestScAuthority(workDir,globalPrepared,{
    cfg:{provider:'anthropic',model:'synthetic-sc-b'},
    apiStub:async(_cfg,messages)=>{
      scCalls++;
      return {text:Host.goodMockResponder(messages),completion_status:'verified_complete',
        completion_evidence:{synthetic_zero_model:true}};
    }
  });
  assert.equal(scPrepared.executionClass,'non-mock');
  assert.equal(scPrepared.current.revision,1);
  assert.ok(scCalls>0,'same non-mock class may create SC authority under a different provider/model');
});
