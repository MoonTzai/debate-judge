'use strict';
const cp=require('node:child_process'),path=require('node:path'),root=path.resolve(__dirname,'..'),mode=process.argv[2];
function run(args){const r=cp.spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);}
if(mode==='--build'){
 // Preserve frozen embedded source; never rewrite it implicitly.
 run(['install-skill.js','--verify-only']);run(['web/build-judge-web.js']);run(['tests/semantic-edition.test.js']);
}else if(mode==='--test'||mode==='--test-current'){
 run(['scripts/secret-scan.js','.']);run(['tests/run-public.js',...(mode==='--test-current'?['--current']:[])]);
}else{console.error('Usage: node scripts/accept-release.js --build|--test|--test-current');process.exit(2);}
