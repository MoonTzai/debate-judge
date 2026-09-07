'use strict';

// R7 白话化轮 · 阶段 1：结构感知解析 / 文本节点提取 / 机械回填 / 结构校验
// ---------------------------------------------------------------
// 定位：报告后处理（独立脚本，不重渲染、不改 DOM 结构、不新增依赖）。
// 阶段 1 为恒等透传：解析 → 提取翻译单元 → 原样回填 → 结构校验，输出与输入字节一致。
// 阶段 2 将接入 LLM 翻译（本模块已预留 translate 钩子）。
//
// 用法：
//   node scripts/plain-language.js <report.html> [-o <输出.html>]
//        [--dump-units <units.json>] [--check-only]
//
// 硬门禁：任一结构差异 → 阻断输出（processReport 抛错，CLI 非零退出，不落盘半成品）。

const fs = require('fs');
const path = require('path');

// S1 完整版：HTML 结构身份单一事实源 = html-contract.js（关键块清单/正则/容器语义/遍历/契约检查）
// 本模块保留解析/翻译/合并/白名单职责；下列函数自本模块迁出后以 re-export 兼容既有消费（PL.* 签名不变）
const HC = require('./html-contract.js');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
]);
// style/script/textarea/title 内容按原始文本整体消费，直到对应闭合标签
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
// 不产生翻译单元的子树（样式、脚本、图表内部、head 元信息）
const SKIP_TAGS = new Set(['head', 'svg', 'script', 'style', 'title', 'meta', 'link']);
// 语义容器（用于确定翻译单元的区块类型与父链上下文）
const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'td', 'th', 'caption', 'li',
  'summary', 'div', 'details', 'ul', 'ol', 'table', 'tr', 'tbody', 'thead',
  'nav', 'section', 'article', 'aside', 'figure', 'figcaption'
]);
const BLOCK_TYPE = {
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  p: 'paragraph', td: 'table-cell', th: 'table-cell', caption: 'caption', li: 'list-item',
  summary: 'summary', div: 'block', details: 'block', ul: 'list', ol: 'list', table: 'table',
  tr: 'row', tbody: 'table-body', thead: 'table-head', nav: 'block', section: 'block',
  article: 'block', aside: 'block', figure: 'block', figcaption: 'caption'
};

// ---------- 受限解析 ----------

