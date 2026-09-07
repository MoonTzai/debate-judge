'use strict';

// S1 完整版：HTML 结构身份单一事实源（契约层）
// ---------------------------------------------------------------
// 零依赖叶子模块：不 require plain-language / pipeline-controller / render-report。
// 职责：关键块清单与属性无关正则（D3 消费）、data-* 注入容器白名单、元素遍历
//       （findElements / descendantElements / iterElementsInOrder）、
//       R7 结构契约检查（checkPlainContract）、注入后置条件契约（checkPlainToggleContract）。
// 迁移源（260808 S1 完整版）：plain-language.js（attrValue / PLAIN_CONTAINER_TAGS /
//       HTML_KEY_BLOCKS / iterElementsInOrder / isUnitContainer / escapeRegExp /
//       checkPlainContract / findElements）与 pipeline-controller.js d3KeyBlockRegex；
//       plain-language.js 改为本模块 re-export，消费方零改动。
// 扩展纪律：新增被 checkHtml 存在性断言（D3）直接正则匹配的关键块，必须同步 HTML_KEY_BLOCKS
//       并登记；data-* 注入白名单变更同步 PLAIN_CONTAINER_TAGS。
//
// 注：checkPlainContract 需要解析 HTML 文本，而本模块为"零依赖叶子模块"（不得 require
//     plain-language 等上层模块），故内置一份与 plain-language.js tokenize/buildTree/parseHtml
//     同构的受限解析副本；两处解析器行为由 tests/html-contract.test.js 与既有 fixture
//     断言锁定一致（待重构项：解析器抽为共享叶子模块后再单源化）。

// ---------- 受限解析（与 plain-language.js L42-197 同构） ----------

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
]);
// style/script/textarea/title 内容按原始文本整体消费，直到对应闭合标签
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

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

// ---------- 元素工具 ----------

function attrValue(node, name) {
  if (!node || node.type !== 'element' || !node.attrs) return null;
  const a = node.attrs.find(x => x.name === name);
  return a ? (a.value === null ? '' : a.value) : null;
}

// ---------- 关键块契约（D3 单一事实源） ----------

// 被 checkHtml 存在性断言（D3）直接正则匹配的关键块（单一事实源；pipeline-controller lazy require 消费）
const HTML_KEY_BLOCKS = [
  { cls: 'po', tag: 'div' },
  { cls: 'wn', tag: 'p' }
];

// 属性无关匹配（迁移自 pipeline-controller.js d3KeyBlockRegex）：class 命中即匹配，与其它属性顺序无关；
// 保留捕获组（po/wn 内容提取用 match()[1]）
function buildKeyBlockRegex(kb) {
  return new RegExp('<' + kb.tag + '[^>]*class="[^"]*\\b' + kb.cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/' + kb.tag + '>');
}

// class 字符串命中关键块（classifyUnit 白名单共用）
function isKeyBlockClass(cls) {
  return HTML_KEY_BLOCKS.some(kb => new RegExp('\\b' + kb.cls + '\\b').test(cls || ''));
}

// 元素命中关键块（merge 跳过注入共用）
function isKeyBlockElement(el) {
  if (!el || el.type !== 'element') return false;
  return isKeyBlockClass(attrValue(el, 'class'));
}

// ---------- 容器语义（data-* 注入白名单） ----------

// 可译块容器（merge 时注入 data-plain/data-orig 的候选）
const PLAIN_CONTAINER_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'li', 'caption']);

function isUnitContainer(el) {
  if (!el || el.type !== 'element') return false;
  if (PLAIN_CONTAINER_TAGS.has(el.tag)) return true;
  if (el.tag === 'div') return (el.children || []).some(ch => ch.type === 'text' && /\S/.test(ch.raw));
  return false;
}

// ---------- 元素遍历 ----------

// 含自身语义（既有消费兼容；迁移自 plain-language.js findElements）
function findElements(node, pred, out) {
  out = out || [];
  if (node.type === 'root') {
    for (const ch of node.children || []) findElements(ch, pred, out);
  } else if (node.type === 'element') {
    if (pred(node)) out.push(node);
    for (const ch of node.children || []) findElements(ch, pred, out);
  }
  return out;
}

