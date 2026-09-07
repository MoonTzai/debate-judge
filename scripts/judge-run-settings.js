'use strict';

// Debate-Judge shared run settings v1.
// Host-independent single source for tendency / depth / Judge Persona Context.
// Web facades and Node/CLI must consume this module; browser persistence/UI are intentionally out of scope.

var DIM_KEYS = ['说服', '证明', '第三方'];
var DIM_DEFAULT = 0;
var DIMENSIONS = ['证伪', '证成', '理性', '感性', '场面感', '意义感'];
var VECTOR_DEFAULT = 50;
var PROFILE_KIND = 'debate-judge-tendency-profile-v1';
var PROFILE_VERSION = 1;
var PROFILE_V2_KIND = 'debate-judge-tendency-profile-v2';
var PROFILE_V2_VERSION = 2;
var AXES = [
  { key:'证明轴', dim:'证明', pair:['证伪','证成'], low:{name:'批判者',tag:'证伪导向',desc:'欣赏主动交锋拆解对方'}, high:{name:'审判者',tag:'证成导向',desc:'像法官一样看重举证与自证'} },
  { key:'说服轴', dim:'说服', pair:['理性','感性'], low:{name:'卫道者',tag:'理性侧',desc:'欣赏符合大众预期的论证，对反常识要求更高举证'}, high:{name:'问道者',tag:'感性侧',desc:'欣赏打破常规的新视角与情境说服'} },
  { key:'第三方轴', dim:'第三方', pair:['场面感','意义感'], low:{name:'技术者',tag:'场面感',desc:'追求赛会规则与操作完成度'}, high:{name:'艺术者',tag:'意义感',desc:'注重整体审美与论证深度'} }
];
var DEPTH_DEFAULTS = { verdict:'标准', mainline:'标准全景图', clash:'标准5-8个' };

var CONTEXT_KIND = 'debate-judge-context-v1';
var CONTEXT_VERSION = 1;
var USE_MODES = ['presentation_only', 'registered_conflicts_plus_presentation'];
var BACKGROUND_MODES = ['none','academic','practitioner','mixed'];
var BACKGROUND_DOMAINS = [
  'law_public_policy','economics_business','philosophy_ethics','social_science','natural_science','engineering_technology',
  'medicine_public_health','education','history_humanities','media_communication','arts_culture','public_administration'
];
var FAMILIARITY = ['general','working','deep'];
var VALUE_CONCERNS = [
  'procedural_fairness','substantive_fairness','individual_autonomy','rights_dignity','welfare_harm','responsibility_accountability',
  'equality_inclusion','order_predictability','long_term_sustainability','truth_accuracy','social_trust','feasibility_execution'
];
var PERSPECTIVES = [
  'neutral_observer','general_public','directly_affected','domain_practitioner','institutional_operator','policy_decision_maker',
  'academic_observer','community_observer'
];
var DEFAULT_CONTEXT = Object.freeze({
  kind:CONTEXT_KIND, version:CONTEXT_VERSION, enabled:false, useMode:'presentation_only',
  background:Object.freeze({mode:'none',domains:Object.freeze([]),familiarity:'general'}),
  valueConcerns:Object.freeze([]), perspective:'neutral_observer', note:''
});