function tokenize(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;

  const pushText = (start, end) => {
    if (end > start) tokens.push({ type: 'text', raw: html.slice(start, end), start, end });
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { pushText(i, n); break; }
    pushText(i, lt);

    // HTML 注释
    if (html.startsWith('<!--', lt)) {
      const endIdx = html.indexOf('-->', lt + 4);
      const close = endIdx === -1 ? n : endIdx + 3;
      tokens.push({ type: 'comment', raw: html.slice(lt, close), start: lt, end: close });
      i = close;
      continue;
    }
    // DOCTYPE
    if (html.slice(lt, lt + 10).toLowerCase().startsWith('<!doctype')) {
      const gt = html.indexOf('>', lt);
      const close = gt === -1 ? n : gt + 1;
      tokens.push({ type: 'doctype', raw: html.slice(lt, close), start: lt, end: close });
      i = close;
      continue;
    }
    // 其它 <! 声明：保守保留为 comment 节点，保证字节不回退
    if (html[lt + 1] === '!') {
      const gt = html.indexOf('>', lt);
      const close = gt === -1 ? n : gt + 1;
      tokens.push({ type: 'comment', raw: html.slice(lt, close), start: lt, end: close });
      i = close;
      continue;
    }
    // 闭合标签
    if (html[lt + 1] === '/') {
      let p = lt + 2;
      while (p < n && /\s/.test(html[p])) p++;
      let name = '';
      while (p < n && /[A-Za-z0-9-]/.test(html[p])) { name += html[p]; p++; }
      const gt = html.indexOf('>', p);
      const close = gt === -1 ? n : gt + 1;
      tokens.push({ type: 'close', tag: name.toLowerCase(), raw: html.slice(lt, close), start: lt, end: close });
      i = close;
      continue;
    }
    // 开始标签（含自闭合）
    if (html[lt + 1] === '?' || /[A-Za-z]/.test(html[lt + 1] || '')) {
      let p = lt + 1;
      let name = '';
      while (p < n && /[A-Za-z0-9-]/.test(html[p])) { name += html[p]; p++; }
      const attrs = [];
      let selfClosing = false;
      while (p < n) {
        while (p < n && /\s/.test(html[p])) p++;
        if (p >= n) break;
        const c = html[p];
        if (c === '>') { p++; break; }
        if (c === '/' && html[p + 1] === '>') { selfClosing = true; p += 2; break; }
        let an = '';
        while (p < n && !/[\s=/>]/.test(html[p])) { an += html[p]; p++; }
        while (p < n && /\s/.test(html[p])) p++;
        let av = null;
        if (html[p] === '=') {
          p++;
          while (p < n && /\s/.test(html[p])) p++;
          if (p < n && (html[p] === '"' || html[p] === "'")) {
            const q = html[p]; p++;
            let val = '';
            while (p < n && html[p] !== q) { val += html[p]; p++; }
            if (p < n) p++;
            av = val;
          } else {
            let val = '';
            while (p < n && !/[\s>]/.test(html[p])) { val += html[p]; p++; }
            av = val;
          }
        }
        attrs.push({ name: an.toLowerCase(), value: av });
      }
      const raw = html.slice(lt, p);
      tokens.push({ type: 'open', tag: name.toLowerCase(), attrs, selfClosing, raw, start: lt, end: p });
      i = p;
      const lower = name.toLowerCase();
      // style/script/textarea/title：内容按原始文本消费到闭合标签
      if (RAW_TEXT_TAGS.has(lower)) {
        const re = new RegExp('</' + lower + '\\s*>', 'i');
        const m = html.slice(i).match(re);
        if (m) {
          const textEnd = i + m.index;
          const closeStart = textEnd;
          const closeEnd = closeStart + m[0].length;
          pushText(i, textEnd);
          tokens.push({ type: 'close', tag: lower, raw: html.slice(closeStart, closeEnd), start: closeStart, end: closeEnd });
          i = closeEnd;
        } else {
          pushText(i, n);
          i = n;
        }
      }
      continue;
    }
    // 未知 '<' → 当作文本保守保留
    pushText(lt, lt + 1);
    i = lt + 1;
  }
  return tokens;
}

function buildTree(tokens) {
  const root = {
    type: 'root',
    start: 0,
    end: tokens.length ? tokens[tokens.length - 1].end : 0,
    children: []
  };
  const stack = [root];
  for (const tok of tokens) {
    if (tok.type === 'open') {
      const el = {
        type: 'element',
        tag: tok.tag,
        attrs: tok.attrs,
        rawOpen: tok.raw,
        rawClose: null,
        selfClosing: tok.selfClosing,
        start: tok.start,
        end: tok.end,
        children: []
      };
      stack[stack.length - 1].children.push(el);
      if (!tok.selfClosing && !VOID_TAGS.has(tok.tag)) stack.push(el);
    } else if (tok.type === 'close') {
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].type === 'element' && stack[k].tag === tok.tag) { idx = k; break; }
      }
      if (idx > 0) {
        const el = stack[idx];
        el.rawClose = tok.raw;
        el.end = tok.end;
        stack.length = idx;
      } else {
        // 未匹配的闭合标签：保守保留为文本节点，保证字节不回退
        stack[stack.length - 1].children.push({ type: 'text', raw: tok.raw, start: tok.start, end: tok.end });
      }
    } else {
      stack[stack.length - 1].children.push({ type: tok.type, raw: tok.raw, start: tok.start, end: tok.end });
    }
  }
  return root;
}

function parseHtml(html) {
  return buildTree(tokenize(html));
}

function serializeHtml(root) {
  let out = '';
  const walk = node => {
    if (node.type === 'element') {
      out += node.rawOpen;
      for (const ch of node.children) walk(ch);
      if (node.rawClose) out += node.rawClose;
    } else {
      out += node.raw;
    }
  };
  for (const ch of root.children) walk(ch);
  return out;
}

// ---------- 文本节点提取（翻译单元） ----------