// 不含自身（嵌套 table 检测等；审计 #6 落地）
function descendantElements(el, pred, out) {
  out = out || [];
  if (!el || el.type !== 'element') return out;
  for (const ch of el.children || []) findElements(ch, pred, out);
  return out;
}

// 按文档顺序遍历元素（merge 配对与结构 diff 共用同一 parse 树/同一遍历口径）
function iterElementsInOrder(root) {
  const out = [];
  const walk = node => {
    if (node.type === 'root') {
      for (const ch of node.children || []) walk(ch);
    } else if (node.type === 'element') {
      out.push(node);
      for (const ch of node.children || []) walk(ch);
    }
  };
  walk(root);
  return out;
}

// ---------- 结构契约检查（R7 漂移告警） ----------

// R7 结构契约漂移检查（阶段 2/3 独立告警，纳入测试）：
// C 模块齐全、无嵌套 table（descendantElements）、data-* 只出现在容器元素
function checkPlainContract(html) {
  const root = parseHtml(html);
  const warnings = [];
  for (let i = 1; i <= 12; i++) {
    const found = findElements(root, el =>
      el.tag === 'div' && new RegExp('\\bc-module\\s+c' + i + '\\b').test(attrValue(el, 'class') || ''));
    if (!found.length) warnings.push('C' + i + ' 模块缺失');
  }
  const tables = findElements(root, el => el.tag === 'table');
  for (const t of tables) {
    if (descendantElements(t, el => el.tag === 'table').length) warnings.push('嵌套 table');
  }
  const badAttr = [];
  for (const el of iterElementsInOrder(root)) {
    if ((el.attrs || []).some(a => a.name === 'data-plain' || a.name === 'data-orig') && !isUnitContainer(el)) {
      badAttr.push(el.tag);
    }
  }
  if (badAttr.length) warnings.push('data-* 出现在非容器元素: ' + badAttr.join(','));
  return { ok: warnings.length === 0, warnings };
}

// ---------- 注入后置条件契约（审计 #5；仅测试侧断言，不改 render-report.js 行为） ----------

// 输入含 data-plain → 注入后必须含 id="plainBtn" + onclick="togglePlain()"；
// 无 data-plain → 原样返回；幂等（重复注入不叠加，由测试侧二次调用断言）
function checkPlainToggleContract(inputHtml, outputHtml) {
  const issues = [];
  const hasPlain = /data-plain=/.test(String(inputHtml || ''));
  if (!hasPlain) {
    if (outputHtml !== inputHtml) issues.push('无 data-plain 输入应原样返回');
    return { ok: issues.length === 0, issues };
  }
  const out = String(outputHtml || '');
  if (!out.includes('id="plainBtn"')) issues.push('注入结果缺 id="plainBtn"');
  if (!out.includes('onclick="togglePlain()"')) issues.push('注入结果缺 onclick="togglePlain()"');
  const btnCount = (out.match(/id="plainBtn"/g) || []).length;
  if (btnCount > 1) issues.push('重复注入：plainBtn 出现 ' + btnCount + ' 次');
  return { ok: issues.length === 0, issues };
}

// ---------- 通用小工具 ----------

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 免责声明（源锚层 v1，E-2/G-1 单一事实源） ----------
// 触发条件：类型 A（辩位不齐 且 身份登记不齐）或 类型 B（结构性缺失，用户确认继续）
// 消费者：render-report.js（注入横幅）/ plain-language.js（fixed 保护不送译）/ pipeline-controller.js（checkHtml 门禁）
const DISCLAIMER_TEXT = '本报告所分析的辩词具体发言归属登记不明确/齐全，内容判断可能存在严重失真，仅供参考';

module.exports = {
  parseHtml,
  attrValue,
  HTML_KEY_BLOCKS,
  buildKeyBlockRegex,
  isKeyBlockClass,
  isKeyBlockElement,
  PLAIN_CONTAINER_TAGS,
  isUnitContainer,
  findElements,
  descendantElements,
  iterElementsInOrder,
  checkPlainContract,
  checkPlainToggleContract,
  escapeRegExp,
  DISCLAIMER_TEXT
};