function clampInt(v, def, min, max) {
  if (v === undefined || v === null) return def;
  var n = Number(v);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function normalizeDimWeights(input) {
  var w = {};
  for (var i=0;i<DIM_KEYS.length;i++) w[DIM_KEYS[i]] = clampInt(input && input[DIM_KEYS[i]], DIM_DEFAULT, 0, 100);
  return w;
}
function normalizeVectorWeights(input) {
  var w = {};
  for (var i=0;i<DIMENSIONS.length;i++) w[DIMENSIONS[i]] = clampInt(input && input[DIMENSIONS[i]], VECTOR_DEFAULT, 0, 100);
  return w;
}
function normalizeTendencyProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('人格配置不是对象');
  var isV1 = input.kind === PROFILE_KIND && Number(input.version) === PROFILE_VERSION;
  var isV2 = input.kind === PROFILE_V2_KIND && Number(input.version) === PROFILE_V2_VERSION;
  if (!isV1 && !isV2) throw new Error('不支持的人格配置版本');
  var src = input.vectorWeights;
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('人格配置缺少六向度');
  var out = {};
  for (var i=0;i<DIMENSIONS.length;i++) {
    var k=DIMENSIONS[i], n=Number(src[k]);
    if (!(k in src)) throw new Error('人格配置缺少向度：'+k);
    if (!isFinite(n)||n<0||n>100) throw new Error('人格配置向度越界：'+k);
    out[k]=Math.round(n);
  }
  var dimOut=null;
  if (isV2) {
    var dimSrc=input.dimWeights;
    if (!dimSrc || typeof dimSrc !== 'object' || Array.isArray(dimSrc)) throw new Error('人格配置缺少三维权重');
    dimOut={};
    for (var d=0;d<DIM_KEYS.length;d++) {
      var dk=DIM_KEYS[d], dn=Number(dimSrc[dk]);
      if (!(dk in dimSrc)) throw new Error('人格配置缺少三维：'+dk);
      if (!isFinite(dn)||dn<0||dn>100) throw new Error('人格配置三维权重越界：'+dk);
      dimOut[dk]=Math.round(dn);
    }
  }
  return { kind:isV2?PROFILE_V2_KIND:PROFILE_KIND, version:isV2?PROFILE_V2_VERSION:PROFILE_VERSION,
    source:String(input.source||''), generatedAt:String(input.generatedAt||''), code:String(input.code||''),
    priorityCode:isV2?String(input.priorityCode||''):'', axisNet:input.axisNet&&typeof input.axisNet==='object'?input.axisNet:null,
    priorityScore:isV2&&input.priorityScore&&typeof input.priorityScore==='object'?input.priorityScore:null,
    priorityPairNet:isV2&&input.priorityPairNet&&typeof input.priorityPairNet==='object'?input.priorityPairNet:null,
    dimWeights:dimOut, vectorWeights:out };
}
function valueLabel(v) {
  if (v===0) return '不在意'; if (v<=25) return '很低'; if (v<50) return '偏低'; if (v===50) return '常规'; if (v<=75) return '偏高'; if (v<100) return '很高'; return '极高';
}
function isAuto(dimInput, vectorInput) {
  var d=normalizeDimWeights(dimInput), v=normalizeVectorWeights(vectorInput);
  for (var i=0;i<DIM_KEYS.length;i++) if (d[DIM_KEYS[i]]!==DIM_DEFAULT) return false;
  for (var j=0;j<DIMENSIONS.length;j++) if (v[DIMENSIONS[j]]!==VECTOR_DEFAULT) return false;
  return true;
}
function deriveAxis(axis,v) {
  var lowV=v[axis.pair[0]], highV=v[axis.pair[1]];
  if (lowV===highV) return {axis:axis.key,side:null,text:axis.key+'中立（'+axis.pair[0]+' '+lowV+' = '+axis.pair[1]+' '+highV+'）'};
  var side=lowV>highV?axis.low:axis.high, diff=Math.abs(lowV-highV), strength=diff<=15?'轻微':diff<=40?'明显':'强烈';
  return {axis:axis.key,side:side,strength:strength,diff:diff,text:axis.key+strength+'偏'+side.name+'（'+side.tag+'：'+axis.pair[0]+' '+lowV+' vs '+axis.pair[1]+' '+highV+'）'};
}
function deriveAllAxes(vectorInput) { var v=normalizeVectorWeights(vectorInput); return AXES.map(function(a){return deriveAxis(a,v);}); }
function dimLineText(d) {
  var active=DIM_KEYS.filter(function(k){return d[k]!==0;});
  if (!active.length) return '三维权重：说服 0 ｜ 证明 0 ｜ 第三方 0（中立·自动——由比赛内容驱动，LLM 自行选择匹配的判准框架）';
  var parts=DIM_KEYS.map(function(k){return k+' '+d[k]+'（'+valueLabel(d[k])+'）';});
  var order=DIM_KEYS.slice().sort(function(a,b){return d[b]-d[a];});
  return '三维权重：'+parts.join(' ｜ ')+'——整体侧重：'+order[0]+'侧为主'+(d[order[1]]>0?'，'+order[1]+'侧次之':'')+(d[order[2]]>0?'，'+order[2]+'侧为参考':'')+(active.length<3?'（其余维自动）':'');
}
function tendencyText(dimInput,vectorInput) {
  var d=normalizeDimWeights(dimInput),v=normalizeVectorWeights(vectorInput); if(isAuto(d,v)) return '';
  var lines=['本场裁判倾向（由用户设定·三维权重 + 六向度看重程度）：',dimLineText(d)];
  lines.push('六向度看重程度：'+DIMENSIONS.map(function(k){return k+' '+v[k]+'（'+valueLabel(v[k])+'）';}).join(' ｜ ')+'（100=极高，0=不在意，50=常规）');
  var derived=deriveAllAxes(v).filter(function(a){return a.side;});
  if(derived.length) lines.push('维内倾向（由同轴两向度对比派生）：'+derived.map(function(a){return a.text;}).join(' ｜ '));
  lines.push('说明：三维权重决定整体侧重；各维内部倾向由对应一对向度的权重对比共同决定；六向度全部参与评判，仅看重程度不同。此为自然语言注意力引导，不参与数学公式计算。');
  return lines.join('\n');
}
function normalizeDepth(depth) {
  return { verdict:depth&&depth.verdict?String(depth.verdict):DEPTH_DEFAULTS.verdict,
    mainline:depth&&depth.mainline?String(depth.mainline):DEPTH_DEFAULTS.mainline,
    clash:depth&&depth.clash?String(depth.clash):DEPTH_DEFAULTS.clash };
}
function isDefaultDepth(depth) { var d=normalizeDepth(depth); return d.verdict===DEPTH_DEFAULTS.verdict&&d.mainline===DEPTH_DEFAULTS.mainline&&d.clash===DEPTH_DEFAULTS.clash; }
function depthBlockText(depth) {
  if(isDefaultDepth(depth)) return ''; var d=normalizeDepth(depth);
  return ['', '---','## 输出深度要求（用户自定义）','', '- 胜负判决详细度：'+d.verdict+'（简明=判决+比分+一句话理由，省略判准对比；详细=含判准对比）', '- 主线分析深度：'+d.mainline+'（简述类型=类型标签+简化面板；逐环节追踪=完整面板+组间递进标签全量）', '- 交锋裁决详细度：'+d.clash+'（对应 C6 交锋表行数上限）',''].join('\n');
}