function extractUnits(root) {
  const units = [];
  let seq = 0;
  const walk = (node, ctx) => {
    if (node.type === 'root') {
      for (const ch of node.children) walk(ch, ctx);
    } else if (node.type === 'element') {
      const cls = HC.attrValue(node, 'class') || '';
      const id = HC.attrValue(node, 'id') || '';
      const m = /(?:^|\s)c-module\s+c(\d+)\b/.exec(cls) || /^c(\d+)$/.exec(id);
      const nc = { ...ctx };
      if (m) nc.module = 'C' + m[1];
      if (BLOCK_TAGS.has(node.tag)) {
        nc.blockTag = node.tag;
        nc.blockClasses = cls || null;
      }
      nc.path = ctx.path.concat(node.tag + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''));
      if (SKIP_TAGS.has(node.tag)) return;
      for (const ch of node.children) walk(ch, nc);
    } else if (node.type === 'text') {
      if (/\S/.test(node.raw)) {
        const unit = {
          id: 'u' + String(seq).padStart(6, '0'),
          text: node.raw,
          module: ctx.module || null,
          blockType: BLOCK_TYPE[ctx.blockTag] || (ctx.blockTag ? 'block' : 'root'),
          containerTag: ctx.blockTag || null,
          containerClasses: ctx.blockClasses,
          path: ctx.path
        };
        node.unitId = unit.id;
        units.push(unit);
        seq++;
      }
    }
  };
  walk(root, { module: null, blockTag: null, blockClasses: null, path: [] });
  return units;
}

// ---------- 机械回填 ----------

