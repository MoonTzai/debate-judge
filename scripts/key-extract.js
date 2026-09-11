// key-extract.js — 键形提取单一引擎（卡 5，260815——方案见 Upload/方案-260815-卡5-键形引擎合并-细化方案.md）
// 权威 = key-checker consumeKeys 文档化 7 形态（消费侧）+ gic extractDataKeys 字典侧形态；
// key-checker / generate-input-contract 均 require 本模块——防双引擎漂移（KE-1）。
// 设计：执行函数式接口（每调用内部新建正则——无共享 lastIndex 污染）；
// 策略（文件列表/行级特征/消费上下文/展开规则）留在各自调用方。
'use strict';

// ---------- 键形判定（消费侧 7 形态共享） ----------
// 段字符白名单：ASCII 字母数字 + 汉字 + 圈号 ①-⑥（U+2460-2465）
const SEG_OK = /[^A-Za-z0-9\u4e00-\u9fff\u2460-\u2465]/;

function isKeyShape(k) {
  if (typeof k !== 'string') return false;
  if (k.length < 3 || k.length > 60) return false;
  if (!/^(S\d+|C\d+)\./.test(k)) return false;      // 仅 S#./C#. 前缀（数据键；排除 R 段名/V 规则/正文）
  if (/[=\s<>·：:,；()>]/.test(k)) return false;      // 消息文本/规则特征
  if (k.includes('-') || k.includes('.tmp')) return false; // 文件名/跨行残留
  if (k.endsWith('.')) return false;                // 裸前缀（归前缀形态）
  const segs = k.split('.');
  if (segs.some(s => !s)) return false;             // 空段（含连续点）
  if (segs.some(s => SEG_OK.test(s))) return false; // 段内非法字符
  return true;
}

// ---------- 消费侧形态扫描（key-checker consumeKeys 原语；返回 [{key, index}]） ----------

// ①⑥⑦ 直接字面量 data['X'] / data["X"] / data[`X`]
function scanDataQuote(src) {
  const re = /data\s*\[\s*(['"`])([^'"`\n]{1,60}?)\1\s*\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[2].trim(), index: m.index });
  return out;
}
// ② 拼接前缀 data['X.' + ...]
function scanConcatPrefix(src) {
  const re = /data\s*\[\s*['"]([^'"`\n]{1,40}?)['"]\s*\+/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1].trim(), index: m.index });
  return out;
}
// ③ 'X' in data
function scanInData(src) {
  const re = /'([^'\n]{1,60})'\s+in\s+data/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1].trim(), index: m.index });
  return out;
}
// ④ 行级扫描引用（cleanLines = 已 clean 的逐行数组（与源文件行对齐）；lineFilter = 行级特征判定回调（策略））
function scanLineQuote(cleanLines, lineFilter) {
  const re = /['"]([^'"\n]{1,60})['"]/g;
  const out = [];
  for (let i = 0; i < cleanLines.length; i++) {
    if (lineFilter && !lineFilter(cleanLines[i])) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cleanLines[i])) !== null) out.push({ key: m[1].trim(), line: i + 1 });
  }
  return out;
}
// ⑤ 模板插值前缀 data[`X.${v}`]
function scanTemplateInterp(src) {
  const re = /data\s*\[\s*`([^`\n]*)\$\{[^}]*\}[^`\n]*`\s*\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1].trim(), index: m.index });
  return out;
}
// ⑧ 模板串变量构造 `R2.5.${side}.${q}.对方对抗象限`（静态段前缀族；消息文本排除策略在调用方）
function scanVarTemplate(src) {
  const re = /`([^`\n]*\$\{[^}]*\}[^`\n]*)`/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1], index: m.index });
  return out;
}

// ---------- 字典侧形态扫描（gic extractDataKeys 原语；返回 [{key, index}]） ----------

function scanDictQuote(src) {
  // Approved data-container aliases only. Keep this literal-only: dynamic forms such as
  // allData['S1.' + side + '人数'] must not be materialized as bogus dictionary keys.
  const re = /\b(?:data|allData)\s*\[\s*(['"])([^'"\n]{1,60})\1\s*\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[2], index: m.index });
  return out;
}
function scanDictOrEmpty(src) {
  const re = /\(data\s*\|\|\s*\{\}\)\['([^']+)'\]|\(data\s*\|\|\s*\{\}\)\["([^"]+)"\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1] || m[2], index: m.index });
  return out;
}
function scanDictTemplate(src) {
  const re = /data\[`([^`]+)`\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1], index: m.index });
  return out;
}
function scanDictInData(src) {
  const re = /['"]((?:S|R2\.5|C7|C8)[A-Za-z0-9_.\u4e00-\u9fa5]*)['"]\s+in\s+data\b/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1], index: m.index });
  return out;
}
function scanDictArray(src) {
  const re = /const\s+\w+\s*=\s*\[\s*(['"](?:S|R2\.5|C7|C8)[A-Za-z0-9_.\u4e00-\u9fa5]*['"]\s*,?\s*)+\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ match: m[0], index: m.index });
  return out;
}

// ---------- 字典侧过滤器（防扩键破 data=125——仅 S/R2.5/C7/C8 入字典） ----------
function dictKeyFilter(k) {
  return /^(S|R2\.5|C7|C8)/.test(k);
}

// ---------- S2 论证完成度 8 键物化（源 = render-report L220 cats 逐字；非 PC ENUM——登记单一源待后续） ----------
const S2_CATS = ['充分', '初步', '未论证', '被击穿'];
function s2CompletionKeys() {
  const out = [];
  for (const side of ['正方', '反方']) for (const c of S2_CATS) out.push('S2.' + side + '.论证完成度.' + c);
  return out;
}

// ---------- 通用字面量提取（KE-5 破坏性自检用——消费侧①形态；返回键数组） ----------
function extractLiteralKeys(src) {
  return scanDataQuote(src).map(x => x.key);
}

module.exports = {
  isKeyShape, SEG_OK,
  scanDataQuote, scanConcatPrefix, scanInData, scanLineQuote, scanTemplateInterp, scanVarTemplate,
  scanDictQuote, scanDictOrEmpty, scanDictTemplate, scanDictInData, scanDictArray,
  dictKeyFilter, s2CompletionKeys, extractLiteralKeys
};
