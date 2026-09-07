// ============================================================
// tendency.js — 裁判倾向模型（v2 · 按用户口径 260813 修订）
// 两层结构：
//   1) 三维权重（整体大倾向）：说服 / 证明 / 第三方，各 0–100，
//      默认 0；全 0 = 中立（自动）——由比赛内容驱动，LLM 自行匹配判准框架
//   2) 六向度权重（单向「看重程度」）：证伪 / 证成 / 理性 / 感性 / 场面感 / 意义感，
//      各 0–100；100 = 极高，0 = 不在意，默认 50（常规）。
//      向度是单向的看重程度，不是双向人格轴。
//   3) 维内倾向 = 派生值：每轴对应的一对向度权重对比共同决定
//      证明轴：证伪 vs 证成 → 批判者向（证伪导向）/ 审判者向（证成导向）
//      说服轴：理性 vs 感性 → 卫道者向（常识/理性侧）/ 问道者向（新视角/感性侧）
//      第三方轴：场面感 vs 意义感 → 技术者向（操作流畅）/ 艺术者向（深度/意义）
// 注入方式 = 自然语言注意力引导（非数学公式），走「> 裁判倾向:」提示词头通道。
// ============================================================
'use strict';

var DIM_KEYS = ['说服', '证明', '第三方'];               // 三维权重键
var DIM_DEFAULT = 0;                                      // 三维默认 0 = 中立（自动）
var DIMENSIONS = ['证伪', '证成', '理性', '感性', '场面感', '意义感'];  // 六向度键
var VECTOR_DEFAULT = 50;                                  // 向度默认 50 = 常规
var PROFILE_KIND = 'debate-judge-tendency-profile-v1';
var PROFILE_VERSION = 1;
var PROFILE_V2_KIND = 'debate-judge-tendency-profile-v2';
var PROFILE_V2_VERSION = 2;

// 轴 ↔ 向度对 ↔ 人格（原材料：批判者=证伪导向 / 审判者=证成导向；
// 卫道者=常识/理性侧 / 问道者=新视角/感性侧；技术者=操作流畅/场面感 / 艺术者=深度/意义感）
var AXES = [
  { key: '证明轴', dim: '证明', pair: ['证伪', '证成'],
    low: { name: '批判者', tag: '证伪导向', desc: '欣赏主动交锋拆解对方' },
    high: { name: '审判者', tag: '证成导向', desc: '像法官一样看重举证与自证' } },
  { key: '说服轴', dim: '说服', pair: ['理性', '感性'],
    low: { name: '卫道者', tag: '理性侧', desc: '欣赏符合大众预期的论证，对反常识要求更高举证' },
    high: { name: '问道者', tag: '感性侧', desc: '欣赏打破常规的新视角与情境说服' } },
  { key: '第三方轴', dim: '第三方', pair: ['场面感', '意义感'],
    low: { name: '技术者', tag: '场面感', desc: '追求赛会规则与操作完成度' },
    high: { name: '艺术者', tag: '意义感', desc: '注重整体审美与论证深度' } }
];