function backfillUnits(root, byId) {
  const walk = node => {
    if (node.type === 'root' || node.type === 'element') {
      for (const ch of node.children) walk(ch);
    } else if (node.type === 'text' && node.unitId && byId.has(node.unitId)) {
      node.raw = byId.get(node.unitId);
    }
  };
  walk(root);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- 结构校验（硬门禁） ----------

function structureDiff(a, b, p) {
  const base = p || '/';
  if (a.type !== b.type) return { path: base, reason: '节点类型 ' + a.type + ' ≠ ' + b.type };
  if (a.type === 'element') {
    if (a.tag !== b.tag) return { path: base + '/' + a.tag, reason: '标签 ' + a.tag + ' ≠ ' + b.tag };
    const aa = a.attrs || [];
    const ba = b.attrs || [];
    if (aa.length !== ba.length) {
      return { path: base + '/' + a.tag, reason: '属性数量 ' + aa.length + ' ≠ ' + ba.length };
    }
    for (let k = 0; k < aa.length; k++) {
      if (aa[k].name !== ba[k].name || aa[k].value !== ba[k].value) {
        return {
          path: base + '/' + a.tag + '[' + k + ']',
          reason: '属性 ' + aa[k].name + ' 不一致'
        };
      }
    }
  } else if (a.type !== 'root') {
    // text/comment/doctype：内容不参与结构比较
    return null;
  }
  const ac = a.children || [];
  const bc = b.children || [];
  if (ac.length !== bc.length) {
    const label = a.type === 'root' ? 'root' : a.tag;
    return { path: base + '/' + label, reason: '子节点数量 ' + ac.length + ' ≠ ' + bc.length };
  }
  for (let k = 0; k < ac.length; k++) {
    const label = a.type === 'root' ? 'root' : a.tag;
    const d = structureDiff(ac[k], bc[k], base + '/' + label + '[' + k + ']');
    if (d) return d;
  }
  return null;
}

// ---------- R7 阶段 2：白名单分类 / 双版本合并 ----------

// 白名单·静态形态规则（机械强制透传，不调用翻译）：数字/比分/轮次、ID（N#、M-ID、CP-ID、S# 字段键）、标记类内容、类型标签形态
// 词项集合（倾向/姿态/类型标签字面量）来自 REGISTRY.enums（getPlainWhitelist 生成），此处不再硬编码枚举词项
const WHITELIST_RE = [
  /^[\s\d:：\/.．\-—×xX%％+＋≈~～()（）\[\]【】、，,。；;]+$/,
  /\d+\s*[:：]\s*\d+/,
  // PLAIN-V2：ID/类型只有在“单元本身就是标签”时才整单元透传。
  // 过去这些正则只要命中句中一个 M/N/CP/1b 就把整句白名单化，导致大量正文从未进入白话层。
  /^\s*N\d+\s*$/,
  /^\s*M-[A-Za-z]+-\d+\s*$/,
  /^\s*CP-(?:[A-Za-z]+-)?\d+\s*$/,
  /^\s*S\d+(?:\.\d+)?(?:\.[^=\s]+)?\s*=.*$/,
  /^\s*(?:INSERT_[A-Z0-9_]+|<!--DATA|<!--\/DATA).*$/,
  /^\s*\d[a-z]\s*$/,
  /^\s*\d[a-z]\s*型\s*$/
];
// 结构保留项（C4/叙事专项后的法定结构，R7 不得改写关键词/顺序/标注）
const STRUCT_PRESERVE_MARKERS = ['（教学发挥·非裁决事实）', '立论预判', '全场终判', '修正证据', '成长建议'];
// 可译块容器 / 关键块清单 / 容器判定 / 元素遍历：单一事实源 = html-contract.js（HC re-export，见文件尾）

// 翻译单元分类：'translate' 可译；'whitelist' 机械透传（不调用翻译）
function classifyUnit(u) {
  if (!u || !u.text) return 'whitelist';
  // A2：报告交互控件不属于裁判正文；不得送入 R7，也不得计入双版本配对/覆盖率。
  if (isReportUiUnit(u)) return 'whitelist';
  // 章节标题与表头标签不译（白名单）
  if (u.blockType === 'heading' || u.containerTag === 'th') return 'whitelist';
  // C1 关键块（checkHtml D3 存在性断言，禁止改内容/注入属性）
  if (u.containerClasses && HC.isKeyBlockClass(u.containerClasses)) return 'whitelist';
  // 源锚层 v1（E-2）：免责横幅固定文案——含 DISCLAIMER_TEXT 的单元标记 fixed 不送译、合并透传
  if (HC.DISCLAIMER_TEXT && u.text.includes(HC.DISCLAIMER_TEXT)) return 'whitelist';
  for (const re of getPlainWhitelist()) if (re.test(u.text)) return 'whitelist';
  for (const mk of STRUCT_PRESERVE_MARKERS) if (u.text.includes(mk)) return 'whitelist';
  return 'translate';
}

// 按文档顺序遍历元素（merge 配对与结构 diff 共用同一 parse 树/同一遍历口径）——HC.iterElementsInOrder

function innerHtml(el) {
  if (!el || el.type !== 'element') return '';
  let out = '';
  const walk = n => {
    if (n.type === 'element') {
      out += n.rawOpen;
      for (const ch of n.children) walk(ch);
      if (n.rawClose) out += n.rawClose;
    } else out += n.raw;
  };
  for (const ch of el.children) walk(ch);
  return out;
}

// isUnitContainer / PLAIN_CONTAINER_TAGS：单一事实源 = html-contract.js（HC re-export）

function escapeAttr(s) {
  return escapeHtml(s);
}

function buildOpenTag(el) {
  let out = '<' + el.tag;
  for (const a of el.attrs || []) out += ' ' + a.name + '="' + escapeAttr(a.value === null ? '' : a.value) + '"';
  return out + '>';
}

// 双版本合并：把白话版 innerHTML 写入原文版对应元素 data-plain（同时写 data-orig），
// 白名单/未译块两版一致 → 不注入属性（切换时原样显示）。结构 diff 失败即阻断。
function mergePlainIntoOriginal(originalHtml, plainHtml) {
  const a = parseHtml(originalHtml);
  const b = parseHtml(plainHtml);
  const diff = structureDiff(a, b);
  if (diff) throw new Error('mergePlainIntoOriginal 阻断：' + diff.path + ' :: ' + diff.reason);
  const ea = HC.iterElementsInOrder(a);
  const eb = HC.iterElementsInOrder(b);
  if (ea.length !== eb.length) throw new Error('mergePlainIntoOriginal 阻断：元素数量不一致');
  for (let i = 0; i < ea.length; i++) {
    const oa = ea[i];
    if (!HC.isUnitContainer(oa)) continue;
    // C1 关键块（.po/.wn）禁止注入属性：checkHtml D3 用精确 class 正则，注入 data-* 会导致误判
    if (HC.isKeyBlockElement(oa)) continue;
    const origInner = innerHtml(oa);
    const plainInner = innerHtml(eb[i]);
    if (origInner === plainInner) continue;
    oa.attrs = (oa.attrs || []).filter(x => x.name !== 'data-plain' && x.name !== 'data-orig');
    oa.attrs.push({ name: 'data-orig', value: origInner });
    oa.attrs.push({ name: 'data-plain', value: plainInner });
    oa.rawOpen = buildOpenTag(oa);
  }
  return serializeHtml(a);
}

// 字典上下文提示：返回文本中命中的术语 → 白话释义（供 LLM 参考，不做机械替换）
function dictHintsForText(text, dict) {
  if (!dict || typeof dict !== 'object' || !text) return [];
  const hints = [];
  // 最长词优先，并抑制已被更长命中词覆盖的子串（“论证完成度”不重复要求“完成度”）。
  const entries = Object.entries(dict).sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], 'zh-CN'));
  for (const [term, gloss] of entries) {
    if (term && typeof gloss === 'string' && text.includes(term) && !hints.some(h => h.term.includes(term))) hints.push({ term, gloss });
  }
  return hints;
}

