'use strict';
// Default runs all public tests. --current explicitly excludes disclosed legacy failures.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),currentOnly=process.argv.includes('--current');
const legacy=new Set(['self-check.test.js','key-engine.test.js']);
let passed=0,failed=0;
function run(label,args){
 const r=cp.spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 if(r.status===0)passed++;else failed++;
 console.log((r.status===0?'PASS ':'FAIL ')+label);
 if(r.stdout)console.log(r.stdout.trim());if(r.stderr)console.log(r.stderr.trim());if(r.error)console.log(r.error.message);
}
run('embedded closure',['install-skill.js','--verify-only']);
for(const file of fs.readdirSync(__dirname).filter(x=>x.endsWith('.test.js')).sort()){
 if(currentOnly&&legacy.has(file)){console.log('EXCLUDED legacy suite (not a PASS): '+file);continue;}
 run(file,['tests/'+file]);
}
if(!currentOnly)run('legacy project self-check',['pipeline-controller.js','self-check']);
console.log(JSON.stringify({scope:currentOnly?'current deterministic subset':'all public tests plus legacy self-check',passed,failed,excluded:currentOnly?[...legacy,'pipeline-controller self-check']:[]}));
process.exitCode=failed?1:0;