// ---------- 归一化 ----------
function clampInt(v, def, min, max) {
  if (v === undefined || v === null) return def;
  var n = Number(v);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function normalizeDimWeights(input) {
  var w = {};
  for (var i = 0; i < DIM_KEYS.length; i++) {
    w[DIM_KEYS[i]] = clampInt(input && input[DIM_KEYS[i]], DIM_DEFAULT, 0, 100);
  }
  return w;
}
function normalizeVectorWeights(input) {
  var w = {};
  for (var i = 0; i < DIMENSIONS.length; i++) {
    w[DIMENSIONS[i]] = clampInt(input && input[DIMENSIONS[i]], VECTOR_DEFAULT, 0, 100);
  }
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
  for (var i = 0; i < DIMENSIONS.length; i++) {
    var k = DIMENSIONS[i];
    if (!(k in src)) throw new Error('人格配置缺少向度：' + k);
    var n = Number(src[k]);
    if (!isFinite(n) || n < 0 || n > 100) throw new Error('人格配置向度越界：' + k);
    out[k] = Math.round(n);
  }
  var dimOut = null;
  if (isV2) {
    var dimSrc = input.dimWeights;
    if (!dimSrc || typeof dimSrc !== 'object' || Array.isArray(dimSrc)) throw new Error('人格配置缺少三维权重');
    dimOut = {};
    for (var d = 0; d < DIM_KEYS.length; d++) {
      var dk = DIM_KEYS[d];
      if (!(dk in dimSrc)) throw new Error('人格配置缺少三维：' + dk);
      var dn = Number(dimSrc[dk]);
      if (!isFinite(dn) || dn < 0 || dn > 100) throw new Error('人格配置三维权重越界：' + dk);
      dimOut[dk] = Math.round(dn);
    }
  }
  return {
    kind: isV2 ? PROFILE_V2_KIND : PROFILE_KIND,
    version: isV2 ? PROFILE_V2_VERSION : PROFILE_VERSION,
    source: String(input.source || ''),
    generatedAt: String(input.generatedAt || ''),
    code: String(input.code || ''),
    priorityCode: isV2 ? String(input.priorityCode || '') : '',
    axisNet: input.axisNet && typeof input.axisNet === 'object' ? input.axisNet : null,
    priorityScore: isV2 && input.priorityScore && typeof input.priorityScore === 'object' ? input.priorityScore : null,
    priorityPairNet: isV2 && input.priorityPairNet && typeof input.priorityPairNet === 'object' ? input.priorityPairNet : null,
    dimWeights: dimOut,
    vectorWeights: out
  };
}

// ---------- 单向看重程度标签（0=不在意 → 100=极高） ----------
function valueLabel(v) {
  if (v === 0) return '不在意';
  if (v <= 25) return '很低';
  if (v < 50) return '偏低';
  if (v === 50) return '常规';
  if (v <= 75) return '偏高';
  if (v < 100) return '很高';
  return '极高';
}

// ---------- 自动判定：三维全 0 且 六向度全 50 ----------
function isAuto(dimInput, vectorInput) {
  var d = normalizeDimWeights(dimInput);
  var v = normalizeVectorWeights(vectorInput);
  for (var i = 0; i < DIM_KEYS.length; i++) if (d[DIM_KEYS[i]] !== DIM_DEFAULT) return false;
  for (var j = 0; j < DIMENSIONS.length; j++) if (v[DIMENSIONS[j]] !== VECTOR_DEFAULT) return false;
  return true;
}

// ---------- 维内倾向派生：一对向度对比 ----------
function deriveAxis(axis, v) {
  var lowV = v[axis.pair[0]];
  var highV = v[axis.pair[1]];
  if (lowV === highV) {
    return { axis: axis.key, side: null, text: axis.key + '中立（' + axis.pair[0] + ' ' + lowV + ' = ' + axis.pair[1] + ' ' + highV + '）' };
  }
  var side = lowV > highV ? axis.low : axis.high;
  var diff = Math.abs(lowV - highV);
  var strength = diff <= 15 ? '轻微' : diff <= 40 ? '明显' : '强烈';
  return {
    axis: axis.key, side: side, strength: strength, diff: diff,
    text: axis.key + strength + '偏' + side.name + '（' + side.tag + '：' + axis.pair[0] + ' ' + lowV + ' vs ' + axis.pair[1] + ' ' + highV + '）'
  };
}
function deriveAllAxes(vectorInput) {
  var v = normalizeVectorWeights(vectorInput);
  return AXES.map(function (a) { return deriveAxis(a, v); });
}

// ---------- 三维权重的自然语言 ----------
function dimLineText(d) {
  var active = DIM_KEYS.filter(function (k) { return d[k] !== 0; });
  if (active.length === 0) {
    return '三维权重：说服 0 ｜ 证明 0 ｜ 第三方 0（中立·自动——由比赛内容驱动，LLM 自行选择匹配的判准框架）';
  }
  var parts = DIM_KEYS.map(function (k) { return k + ' ' + d[k] + '（' + valueLabel(d[k]) + '）'; });
  var order = DIM_KEYS.slice().sort(function (a, b) { return d[b] - d[a]; });
  return '三维权重：' + parts.join(' ｜ ') + '——整体侧重：' + order[0] + '侧为主' +
    (d[order[1]] > 0 ? '，' + order[1] + '侧次之' : '') +
    (d[order[2]] > 0 ? '，' + order[2] + '侧为参考' : '') +
    (active.length < 3 ? '（其余维自动）' : '');
}

// ---------- 生成倾向文本（auto → 空串） ----------
function tendencyText(dimInput, vectorInput) {
  var d = normalizeDimWeights(dimInput);
  var v = normalizeVectorWeights(vectorInput);
  if (isAuto(d, v)) return '';
  var lines = ['本场裁判倾向（由用户设定·三维权重 + 六向度看重程度）：'];
  // 三维整体权重
  lines.push(dimLineText(d));
  // 六向度（单向看重程度）
  var parts = DIMENSIONS.map(function (k) { return k + ' ' + v[k] + '（' + valueLabel(v[k]) + '）'; });
  lines.push('六向度看重程度：' + parts.join(' ｜ ') + '（100=极高，0=不在意，50=常规）');
  // 派生维内倾向（仅对有对比差的轴输出）
  var derived = deriveAllAxes(v).filter(function (a) { return a.side; });
  if (derived.length) {
    lines.push('维内倾向（由同轴两向度对比派生）：' + derived.map(function (a) { return a.text; }).join(' ｜ '));
  }
  lines.push('说明：三维权重决定整体侧重；各维内部倾向由对应一对向度的权重对比共同决定；六向度全部参与评判，仅看重程度不同。此为自然语言注意力引导，不参与数学公式计算。');
  return lines.join('\n');
}

// ---------- 深度档（沿用 v1） ----------
var DEPTH_DEFAULTS = { verdict: '标准', mainline: '标准全景图', clash: '标准5-8个' };
function isDefaultDepth(depth) {
  if (!depth) return true;
  return (!depth.verdict || depth.verdict === DEPTH_DEFAULTS.verdict) &&
    (!depth.mainline || depth.mainline === DEPTH_DEFAULTS.mainline) &&
    (!depth.clash || depth.clash === DEPTH_DEFAULTS.clash);
}
function depthBlockText(depth) {
  if (isDefaultDepth(depth)) return '';
  var d = {
    verdict: depth && depth.verdict ? depth.verdict : DEPTH_DEFAULTS.verdict,
    mainline: depth && depth.mainline ? depth.mainline : DEPTH_DEFAULTS.mainline,
    clash: depth && depth.clash ? depth.clash : DEPTH_DEFAULTS.clash
  };
  return [
    '',
    '---',
    '## 输出深度要求（用户自定义）',
    '',
    '- 胜负判决详细度：' + d.verdict + '（简明=判决+比分+一句话理由，省略判准对比；详细=含判准对比）',
    '- 主线分析深度：' + d.mainline + '（简述类型=类型标签+简化面板；逐环节追踪=完整面板+组间递进标签全量）',
    '- 交锋裁决详细度：' + d.clash + '（对应 C6 交锋表行数上限）',
    ''
  ].join('\n');
}

var TENDENCY_API = {
  DIM_KEYS: DIM_KEYS,
  DIM_DEFAULT: DIM_DEFAULT,
  DIMENSIONS: DIMENSIONS,
  VECTOR_DEFAULT: VECTOR_DEFAULT,
  PROFILE_KIND: PROFILE_KIND,
  PROFILE_VERSION: PROFILE_VERSION,
  PROFILE_V2_KIND: PROFILE_V2_KIND,
  PROFILE_V2_VERSION: PROFILE_V2_VERSION,
  AXES: AXES,
  DEPTH_DEFAULTS: DEPTH_DEFAULTS,
  normalizeDimWeights: normalizeDimWeights,
  normalizeVectorWeights: normalizeVectorWeights,
  normalizeTendencyProfile: normalizeTendencyProfile,
  valueLabel: valueLabel,
  isAuto: isAuto,
  deriveAxis: deriveAxis,
  deriveAllAxes: deriveAllAxes,
  dimLineText: dimLineText,
  tendencyText: tendencyText,
  isDefaultDepth: isDefaultDepth,
  depthBlockText: depthBlockText
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TENDENCY_API;
} else if (typeof JUDGE_WEB_GLOBALS !== 'undefined') {
  JUDGE_WEB_GLOBALS.tendency = TENDENCY_API;
}