// A2：语义白话的术语要求以“可译正文的阅读顺序”为唯一事实源；首现处才要求解释。
function annotateSemanticRequirements(units, dict) {
  const seen = new Set();
  const requirements = [];
  for (const u of units || []) {
    if (classifyUnit(u) !== 'translate') continue;
    const own = [];
    for (const h of dictHintsForText(u.text, dict)) {
      if (seen.has(h.term)) continue;
      seen.add(h.term);
      const req = { unitId: u.id, term: h.term, gloss: h.gloss };
      own.push(req);
      requirements.push(req);
    }
    if (own.length) u.requiredGlosses = own;
  }
  return requirements;
}

function isReportUiUnit(u) {
  const pathText = Array.isArray(u && u.path) ? u.path.join(' ') : '';
  const cls = String((u && u.containerClasses) || '');
  return /(?:^|[.\s])theme-bar\b|(?:^|[.\s])api-config-wrap\b|(?:^|[.\s])plain-toggle\b/.test(pathText) ||
    /(?:^|\s)theme-bar\b|(?:^|\s)api-config-wrap\b|(?:^|\s)plain-toggle\b/.test(cls);
}

function checkRequiredGlosses(units, textForUnit) {
  const missing = [];
  for (const u of units || []) {
    const text = String(textForUnit(u.id) || '');
    for (const req of u.requiredGlosses || []) {
      const required = req.term + '（' + req.gloss + '）';
      if (!text.includes(required)) missing.push({ unitId: u.id, term: req.term, gloss: req.gloss });
    }
  }
  return { ok: missing.length === 0, missing };
}

function comparableUnits(html) {
  return extractUnits(parseHtml(html)).filter(u => !isReportUiUnit(u));
}

function checkSemanticPlain(origHtml, plainHtml, dict) {
  const origAll = extractUnits(parseHtml(origHtml));
  const plainAll = extractUnits(parseHtml(plainHtml));
  const orig = origAll.filter(u => !isReportUiUnit(u));
  const plain = plainAll.filter(u => !isReportUiUnit(u));
  const requirements = annotateSemanticRequirements(origAll, dict);
  const indexById = new Map(orig.map((u, i) => [u.id, i]));
  const missing = [];
  for (const req of requirements) {
    const i = indexById.get(req.unitId);
    const text = i === undefined || !plain[i] ? '' : plain[i].text;
    if (!text.includes(req.term + '（' + req.gloss + '）')) missing.push(req);
  }
  return { ok: orig.length === plain.length && missing.length === 0, requirements, missing, stats: { origUnits: orig.length, plainUnits: plain.length } };
}

// ---------- S2：枚举注册表驱动的白名单（单一事实源） ----------

const ENUM_REGISTRY_RE = /<!--REGISTRY_START-->\s*```json\s*([\s\S]*?)\s*```\s*<!--REGISTRY_END-->/;
let PLAIN_ENUM_STATE = null; // { path, mtimeMs, enums, whitelist }

// escapeRegExp：单一事实源 = html-contract.js（HC re-export）

function defaultSkillPath() {
  return path.join(__dirname, '..', 'Skill-Judge.md');
}