function cloneDefaultContext(){return {kind:CONTEXT_KIND,version:CONTEXT_VERSION,enabled:false,useMode:'presentation_only',background:{mode:'none',domains:[],familiarity:'general'},valueConcerns:[],perspective:'neutral_observer',note:''};}
function assertObject(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(label+' 必须是对象');}
function assertKeys(obj,allowed,label){Object.keys(obj).forEach(function(k){if(allowed.indexOf(k)<0)throw new Error(label+' 含未知字段: '+k);});}
function assertEnum(value,allowed,label){if(allowed.indexOf(value)<0)throw new Error(label+' 非法: '+String(value));}
function normalizeStringArray(value,allowed,max,label){if(!Array.isArray(value))throw new Error(label+' 必须是数组');if(value.length>max)throw new Error(label+' 最多 '+max+' 项');var seen={};return value.map(function(v){if(typeof v!=='string')throw new Error(label+' 只能包含字符串');assertEnum(v,allowed,label);if(seen[v])throw new Error(label+' 不允许重复项: '+v);seen[v]=true;return v;});}
function hasStructuredSelection(c){return c.background.mode!=='none'||c.background.domains.length>0||c.valueConcerns.length>0||c.perspective!=='neutral_observer';}
function validateNote(note,context){
  if(typeof note!=='string')throw new Error('补充说明 note 必须是字符串'); if(/\r|\n/.test(note))throw new Error('补充说明必须是单行文本'); if(note.length>120)throw new Error('补充说明最多 120 字符'); if(/```|~~~/.test(note))throw new Error('补充说明不得包含代码围栏'); if(note&&!hasStructuredSelection(context))throw new Error('补充说明不能独立存在，必须先选择至少一个结构化背景、价值关注或裁判视角');
  var forbidden=[/(?:忽略|无视|覆盖|替代|绕过).{0,16}(?:以上|上述|前述|规则|指令|要求|合同|prompt|system|系统)/i,/(?:system|assistant|developer|prompt)\s*[:：]/i,/判.{0,8}(正方|反方).{0,8}(赢|胜|获胜)/i,/(支持|偏向|倾向).{0,6}(正方|反方)/i,/指定.{0,8}(胜负|赢家|获胜方)/i,/比分.{0,8}(改|设|定)/i,/(改写|修改|篡改).{0,8}事实/i,/(改写|修改|篡改).{0,12}(实际发生的)?交锋/i,/(改变|修改|重置).{0,8}举证责任/i,/(增加|新增|补充|凭空).{0,8}(材料|证据)/i,/(背景知识|外部知识).{0,8}(作为|当作|冒充).{0,8}(本场)?证据/i,/(作为|当作).{0,8}本场证据/i,/(绕过|忽略|推翻).{0,8}(Judge|裁决|合同|规则|门禁)/i];
  for(var i=0;i<forbidden.length;i++)if(forbidden[i].test(note))throw new Error('补充说明包含被禁止的 Prompt 控制、胜负/队伍偏向、事实、举证责任、材料证据或裁决合同指令');
}
function normalizeJudgeContext(raw){
  if(raw==null)return cloneDefaultContext(); assertObject(raw,'Judge Persona Context'); assertKeys(raw,['kind','version','enabled','useMode','background','valueConcerns','perspective','note'],'Judge Persona Context');
  if(raw.kind!==CONTEXT_KIND)throw new Error('Judge Persona Context kind 无效'); if(raw.version!==CONTEXT_VERSION)throw new Error('Judge Persona Context 版本/version 无效'); if(typeof raw.enabled!=='boolean')throw new Error('enabled 必须是 boolean'); assertEnum(raw.useMode,USE_MODES,'useMode'); assertObject(raw.background,'background'); assertKeys(raw.background,['mode','domains','familiarity'],'background'); assertEnum(raw.background.mode,BACKGROUND_MODES,'background.mode'); assertEnum(raw.background.familiarity,FAMILIARITY,'background.familiarity');
  var out={kind:CONTEXT_KIND,version:CONTEXT_VERSION,enabled:raw.enabled,useMode:raw.useMode,background:{mode:raw.background.mode,domains:normalizeStringArray(raw.background.domains,BACKGROUND_DOMAINS,3,'background.domains'),familiarity:raw.background.familiarity},valueConcerns:normalizeStringArray(raw.valueConcerns,VALUE_CONCERNS,4,'valueConcerns'),perspective:raw.perspective,note:raw.note==null?'':raw.note};
  assertEnum(out.perspective,PERSPECTIVES,'perspective/裁判视角'); validateNote(out.note,out); return out;
}
function r45Block(c){return '\n\n<!-- JUDGE_PERSONA_CONTEXT_V1:R4.5 -->\n## Judge Persona Context｜R4.5 受限冲突解释上下文\n- background.mode: '+c.background.mode+'\n- background.domains: '+(c.background.domains.join(', ')||'none')+'\n- valueConcerns: '+(c.valueConcerns.join(', ')||'none')+'\n- perspective: '+c.perspective+'\n\n硬边界：该上下文只能在机械登记、且双方候选均未被更高权威直接排除的冲突中作为次级解释视角。不得创造冲突，不得改变 conflict id / pair，不得绕过现有 left/right/reject 合同，不得新增材料，不得改变事实、举证责任、交锋记录、Judge 判准权重，也不得把背景知识作为本场证据。\n';}
function r5Block(c){return '\n\n<!-- JUDGE_PERSONA_CONTEXT_V1:R5 -->\n## Judge Persona Context｜R5 受限表达上下文\n- background.mode: '+c.background.mode+'\n- background.domains: '+(c.background.domains.join(', ')||'none')+'\n- background.familiarity: '+c.background.familiarity+'\n- valueConcerns: '+(c.valueConcerns.join(', ')||'none')+'\n- perspective: '+c.perspective+'\n'+(c.note?'- bounded_note: '+c.note+'\n':'')+'\n硬边界：只允许影响第一人称解释角度、术语密度、价值关注的呈现，以及对既有裁决理由的组织。不得改变 authoritative DATA、S15、胜负、比分、事实、举证责任、实际交锋或证据状态；不得引入外部材料；背景知识只能作为理解视角，不能写成本场证据。不得把本 Context 转换成三维/六向度权重、人格代码、randomness/temperature 或 provider/model 设置。\n';}
function projectJudgeContext(context,round){var c=normalizeJudgeContext(context);if(!c.enabled)return '';if(!hasStructuredSelection(c)&&!c.note)return '';if(round==='R4.5'&&c.useMode==='registered_conflicts_plus_presentation')return r45Block(c);if(round==='R5A'||round==='R5B')return r5Block(c);return '';}
function contextSummary(context){var c;try{c=normalizeJudgeContext(context);}catch(e){return '未启用（配置无效）';}if(!c.enabled)return '未启用';if(!hasStructuredSelection(c)&&!c.note)return '已启用 · 未设定（不注入）';var parts=[c.useMode==='registered_conflicts_plus_presentation'?'已登记冲突 + 报告表达':'仅报告表达'];if(c.background.mode!=='none')parts.push('背景 '+c.background.mode);if(c.background.domains.length)parts.push('领域 '+c.background.domains.join(' / '));if(c.valueConcerns.length)parts.push('价值 '+c.valueConcerns.join(' / '));if(c.perspective!=='neutral_observer')parts.push('视角 '+c.perspective);if(c.note)parts.push('含短补充');return parts.join(' · ');}

function normalizeRunSettings(raw){
  raw=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{}; var analysis=raw.analysis&&typeof raw.analysis==='object'?raw.analysis:raw; var post=raw.postprocess&&typeof raw.postprocess==='object'?raw.postprocess:raw;
  return {kind:'debate-judge-run-settings-v1',version:1,analysis:{dimWeights:normalizeDimWeights(analysis.dimWeights),tendencyWeights:normalizeVectorWeights(analysis.tendencyWeights||analysis.vectorWeights),depth:normalizeDepth(analysis.depth),judgeContext:normalizeJudgeContext(analysis.judgeContext)},postprocess:{plain:post.plain===true,readerGuide:post.readerGuide===true}};
}
function stableObject(value){if(Array.isArray(value))return value.map(stableObject);if(value&&typeof value==='object'){var o={};Object.keys(value).sort().forEach(function(k){o[k]=stableObject(value[k]);});return o;}return value;}
function stableJson(value){return JSON.stringify(stableObject(value));}
// Pure synchronous SHA-256 (browser + Node, no crypto dependency).
function sha256Hex(str){
  var msg=unescape(encodeURIComponent(String(str))),len=msg.length,bitLen=len*8,padding=len%64<56?56-(len%64):120-(len%64),bytes=[],i,j,b;
  for(i=0;i<len;i++)bytes.push(msg.charCodeAt(i)&255);bytes.push(128);for(j=0;j<padding-1;j++)bytes.push(0);for(b=7;b>=0;b--)bytes.push((Math.floor(bitLen/Math.pow(2,8*b))&255));
  var words=[];for(i=0;i<bytes.length;i+=4)words.push((bytes[i]<<24)|(bytes[i+1]<<16)|(bytes[i+2]<<8)|bytes[i+3]);
  var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function rr(x,n){return(x>>>n)|(x<<(32-n));}var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  for(var blk=0;blk<words.length;blk+=16){var w=words.slice(blk,blk+16);for(var t=16;t<64;t++){var s0=rr(w[t-15],7)^rr(w[t-15],18)^(w[t-15]>>>3),s1=rr(w[t-2],17)^rr(w[t-2],19)^(w[t-2]>>>10);w[t]=(w[t-16]+s0+w[t-7]+s1)|0;}var a=h0,c1=h1,c2=h2,d=h3,e=h4,f=h5,g=h6,h=h7;for(t=0;t<64;t++){var S1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^(~e&g),temp1=(h+S1+ch+K[t]+w[t])|0,S0=rr(a,2)^rr(a,13)^rr(a,22),maj=(a&c1)^(a&c2)^(c1&c2),temp2=(S0+maj)|0;h=g;g=f;f=e;e=(d+temp1)|0;d=c2;c2=c1;c1=a;a=(temp1+temp2)|0;}h0=(h0+a)|0;h1=(h1+c1)|0;h2=(h2+c2)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0;}
  function hx(x){return('00000000'+(x>>>0).toString(16)).slice(-8);}return hx(h0)+hx(h1)+hx(h2)+hx(h3)+hx(h4)+hx(h5)+hx(h6)+hx(h7);
}
function analysisProfileHash(settings){var n=normalizeRunSettings(settings);return sha256Hex(stableJson(n.analysis));}

module.exports={
  DIM_KEYS:DIM_KEYS,DIM_DEFAULT:DIM_DEFAULT,DIMENSIONS:DIMENSIONS,VECTOR_DEFAULT:VECTOR_DEFAULT,PROFILE_KIND:PROFILE_KIND,PROFILE_VERSION:PROFILE_VERSION,PROFILE_V2_KIND:PROFILE_V2_KIND,PROFILE_V2_VERSION:PROFILE_V2_VERSION,AXES:AXES,DEPTH_DEFAULTS:DEPTH_DEFAULTS,
  KIND:CONTEXT_KIND,VERSION:CONTEXT_VERSION,DEFAULT_CONTEXT:DEFAULT_CONTEXT,USE_MODES:USE_MODES,BACKGROUND_MODES:BACKGROUND_MODES,BACKGROUND_DOMAINS:BACKGROUND_DOMAINS,FAMILIARITY:FAMILIARITY,VALUE_CONCERNS:VALUE_CONCERNS,PERSPECTIVES:PERSPECTIVES,
  normalizeDimWeights:normalizeDimWeights,normalizeVectorWeights:normalizeVectorWeights,normalizeTendencyProfile:normalizeTendencyProfile,valueLabel:valueLabel,isAuto:isAuto,deriveAxis:deriveAxis,deriveAllAxes:deriveAllAxes,dimLineText:dimLineText,tendencyText:tendencyText,normalizeDepth:normalizeDepth,isDefaultDepth:isDefaultDepth,depthBlockText:depthBlockText,
  normalizeJudgeContext:normalizeJudgeContext,projectJudgeContext:projectJudgeContext,contextSummary:contextSummary,normalizeRunSettings:normalizeRunSettings,analysisProfileHash:analysisProfileHash,stableJson:stableJson,sha256Hex:sha256Hex
};