// 读取 REGISTRY.enums；缓存绑定 Skill-Judge.md mtime，force 可强制重解析（审计采纳）
function loadPlainEnums(skillPath, force) {
  const p = skillPath || defaultSkillPath();
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch (e) { mtime = -1; }
  if (!force && PLAIN_ENUM_STATE && PLAIN_ENUM_STATE.path === p && PLAIN_ENUM_STATE.mtimeMs === mtime) {
    return PLAIN_ENUM_STATE.enums;
  }
  let enums = {};
  if (mtime >= 0) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      const m = content.match(ENUM_REGISTRY_RE);
      if (m) {
        const reg = JSON.parse(m[1].trim());
        if (reg && typeof reg.enums === 'object') enums = reg.enums;
      }
    } catch (e) { enums = {}; }
  }
  PLAIN_ENUM_STATE = { path: p, mtimeMs: mtime, enums, whitelist: null };
  return enums;
}

// 从注册表派生词项集合（倾向/姿态/类型标签）；返回正则数组
function buildEnumWhitelistPatterns(enums) {
  enums = enums || {};
  // 倾向/姿态是法定枚举字面量，维持既有“句中命中即保护”边界。
  const protectedParts = [];
  const pushProtected = vals => {
    for (const v of vals || []) if (typeof v === 'string' && v.trim()) protectedParts.push(HC.escapeRegExp(v.trim()));
  };
  pushProtected(enums['报告.倾向枚举']);
  pushProtected(enums['C8.叙事人格.姿态标签']);

  // PLAIN-V2：主线类型只在“单元本身就是类型标签”时整单元透传；
  // “判定1b型（……）”这类完整解释句必须进入白话层，类型字面由生成/语义门保护。
  const typeParts = [];
  const typeVals = new Set();
  for (const v of enums['S11.类型'] || []) typeVals.add(String(v) + '型');
  for (const v of enums['S8.S11类型方向'] || []) typeVals.add(String(v));
  for (const v of typeVals) if (v.trim()) typeParts.push(HC.escapeRegExp(v.trim()));

  const out = [];
  if (protectedParts.length) out.push(new RegExp('(?:' + protectedParts.join('|') + ')'));
  if (typeParts.length) out.push(new RegExp('^\\s*(?:' + typeParts.join('|') + ')\\s*$'));
  return out;
}

// 白名单 = 静态形态规则 + 注册表词项集合；mtime 缓存 + force（审计采纳）
function getPlainWhitelist(skillPath, force) {
  const p = skillPath || defaultSkillPath();
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch (e) { mtime = -1; }
  if (!force && PLAIN_ENUM_STATE && PLAIN_ENUM_STATE.path === p && PLAIN_ENUM_STATE.mtimeMs === mtime && PLAIN_ENUM_STATE.whitelist) {
    return PLAIN_ENUM_STATE.whitelist;
  }
  const enums = loadPlainEnums(p, force);
  const whitelist = WHITELIST_RE.concat(buildEnumWhitelistPatterns(enums));
  PLAIN_ENUM_STATE = { path: p, mtimeMs: mtime, enums, whitelist };
  return whitelist;
}

// ---------- S4：验收工具下沉为被测 API（收敛 r7-stage3-pairs/acceptance/reapply 配对与对照逻辑） ----------

// 双版本对照：按文档序提取单元并索引配对（iterElementsInOrder 同口径）；
// 索引不一致（plainUnits.length !== units.length）→ ok=false；
// changed = 文本不同的单元；whitelistResidue = 被判白名单却文本不同的单元（>0 → ok=false）
function compareVersions(origHtml, plainHtml) {
  const units = comparableUnits(origHtml);
  const plainUnits = comparableUnits(plainHtml);
  const changed = [];
  const whitelistResidue = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const t = plainUnits[i];
    if (t && t.text !== u.text) {
      const item = { id: u.id, module: u.module, blockType: u.blockType, orig: u.text, plain: t.text };
      changed.push(item);
      if (classifyUnit(u) === 'whitelist') whitelistResidue.push(item);
    }
  }
  const ok = plainUnits.length === units.length && whitelistResidue.length === 0;
  return {
    ok,
    changed,
    whitelistResidue,
    stats: {
      origUnits: units.length,
      plainUnits: plainUnits.length,
      changed: changed.length,
      whitelistResidue: whitelistResidue.length
    }
  };
}

// 白名单机械重放：新判白名单的单元还原原文、其余保留译文，走 processReportAsync 机械回填
async function reapplyWhitelist(origHtml, llmPlainHtml) {
  const units = extractUnits(parseHtml(origHtml));
  const llmUnits = extractUnits(parseHtml(llmPlainHtml));
  const byId = new Map();
  let reverted = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const t = llmUnits[i] ? llmUnits[i].text : u.text;
    if (classifyUnit(u) === 'whitelist') {
      if (t !== u.text) reverted++;
      byId.set(u.id, u.text);
    } else {
      byId.set(u.id, t);
    }
  }
  const res = await processReportAsync(origHtml, { strictIdentity: false, translateUnits: () => byId });
  return { html: res.html, reverted };
}

// ---------- 处理入口 ----------

// opts.translate(unit) → string（同步逐条翻译；缺省为阶段 1 恒等透传）
// opts.translateUnits(units, info) → string[] | Map<id,string>（阶段 2 批量翻译，见 processReportAsync）
// opts.strictIdentity：阶段 1 默认 true（输出必须与输入字节一致）；阶段 2 传 false
function finalizeProcess(root, units, byId, html, opts) {
  backfillUnits(root, byId);
  const out = serializeHtml(root);
  if (opts.strictIdentity !== false && out !== html) {
    throw new Error('恒等校验失败：阶段 1 输出必须与输入字节一致');
  }
  const outRoot = parseHtml(out);
  const diff = structureDiff(root, outRoot);
  if (diff) throw new Error('结构校验失败：' + diff.path + ' :: ' + diff.reason);
  const unitChars = units.reduce((s, u) => s + u.text.length, 0);
  const translatable = units.filter(u => classifyUnit(u) === 'translate').length;
  // 覆盖率统计：可译字符 = 总文本字符 − 白名单豁免字符；已译字符 = 实际被改写的可译单元字符
  let whitelistChars = 0;
  let translatableChars = 0;
  let translatedChars = 0;
  let changedUnits = 0;
  let unchangedTranslatable = 0;
  for (const u of units) {
    if (classifyUnit(u) === 'whitelist') { whitelistChars += u.text.length; continue; }
    translatableChars += u.text.length;
    const t = byId.get(u.id);
    if (typeof t === 'string' && t !== u.text) { translatedChars += u.text.length; changedUnits++; }
    else unchangedTranslatable++;
  }
  const coveragePct = translatableChars ? Math.round((translatedChars / translatableChars) * 1000) / 10 : 100;
  return {
    html: out,
    units,
    stats: {
      inputChars: html.length,
      outputChars: out.length,
      units: units.length,
      unitChars,
      translatable,
      whitelisted: units.length - translatable,
      coverage: {
        totalChars: unitChars,
        translatableChars,
        whitelistChars,
        translatedChars,
        changedUnits,
        unchangedTranslatable,
        coveragePct
      }
    }
  };
}

function processReport(html, opts = {}) {
  const root = parseHtml(html);
  const units = extractUnits(root);
  const byId = new Map();
  if (typeof opts.translate === 'function') {
    for (const u of units) {
      const t = opts.translate(u);
      if (typeof t !== 'string') throw new Error('翻译结果必须是字符串：' + u.id);
      byId.set(u.id, t);
    }
  }
  return finalizeProcess(root, units, byId, html, opts);
}

// 阶段 2 异步入口：批量翻译（LLM）。仅可译单元交给 translateUnits；
// 白名单/结构保留单元机械透传（不调用翻译），防判决/比分/ID/标题被改写。
async function processReportAsync(html, opts = {}) {
  const root = parseHtml(html);
  const units = extractUnits(root);
  const byId = new Map();
  if (typeof opts.translateUnits === 'function') {
    const toTranslate = units.filter(u => classifyUnit(u) === 'translate');
    // 字典上下文提示（阶段 3）：命中术语附到单元上，供 LLM 参考；缺省无字典时零开销
    if (opts.dict) {
      for (const u of toTranslate) u.dictHints = dictHintsForText(u.text, opts.dict);
      annotateSemanticRequirements(toTranslate, opts.dict);
    }
    const res = await opts.translateUnits(toTranslate, {
      html,
      units,
      ...(opts.context || {})
    });
    for (let i = 0; i < toTranslate.length; i++) {
      let t;
      if (Array.isArray(res)) t = res[i];
      else if (res instanceof Map) t = res.get(toTranslate[i].id);
      else if (res && typeof res === 'object') t = res[toTranslate[i].id];
      if (typeof t !== 'string') throw new Error('翻译结果缺失或非字符串：' + toTranslate[i].id);
      byId.set(toTranslate[i].id, t);
    }
  } else if (typeof opts.translate === 'function') {
    for (const u of units) {
      const t = opts.translate(u);
      if (typeof t !== 'string') throw new Error('翻译结果必须是字符串：' + u.id);
      byId.set(u.id, t);
    }
  }
  return finalizeProcess(root, units, byId, html, opts);
}

// ---------- 工具 ----------

function countElements(node, tag) {
  let c = 0;
  if (node.type === 'root') {
    for (const ch of node.children || []) c += countElements(ch, tag);
  } else if (node.type === 'element') {
    if (node.tag === tag) c++;
    for (const ch of node.children || []) c += countElements(ch, tag);
  }
  return c;
}

// findElements / descendantElements：单一事实源 = html-contract.js（HC re-export）

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith('-'));
  const input = positional[0];
  if (!input) {
    console.error('用法：node scripts/plain-language.js <report.html> [-o <输出.html>] [--dump-units <units.json>] [--check-only]');
    process.exit(2);
  }
  const pick = (long, short) => {
    const i = args.indexOf(long);
    return i >= 0 ? i : (short ? args.indexOf(short) : -1);
  };
  const oi = pick('--output', '-o');
  const di = pick('--dump-units');
  if (oi >= 0 && !args[oi + 1]) {
    console.error('缺少输出路径：-o/--output 后必须跟 <输出.html>');
    process.exit(2);
  }
  const absInput = path.resolve(input);
  let output = oi >= 0 ? path.resolve(args[oi + 1]) : path.join(path.dirname(absInput), 'report-plain.html');
  if (oi < 0 && path.basename(absInput).toLowerCase() === 'report-plain.html') {
    output = path.join(path.dirname(absInput), 'report-plain-2.html');
  }
  if (path.resolve(output) === absInput) {
    console.error('拒绝覆盖原报告：输出路径与输入相同');
    process.exit(2);
  }
  const html = fs.readFileSync(absInput, 'utf8');
  const res = processReport(html); // 阶段 1：恒等透传 + 结构校验（硬门禁）
  if (!args.includes('--check-only')) fs.writeFileSync(output, res.html, 'utf8');
  if (di >= 0 && args[di + 1]) {
    fs.writeFileSync(path.resolve(args[di + 1]), JSON.stringify(res.units, null, 2), 'utf8');
  }
  const report = {
    ok: true,
    input: absInput,
    output,
    checkOnly: args.includes('--check-only'),
    units: res.units.length,
    unitChars: res.stats.unitChars,
    structureCheck: 'PASS'
  };
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();

module.exports = {
  parseHtml,
  serializeHtml,
  extractUnits,
  backfillUnits,
  escapeHtml,
  escapeAttr,
  structureDiff,
  processReport,
  processReportAsync,
  classifyUnit,
  iterElementsInOrder: HC.iterElementsInOrder,
  innerHtml,
  isUnitContainer: HC.isUnitContainer,
  mergePlainIntoOriginal,
  dictHintsForText,
  annotateSemanticRequirements,
  checkRequiredGlosses,
  checkSemanticPlain,
  isReportUiUnit,
  checkPlainContract: HC.checkPlainContract,
  loadPlainEnums,
  buildEnumWhitelistPatterns,
  getPlainWhitelist,
  escapeRegExp: HC.escapeRegExp,
  HTML_KEY_BLOCKS: HC.HTML_KEY_BLOCKS,
  countElements,
  findElements: HC.findElements,
  attrValue: HC.attrValue,
  // S1 完整版：契约层新增导出（单一事实源 html-contract.js，re-export 兼容）
  PLAIN_CONTAINER_TAGS: HC.PLAIN_CONTAINER_TAGS,
  descendantElements: HC.descendantElements,
  isKeyBlockClass: HC.isKeyBlockClass,
  isKeyBlockElement: HC.isKeyBlockElement,
  checkPlainToggleContract: HC.checkPlainToggleContract,
  buildKeyBlockRegex: HC.buildKeyBlockRegex,
  // S4：验收工具下沉（被测 API）
  compareVersions,
  reapplyWhitelist
};
