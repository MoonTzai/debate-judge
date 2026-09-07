// Debate-Judge Ω1 · render-report.js（C3 骨架·两段式）
// 阶段一输入契约：transition-final.md + 叙事.md → normalized content model → report.html
// 阶段二输入契约：审判模型.json + presentation.json + 叙事（parseInputs 换前端，renderHTML 复用）
// C4（图表）/C5（C3 面板）/C6（表格/裹文/判决文本）以明确桩位填充；本骨架保证端到端结构可跑。
'use strict';

const fs = require('fs');
const path = require('path');
const assetsDir = __dirname + '/assets';
// 卡 9（260815）：RR 去 PC 依赖——6 个解析器/注册表函数自契约模块（卡 6 委托链引用等价）；CLI 块 PC 依赖动态 require（require.main 守卫）
const contract = require('./executor/contract.js');
const RT = require('./render-tables.js'); // renderTable/processInlineBold（复用已验证实现）

// 卡 9（260815）：html-contract 动态 require 静态化（顶层——浏览器端可打包）
const HC3 = require('./scripts/html-contract.js');

// A7-B3（提前到 B2 供 renderHTML 使用）：单文件读取端——资产文件优先、Skill-Judge.md 内嵌块回退
function readAssetText(name) {
  const file = path.join(assetsDir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');
  const skill = fs.readFileSync(path.join(__dirname, 'Skill-Judge.md'), 'utf-8');
  const map = { 'report.css': 'CSS', 'skeleton.html': 'SKELETON', 'charts-constants.js': 'CHARTS_CONSTANTS' };
  const re = new RegExp('<!-- EMBED_ASSET:' + map[name] + '_START -->\\s*```(?:css|html|javascript)\\s*([\\s\\S]*?)\\s*```\\s*<!-- EMBED_ASSET:' + map[name] + '_END -->');
  const m = skill.match(re);
  if (!m) throw new Error('资产缺失且内嵌块不存在: ' + name);
  return m[1].trim();
}

function loadConstants() {
  try { return require(assetsDir + '/charts-constants.js'); }
  catch (e) {
    const vm = require('vm');
    const sandbox = { module: { exports: {} } };
    vm.runInNewContext('(function(module){' + readAssetText('charts-constants.js') + '\n})(module);', sandbox);
    return sandbox.module.exports;
  }
}

const CH = loadConstants();

// ==================== C4a 图表函数（纯函数·常量表驱动） ====================

function r1(v) { return Math.round(v * 10) / 10; }

// A8-P2a: uniform chart injector - max-width comes only from CHART_MAXWIDTH registry.
function injectChart(svg, key) {
  if (!svg || svg.indexOf('<svg') < 0) return svg;
  const w = CH.CHART_MAXWIDTH && CH.CHART_MAXWIDTH[key];
  if (!w) { console.warn('[A8-P2a] CHART_MAXWIDTH unregistered: ' + key); return svg; }
  const style = 'width:100%;max-width:' + w + 'px;display:block;margin:0 auto';
  return svg.replace(/<svg([^>]*)>/, (m, attrs) => {
    const clean = attrs
      .replace(/\sstyle="[^"]*"/, '')
      .replace(/\swidth="[^"]*"/, '')
      .replace(/\sheight="auto"/, '')
      .replace(/\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
    return '<svg' + clean + ' width="100%" style="' + style + '" xmlns="http://www.w3.org/2000/svg">';
  });
}

// 雷达图（R6a-4.1：坐标常量表 + r=180×score/10）
function radarSVG(data) {
  const C = CH.radar;
  const scores = data.scores || {}; // {证伪:{pro,con},...}
  const vertex = (dim, side) => {
    const a = C.axes.find(x => x.dim === dim);
    const score = (scores[dim] && scores[dim][side]) || 0;
    const r = r1(C.rMax * score / C.max);
    return { x: r1(C.cx + a.cos * r), y: r1(C.cy - a.sin * r) };
  };
  const poly = side => C.axes.map(a => { const p = vertex(a.dim, side); return p.x + ',' + p.y; }).join(' ');
  const parts = [];
  parts.push('<svg viewBox="' + C.viewBox + '" xmlns="http://www.w3.org/2000/svg">');
  // A8-P2a：图表样式单一所有权——类样式由全局 report.css 提供，SVG 不再内联 <style>
  C.refRings.forEach(r => parts.push('<circle cx="' + C.cx + '" cy="' + C.cy + '" r="' + r + '" class="ref-ring"/>'));
  C.axes.forEach(a => {
    parts.push('<line x1="' + C.cx + '" y1="' + C.cy + '" x2="' + a.lx + '" y2="' + a.ly + '" class="axis-line"/>');
    parts.push('<text x="' + a.lx + '" y="' + a.ly + '" class="axis-label">' + a.dim + '</text>');
  });
  parts.push('<polygon points="' + poly('pro') + '" fill="' + C.pro.fill + '" stroke="' + C.pro.stroke + '" stroke-width="2"/>');
  parts.push('<polygon points="' + poly('con') + '" fill="' + C.con.fill + '" stroke="' + C.con.stroke + '" stroke-width="2"/>');
  C.axes.forEach(a => {
    const p = vertex(a.dim, 'pro'); parts.push('<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="' + C.pro.stroke + '"/>');
    const c = vertex(a.dim, 'con'); parts.push('<circle cx="' + c.x + '" cy="' + c.y + '" r="4" fill="' + C.con.stroke + '"/>');
  });
  parts.push('<rect x="60" y="545" width="14" height="14" fill="' + C.pro.stroke + '"/><text x="80" y="558" class="radar-legend">正方</text>');
  parts.push('<rect x="250" y="545" width="14" height="14" fill="' + C.con.stroke + '"/><text x="270" y="558" class="radar-legend">反方</text>');
  parts.push('</svg>');
  // R6a-4.1 L1 数据忠实度：SVG 闭合后必须输出 RADAR_DATA 注释（供 checkHtml 机械校验；顺序=规则示例对子序）
  const radarOrder = ['证伪', '证成', '理性', '感性', '场面感', '意义感'];
  const radarData = radarOrder.map(d => {
    const s = scores[d] || { pro: 0, con: 0 };
    return d + '.正方=' + (s.pro || 0) + ',' + d + '.反方=' + (s.con || 0);
  }).join(',');
  parts.push('<!--RADAR_DATA: ' + radarData + '-->');
  return parts.join('\n');
}

// 柱状图（R6a-4.2：常量表 + 坐标公式；A7-B3：可选标题参数用于箭头拆分双图）
function barSVG(data, title, detail) {
  const C = CH.bar;
  const pro = data.pro || [0, 0, 0, 0];
  const con = data.con || [0, 0, 0, 0];
  const cats = ['充分', '初步', '未论证', '被击穿'];
  const all = pro.concat(con);
  const dataMax = Math.max.apply(null, all);
  const yMax = dataMax + 1;
  const perU = r1(C.chartH / yMax);
  const yOf = n => r1(C.CB - n * perU);
  const parts = [];
  if (title) parts.push('<div style="text-align:center;font-weight:bold;font-size:1.05em;margin:12px 0 4px 0">' + title + '</div>');
  parts.push('<svg viewBox="' + C.viewBox + '" xmlns="http://www.w3.org/2000/svg">');
  parts.push('<line x1="' + C.CL + '" y1="' + C.CT + '" x2="' + C.CL + '" y2="' + C.CB + '" class="axis"/>');
  parts.push('<line x1="' + C.CL + '" y1="' + C.CB + '" x2="' + C.CR + '" y2="' + C.CB + '" class="axis"/>');
  for (let n = 0; n <= yMax; n++) {
    const y = yOf(n);
    parts.push('<line x1="' + (C.CL - 4) + '" y1="' + y + '" x2="' + C.CL + '" y2="' + y + '" stroke="#999"/>');
    parts.push('<text x="' + (C.CL - 10) + '" y="' + (y + 4) + '" text-anchor="end" font-size="' + C.labelFont + '">' + n + '</text>');
    if (n > 0) parts.push('<line x1="' + C.CL + '" y1="' + y + '" x2="' + C.CR + '" y2="' + y + '" stroke="' + C.gridColor + '" stroke-width="0.8" stroke-dasharray="6,3"/>');
  }
  // 260805：首柱与 y 轴保留 padL 边距、末柱与右缘保留 padR 边距（组间距按可用宽度均分）
  const padL = C.padL || 0, padR = C.padR || 0;
  const groupStep = (C.CR - C.CL - padL - padR - C.groupW) / (C.groupCount - 1);
  for (let k = 0; k < C.groupCount; k++) {
    const xk = C.CL + padL + k * groupStep;
    const draw = (count, color, x) => {
      const top = yOf(count), h = r1(count * perU);
      parts.push('<rect x="' + x + '" y="' + top + '" width="' + C.barW + '" height="' + h + '" fill="' + color + '" opacity="0.8"/>');
      parts.push('<text x="' + (x + C.barW / 2) + '" y="' + (top - 6) + '" text-anchor="middle" font-size="12">' + count + '</text>');
    };
    draw(pro[k], C.colorPro, xk);
    draw(con[k], C.colorCon, xk + C.barW + C.barGap);
    parts.push('<text x="' + (xk + C.groupW / 2) + '" y="' + (C.CB + 20) + '" text-anchor="middle" font-size="12">' + cats[k] + '</text>');
  }
  // 图例移至绘图区右侧留白（CR 之外），避免与末组柱体重叠
  parts.push('<rect x="' + (C.CR + 8) + '" y="50" width="14" height="14" fill="' + C.colorPro + '" opacity="0.8"/><text x="' + (C.CR + 28) + '" y="62" font-size="12">正方</text>');
  parts.push('<rect x="' + (C.CR + 8) + '" y="72" width="14" height="14" fill="' + C.colorCon + '" opacity="0.8"/><text x="' + (C.CR + 28) + '" y="84" font-size="12">反方</text>');
  parts.push('</svg>');
  // 260805：柱状图下按正反方列出各分论点的论证内容与完成明细
  if (detail && detail.items && detail.items.length) {
    parts.push('<div style="max-width:600px;margin:8px auto 0 auto;font-size:0.85em;line-height:1.7;color:var(--text)">');
    for (const side of ['正方', '反方']) {
      const b0 = side === '正方' ? detail.proB0 : detail.conB0;
      const items = detail.items.filter(x => x.side === side);
      if (!items.length) continue;
      parts.push('<div style="font-weight:600;color:var(--blue);margin:6px 0 2px 0">' + side + '</div>');
      if (b0) parts.push('<div style="margin:2px 0 4px 14px;color:var(--text-2)">B0（核心主张·每方唯一）：' + escapeHtml(b0) + '</div>');
      items.forEach((it, i) => {
        parts.push('<div style="margin:2px 0 2px 14px">' + ['①', '②', '③', '④', '⑤'][i] + ' ' + escapeHtml(it.label) + '（' + it.status + '）</div>');
      });
    }
    parts.push('</div>');
  }
  return parts.join('\n');
}

// 环形图（R6a-4.3：stroke-dasharray 线性计算·零三角函数）
function donutSVG(data) {
  const C = CH.donut;
  const n1 = data.n1 || 0, n2 = data.n2 || 0, n3 = data.n3 || 0;
  const total = data.total || (n1 + n2 + n3);
  if (!total) return '<svg viewBox="' + C.viewBox + '"><text x="200" y="180" text-anchor="middle" font-size="13" fill="var(--gray)">数据不可用</text></svg>';
  const len = v => r1(C.CIRCUMFERENCE * v / total);
  const l1 = len(n1), l2 = len(n2), l3 = len(n3);
  const dash = l => '"' + l + ' ' + r1(C.CIRCUMFERENCE - l) + '"';
  const blank = l => r1(C.CIRCUMFERENCE - l);
  const parts = [];
  parts.push('<svg viewBox="' + C.viewBox + '" xmlns="http://www.w3.org/2000/svg">');
  parts.push('<circle cx="' + C.CX + '" cy="' + C.CY + '" r="' + C.R + '" stroke="var(--border)" stroke-width="' + C.SW + '" fill="none"/>');
  parts.push('<circle cx="' + C.CX + '" cy="' + C.CY + '" r="' + C.R + '" stroke="' + C.colors[0] + '" stroke-width="' + C.SW + '" fill="none" stroke-dasharray=' + dash(l1) + ' stroke-dashoffset="' + C.QUARTER + '" stroke-linecap="butt"/>');
  parts.push('<circle cx="' + C.CX + '" cy="' + C.CY + '" r="' + C.R + '" stroke="' + C.colors[1] + '" stroke-width="' + C.SW + '" fill="none" stroke-dasharray=' + dash(l2) + ' stroke-dashoffset="' + r1(C.QUARTER - l1) + '" stroke-linecap="butt"/>');
  parts.push('<circle cx="' + C.CX + '" cy="' + C.CY + '" r="' + C.R + '" stroke="' + C.colors[2] + '" stroke-width="' + C.SW + '" fill="none" stroke-dasharray=' + dash(l3) + ' stroke-dashoffset="' + r1(C.QUARTER - l1 - l2) + '" stroke-linecap="butt"/>');
  parts.push('<text x="' + C.CX + '" y="152" text-anchor="middle" font-size="32" font-weight="bold" fill="var(--text)">' + total + '</text>');
  parts.push('<text x="' + C.CX + '" y="172" text-anchor="middle" font-size="12" fill="var(--gray)">交锋点</text>');
  C.legend.forEach((lg, i) => {
    const vals = [n1, n2, n3];
    parts.push('<rect x="' + lg.x + '" y="' + lg.y + '" width="12" height="12" fill="' + C.colors[i] + '"/><text x="' + (lg.x + 18) + '" y="' + (lg.y + 11) + '" font-size="11" fill="var(--text)">' + lg.label + ' (' + vals[i] + ')</text>');
  });
  parts.push('</svg>');
  return parts.join('\n');
}

// SC 微消化柱状图（R6a-4.4：条件触发）
function scBarSVG(data) {
  const C = CH.scBar;
  const proEff = data.proEff || 0, conEff = data.conEff || 0;
  if (proEff <= 0 && conEff <= 0) return '<!--CHART_MISSING:SC微消化柱状图·双方有效数均为0-->';
  const dataMax = Math.max(proEff, conEff);
  const yMax = Math.max(dataMax + 1, C.yMin);
  const perU = r1(C.chartH / yMax);
  const yOf = n => r1(C.CB - n * perU);
  const parts = [];
  parts.push('<svg viewBox="' + C.viewBox + '" xmlns="http://www.w3.org/2000/svg">');
  parts.push('<text x="220" y="20" text-anchor="middle" font-weight="bold" font-size="12">Phase II 微消化有效实例数</text>');
  parts.push('<line x1="' + C.CL + '" y1="' + C.CT + '" x2="' + C.CL + '" y2="' + C.CB + '" class="axis"/>');
  parts.push('<line x1="' + C.CL + '" y1="' + C.CB + '" x2="' + (C.CL + 280) + '" y2="' + C.CB + '" class="axis"/>');
  for (let n = 0; n <= yMax; n++) {
    const y = yOf(n);
    parts.push('<line x1="' + (C.CL - 10) + '" y1="' + y + '" x2="' + (C.CL - 4) + '" y2="' + y + '" stroke="#999"/>');
    parts.push('<text x="' + (C.CL - 10) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11">' + n + '</text>');
    if (n > 0) parts.push('<line x1="' + C.CL + '" y1="' + y + '" x2="' + (C.CL + 280) + '" y2="' + y + '" stroke="var(--border)" stroke-width="0.8" stroke-dasharray="4,4"/>');
  }
  const bar = (count, cx, color) => {
    const top = yOf(count), h = r1(count * perU);
    parts.push('<rect x="' + (cx - C.barW / 2) + '" y="' + top + '" width="' + C.barW + '" height="' + h + '" fill="' + color + '" opacity="0.8"/>');
    parts.push('<text x="' + cx + '" y="' + (top - 8) + '" text-anchor="middle" font-weight="bold" font-size="14">' + count + '</text>');
  };
  bar(proEff, C.barCxPro, C.colorPro);
  bar(conEff, C.barCxCon, C.colorCon);
  parts.push('<text x="' + C.barCxPro + '" y="252" text-anchor="middle" class="sc-label">正方</text>');
  parts.push('<text x="' + C.barCxCon + '" y="252" text-anchor="middle" class="sc-label">反方</text>');
  parts.push('</svg>');
  return parts.join('\n');
}

// 图表数据装配（从 DATA 键读取；缺失 → 数据不可用标注；A7-B3：+S2 现场解析的箭头级计数）
function buildChartData(data, transitionMd) {
  const dims = ['证伪', '证成', '理性', '感性', '场面感', '意义感'];
  const radarScores = {};
  dims.forEach(d => {
    const pro = data['S9.' + d + '.正方'], con = data['S9.' + d + '.反方'];
    radarScores[d] = { pro: pro === undefined ? 0 : pro, con: con === undefined ? 0 : con };
  });
  const cats = ['充分', '初步', '未论证', '被击穿'];
  const barData = { pro: [], con: [] };
  cats.forEach(c => {
    barData.pro.push(data['S2.正方.论证完成度.' + c] || 0);
    barData.con.push(data['S2.反方.论证完成度.' + c] || 0);
  });
  // A7-B3/E-10：箭头级计数（现场解析 S2 矩阵表；无表/全零 → null，渲染器回退汇总图+矩阵图）
  let arrowCounts = null;
  if (transitionMd) {
    const parsed = parseArrowStatusFromS2(transitionMd);
    const c = parsed.counts;
    const hasData = [c.A_B0.pro, c.A_B0.con, c.B0_C.pro, c.B0_C.con].some(arr => arr.some(v => v > 0));
    if (hasData) arrowCounts = c;
  }
  // C9 轴：R6a-4.5 公式 cx=90+320×右/(左+右) 的"向度分"为单侧 1-10 分
  // （L6 复核：规则文本"值域 1-10 / 中点 250=5:5"排除双方求和；旧报告实测
  //   154/168/161 与 S9.裁判倾向声明均吻合"轴内优势方单侧"语义）。
  // 侧别判定：轴内总分（左+右）正方 vs 反方，高者为该轴优势方；持平 → 中立中点。
  const c9Axis = (pro, con) => {
    const proTotal = (pro.left || 0) + (pro.right || 0);
    const conTotal = (con.left || 0) + (con.right || 0);
    if (proTotal === 0 && conTotal === 0) return { left: 0, right: 0 };
    if (proTotal === conTotal) return { left: 1, right: 1 };
    const win = proTotal > conTotal ? pro : con;
    return { left: win.left || 0, right: win.right || 0 };
  };
  return {
    radar: { scores: radarScores },
    bar: barData,
    donut: { n1: data['S3.反驳路径①数'] || 0, n2: data['S3.反驳路径②数'] || 0, n3: data['S3.反驳路径③数'] || 0, total: data['S3.交锋点总数'] || 0 },
    sc: { proEff: data['S8.PhaseII.正方.有效数'] || 0, conEff: data['S8.PhaseII.反方.有效数'] || 0 },
    c8: {
      pro: { Q1: data['R2.5.正方.Q1.对方对抗象限'] || '空缺', Q2: data['R2.5.正方.Q2.对方对抗象限'] || '空缺', Q3: data['R2.5.正方.Q3.对方对抗象限'] || '空缺', Q4: data['R2.5.正方.Q4.对方对抗象限'] || '空缺' },
      con: { Q1: data['R2.5.反方.Q1.对方对抗象限'] || '空缺', Q2: data['R2.5.反方.Q2.对方对抗象限'] || '空缺', Q3: data['R2.5.反方.Q3.对方对抗象限'] || '空缺', Q4: data['R2.5.反方.Q4.对方对抗象限'] || '空缺' }
    },
    c9: {
      axes: {
        证明: c9Axis(
           { left: data['S9.证伪.正方'] || 0, right: data['S9.证成.正方'] || 0 },
           { left: data['S9.证伪.反方'] || 0, right: data['S9.证成.反方'] || 0 }),
        说服: c9Axis(
           { left: data['S9.理性.正方'] || 0, right: data['S9.感性.正方'] || 0 },
           { left: data['S9.理性.反方'] || 0, right: data['S9.感性.反方'] || 0 }),
        第三方: c9Axis(
           { left: data['S9.场面感.正方'] || 0, right: data['S9.意义感.正方'] || 0 },
           { left: data['S9.场面感.反方'] || 0, right: data['S9.意义感.反方'] || 0 })
      }
    },
    arrowCounts
  };
}

// E-10 结构版：从 C5 模块槽位原文机械解析「箭头论证评估表」（R5 输出合同 §R5-C5）
// 表结构固定：| 论证箭头 | 正方状态 | 正方关键依据 | 反方状态 | 反方关键依据 |
// 返回 [{ arrow: 'A→B0'|'B0→C', label, pro, con }]；表缺失/格式异常 → []（不阻断渲染）。
function parseArrowAssessment(c5SlotText) {
  const tbRe = /<!--TABLE:([^>]+)-->\s*([\s\S]*?)<!--\/TABLE-->/g;
  let m;
  while ((m = tbRe.exec(c5SlotText || '')) !== null) {
    const attrs = m[1].trim();
    if (!attrs.includes('箭头论证评估表')) continue;
    const out = [];
    const rows = m[2].split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
    for (const line of rows) {
      const cells = line.split('|').map(s => s.trim()).slice(1, -1);
      if (cells.length < 5 || cells[0] === '论证箭头') continue;
      const arrow = cells[0].includes('A→B0') ? 'A→B0' : cells[0].includes('B0→C') ? 'B0→C' : null;
      if (!arrow) continue;
      out.push({ arrow, label: cells[0], pro: cells[1], con: cells[3] });
    }
    return out;
  }
  return [];
}

// ==================== A7-B1：解析器纯函数（任务 5 / 任务 2 数据源） ====================

const ARROW_STATUS_ENUM = ['充分', '初步', '未论证', '被击穿'];

// 状态列归一化：真实数据形如"初步（罗列了…）"或"初步"；中文/英文括号说明均剥离
function normalizeStatus(cell) {
  const clean = String(cell || '').replace(/（.*）/g, '').replace(/\(.*\)/g, '').trim();
  return ARROW_STATUS_ENUM.find(s => clean.includes(s)) || null;
}

// S2 论证完成度矩阵表现场解析（任务 5：废弃 16 键方案）
// 真实数据实证：S2 两张表之间【无】正方/反方标题，判方三重回退：
//   1) 行内层级列显式方名（"正方FP1"/"反方FP1"）  2) 同表前一行方名  3) 最近 ###/#### 标题
// 每行按 A→B0 / B0→C 状态列计数；无法归一化/判方失败 → warnings（行号+原文），跳过该行不影响其他行
function parseArrowStatusFromS2(transitionMd) {
  const out = { A_B0: { pro: [0, 0, 0, 0], con: [0, 0, 0, 0] }, B0_C: { pro: [0, 0, 0, 0], con: [0, 0, 0, 0] } };
  const rows = [];   // 260805：保留逐支撑环节状态（对齐用）；260806 单环合同：ring 字段 + a/b 单侧取值
  const warnings = [];
  const section = (transitionMd || '').match(/\[S_START=S2\][\s\S]*?\[S_END=S2\]/);
  if (!section) return { counts: out, rows, warnings };
  const lines = section[0].split('\n').map(l => l.trim());
  let lastHeadingSide = null;
  let lastRowSide = null;
  let inMatrix = false;   // A7-B1 修正：表头门控——仅论证完成度矩阵表内的行参与计数，
  let matrixMode = null;  // 'dual'=旧合同（A→B0状态|B0→C状态）/'single'=260806 单环（作用环|状态）
  const sideOf = cell => (/正方|正[一]/.test(cell) ? '正方' : /反方|反[一]/.test(cell) ? '反方' : null);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{2,4}\s*(正方|反方)(?:\s|$)/.test(l)) { lastHeadingSide = l.includes('正方') ? '正方' : '反方'; continue; }
    if (!l.startsWith('|')) { inMatrix = false; continue; }   // 非表格行 → 退出矩阵表
    const cells = l.split('|').map(s => s.trim()).slice(1, -1);
    if (cells.length < 4) continue;
    if (cells[0] === '层级' && cells[2] === 'A→B0状态') { inMatrix = true; matrixMode = 'dual'; continue; }  // 旧合同表头
    if (cells[0] === '层级' && cells[2] === '作用环' && cells[3] === '状态') { inMatrix = true; matrixMode = 'single'; continue; }  // 260806 单环表头
    if (!inMatrix) continue;   // 其他表（辞屏映射表等）不参与
    if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue;   // 分隔行（|---| 变体）跳过
    const side = sideOf(cells[0]) || lastRowSide || lastHeadingSide;
    if (!side) { warnings.push('S2 判方失败，跳过行 L' + (i + 1) + ': ' + cells[0]); continue; }
    lastRowSide = side;
    const key = side === '正方' ? 'pro' : 'con';
    if (matrixMode === 'single') {
      const ring = normalizeRing(cells[2]);
      const st = normalizeStatus(cells[3]);
      if (!ring || !st) { warnings.push('S2 单环行无法归一化 L' + (i + 1) + ': ' + cells[2] + '|' + cells[3].slice(0, 40)); continue; }
      const idx = ARROW_STATUS_ENUM.indexOf(st);
      if (ring === 'A→B0') out.A_B0[key][idx]++;
      else out.B0_C[key][idx]++;
      rows.push({ side: key, label: cells[1] || '', a: ring === 'A→B0' ? idx : null, b: ring === 'B0→C' ? idx : null, ring });
      continue;
    }
    const a = normalizeStatus(cells[2]);
    const b = normalizeStatus(cells[3]);
    if (a) out.A_B0[key][ARROW_STATUS_ENUM.indexOf(a)]++;
    else warnings.push('S2 状态列无法归一化 L' + (i + 1) + ' A→B0: ' + cells[2].slice(0, 40));
    if (b) out.B0_C[key][ARROW_STATUS_ENUM.indexOf(b)]++;
    else warnings.push('S2 状态列无法归一化 L' + (i + 1) + ' B0→C: ' + cells[3].slice(0, 40));
    if (a && b) rows.push({ side: key, label: cells[1] || '', a: ARROW_STATUS_ENUM.indexOf(a), b: ARROW_STATUS_ENUM.indexOf(b) });
  }
  return { counts: out, rows, warnings };
}

// 260806 单环合同：作用环归一化（A→B0 / B0→C）
function normalizeRing(cell) {
  const clean = String(cell || '').replace(/（.*）/g, '').replace(/\(.*\)/g, '').trim();
  if (clean.includes('A→B0') || clean.includes('A-B0')) return 'A→B0';
  if (clean.includes('B0→C') || clean.includes('B0-C')) return 'B0→C';
  return null;
}

// 260805 C5 口径统一：箭头状态 = 该箭头内分论点的短板（最弱状态）；论证完成度 = 每分论点两箭头短板取劣
function arrowStatusFromRows(rows) {
  const out = { pro: { A_B0: null, B0_C: null }, con: { A_B0: null, B0_C: null } };
  for (const r of rows) {
    const side = out[r.side];
    if (r.a !== null && r.a !== undefined && (side.A_B0 === null || r.a > side.A_B0)) side.A_B0 = r.a;
    if (r.b !== null && r.b !== undefined && (side.B0_C === null || r.b > side.B0_C)) side.B0_C = r.b;
  }
  return out;
}

function completionCountsFromRows(rows) {
  const out = { pro: [0, 0, 0, 0], con: [0, 0, 0, 0] };
  for (const r of rows) {
    const s = Math.max(r.a === null || r.a === undefined ? -1 : r.a, r.b === null || r.b === undefined ? -1 : r.b);
    if (s >= 0) out[r.side][s]++;
  }
  return out;
}

function matrixEntriesFromRows(rows) {
  const st = arrowStatusFromRows(rows);
  const lab = i => (i === null ? '未论证' : ARROW_STATUS_ENUM[i]);
  return [
    { arrow: 'A→B0', label: 'A→B0（辩题诠释→核心主张）', pro: lab(st.pro.A_B0), con: lab(st.con.A_B0) },
    { arrow: 'B0→C', label: 'B0→C（核心主张→结论）', pro: lab(st.pro.B0_C), con: lab(st.con.B0_C) }
  ];
}

// 260805 C5 明细：解析 S2 分论点链（A→B→C 论证内容），与矩阵行按下标配对
function parseS2ArgumentChain(transitionMd) {
  const out = { pro: [], con: [] };
  const section = (transitionMd || '').match(/\[S_START=S2\][\s\S]*?\[S_END=S2\]/);
  if (!section) return out;
  const text = section[0];
  const blocks = [
    { side: 'pro', start: text.indexOf('**正方 B0：**'), end: text.indexOf('**反方 B0：**') },
    { side: 'con', start: text.indexOf('**反方 B0：**'), end: text.indexOf('#### 8. 语义地图') }
  ];
  for (const b of blocks) {
    if (b.start < 0) continue;
    const end = b.end > b.start ? b.end : text.length;
    const slice = text.slice(b.start, end);
    const items = [];
    for (const line of slice.split('\n')) {
      const m = line.match(/^\s*\d+\.\s*(.+)$/);
      if (m) items.push(m[1].replace(/\*\*/g, '').trim());
    }
    out[b.side] = items;
  }
  return out;
}

// 260805：提取每方唯一 B0（核心主张）文本，作为柱状图明细的锚点，避免分论点链的 B 被误认为 B0
function parseS2B0(transitionMd) {
  const out = { pro: '', con: '' };
  const section = (transitionMd || '').match(/\[S_START=S2\][\s\S]*?\[S_END=S2\]/);
  if (!section) return out;
  const text = section[0];
  const m1 = text.match(/^\*\*正方 B0：\*\*\s*(.+)$/m);
  const m2 = text.match(/^\*\*反方 B0：\*\*\s*(.+)$/m);
  if (m1) out.pro = m1[1].trim();
  if (m2) out.con = m2[1].trim();
  return out;
}

// 260805 C5 明细：按箭头生成正反方分论点明细（label + A→B→C 内容 + 状态）
function s2ArrowDetails(rows, transitionMd) {
  const chain = parseS2ArgumentChain(transitionMd);
  const b0 = parseS2B0(transitionMd);
  const detail = { A_B0: { proB0: b0.pro, conB0: b0.con, items: [] }, B0_C: { proB0: b0.pro, conB0: b0.con, items: [] } };
  for (const side of ['pro', 'con']) {
    const list = rows.filter(r => r.side === side);
    const contents = chain[side] || [];
    const sideLabel = side === 'pro' ? '正方' : '反方';
    list.forEach((r, i) => {
      const label = r.label || ('分论点' + (i + 1));
      // 260805 修正：分论点链为 A→B→C 三段；A→B0 图只列 A→B 段（该分论点对第一箭头的支撑段），
      // B0→C 图只列 B→C 段（该分论点对第二箭头的推导段）；B0 本身每方唯一，由明细首行锚点给出
      const parts = (contents[i] || '').split('→').map(s => s.trim());
      const firstArrow = parts.length >= 2 ? parts[0] + ' → ' + parts[1] : contents[i];
      const secondArrow = parts.length >= 3 ? parts[1] + ' → ' + parts[2] : contents[i];
      if (r.a !== null && r.a !== undefined) detail.A_B0.items.push({ side: sideLabel, label: (firstArrow ? label + '：' + firstArrow : label), status: ARROW_STATUS_ENUM[r.a] });
      if (r.b !== null && r.b !== undefined) detail.B0_C.items.push({ side: sideLabel, label: (secondArrow ? label + '：' + secondArrow : label), status: ARROW_STATUS_ENUM[r.b] });
    });
  }
  return detail;
}

// C7 微消化实例表解析（任务 2：Phase II 逐节点内容；与 parseArrowAssessment 同机制）
// 容错：TABLE 标记块优先；无则回退扫描含表头"接收内容"的 Markdown 表；节点 ID"正方-1"→M-ZH-1
function parseMicroDigestionTable(c7Raw) {
  const map = {};
  const src = String(c7Raw || '');
  let body = null;
  const tb = src.match(/<!--TABLE:([^>]*微消化实例表[^>]*)-->\s*([\s\S]*?)<!--\/TABLE-->/);
  if (tb) body = tb[2];
  else {
    const lines = src.split('\n').map(l => l.trim());
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].startsWith('|') && lines[i].includes('接收内容')) {
        const rows = [];
        for (let j = i; j < lines.length && lines[j].startsWith('|'); j++) rows.push(lines[j]);
        body = rows.join('\n');
        break;
      }
    }
  }
  if (!body) return map;
  const rows = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  for (const l of rows) {
    const cells = l.split('|').map(s => s.trim()).slice(1, -1);
    if (cells.length < 5 || cells[0] === '节点') continue;
    // M-ID 统一经 PC 契约工具归一（展示名 正方-1 / 旧写法 M-反-1 → 规范 M-ZH/M-FA）
    let id = contract.normalizeMId(cells[0]);
    // 兼容旧实现的前缀容错：单元格如 "正方-1（备注）" 仍按首个展示名 ID 解析
    if (!contract.isMid(id)) {
      const m = cells[0].match(/^(正|反)方[-—]?(\d+)/);
      if (m) id = contract.normalizeMId((m[1] === '正' ? 'M-正-' : 'M-反-') + m[2]);
    }
    if (!contract.isMid(id)) continue;
    map[id] = { recv: cells[2] || '', reloc: cells[3] || '' };
  }
  return map;
}

// E-10 结构版：2×2 箭头状态矩阵图（260805：两行=正方/反方、两列=A→B0/B0→C，列间箭头表示论证流向）
// ==================== 260806 P1-1/P1-2：C5 渲染 UI（横置表/箭头级状态/整链结论/支撑明细单环） ====================

// S7 攻击解析（260806 合同：表头驱动；新列=靶心/削弱指向/回合深度；旧合同回退关键词反推）
function parseS7Attack(raw) {
  const sec = String(raw || '').match(/\[S_START=S7\][\s\S]*?\[S_END=S7\]/);
  if (!sec) return [];
  const lines = sec[0].split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  const hdrIdx = lines.findIndex(l => l.includes('CP-ID'));
  if (hdrIdx < 0) return [];
  const header = lines[hdrIdx].split('|').map(s => s.trim()).slice(1, -1);
  const idx = name => header.findIndex(h => h.includes(name));
  const iId = idx('CP-ID'), iContent = idx('交锋'), iVerdict = idx('裁决'), iPen = idx('穿透度'),
    iTarget = idx('靶心'), iCrit = idx('削弱指向'), iDepth = idx('回合深度');
  const out = [];
  for (let k = hdrIdx + 1; k < lines.length; k++) {
    const cells = lines[k].split('|').map(s => s.trim()).slice(1, -1);
    if (cells.length < 3 || !/^CP-\d+/.test(cells[iId >= 0 ? iId : 0].replace(/\*\*/g, ''))) continue;
    const verdict = iVerdict >= 0 ? cells[iVerdict] : '';
    const vm = verdict.match(/(正方|反方|平局)胜?（([^）]+)）/);
    if (!vm) continue;
    out.push({
      id: cells[iId].replace(/\*\*/g, ''),
      content: iContent >= 0 ? cells[iContent] : '',
      verdict,
      who: vm[1], weight: vm[2],
      pen: iPen >= 0 ? cells[iPen] : '',
      target: iTarget >= 0 ? cells[iTarget] : '',
      criticality: iCrit >= 0 ? cells[iCrit] : '',
      depth: iDepth >= 0 ? cells[iDepth] : '',
      oldContract: iTarget < 0 || iCrit < 0
    });
  }
  return out;
}

// 靶心→环 机械映射（260806 合同）：B0/其分论点 → A→B0；B0→C 推导 → B0→C；边缘 → 不入环
function targetRing(cp) {
  const t = String(cp.target || '');
  if (/边缘|类比|举例/.test(t)) return null;
  if (/B0→C|推导|推论|结论链|主张到结论/.test(t)) return 'B0_C';
  return 'A_B0';
}

// 旧合同回退启发式（关键词反推，标注 derived）
function heuristicRing(cp) {
  const t = cp.content + ' ' + cp.verdict;
  if (/客观存在|自身具备|独立于|美能否脱离|美.*主观|美.*感受|美.*客观|美.*存在|善.*美|标准.*统一|美感差异|美丑|特性/.test(t)) return 'A_B0';
  return 'B0_C';
}

function heuristicAttackMap(cps) {
  const atkEffect = { 致命: 3, 重要: 1, 皮毛: 0, 平局: 0 };
  const out = { pro: { A_B0: [], B0_C: [] }, con: { A_B0: [], B0_C: [] } };
  for (const cp of cps) {
    const ring = cp.pen === '高' ? (cp.oldContract ? heuristicRing(cp) : targetRing(cp)) : cp.pen === '中' ? 'A_B0' : null;
    if (!ring) continue;
    const effect = atkEffect[cp.weight] !== undefined ? atkEffect[cp.weight] : 0;
    const targets = cp.who === '平局' ? ['pro', 'con'] : [cp.who === '正方' ? 'con' : 'pro'];
    for (const t of targets) out[t][ring].push({ cp: cp.id, who: cp.who, weight: cp.weight, effect, content: cp.content, criticality: cp.criticality || '', derived: !!cp.oldContract });
  }
  return out;
}

function worstStatus(arr) { const v = (arr || []).filter(x => x !== null && x !== undefined); return v.length ? Math.max.apply(null, v) : 0; }

function c5StatusHtml(i) {
  const color = i === 3 ? 'var(--red)' : i === 2 ? 'var(--dim)' : i === 1 ? 'var(--gold)' : 'var(--green)';
  const name = ['充分', '初步', '未论证', '被击穿'][i];
  return '<span style="color:' + color + ';font-weight:600">' + name + '</span>';
}

function attackLabel(entries) {
  if (!entries.length) return '未受攻击';
  const w = Math.max.apply(null, entries.map(e => e.effect));
  if (w === 3) return '被击穿';
  if (w === 1) return '被削弱';
  return '被交锋未击穿';
}

function attackEvidence(entries) {
  if (!entries.length) return '—';
  return entries.map(e => e.cp + ' ' + e.who + (e.who === '平局' ? '' : '胜') + '（' + e.weight + '）：' + e.content.slice(0, 24)).join('；');
}

function chainTextOf(n1, n2) {
  const worst = Math.max(n1, n2);
  const ringName = n1 > n2 ? 'A→B0' : 'B0→C';
  if (worst === 3) return '被击穿（短板环：' + ringName + '）';
  if (worst === 2) return '有缺口（短板环：' + ringName + ' 未论证）';
  if (worst === 1) return '有缺口（短板环：' + ringName + ' 初步）';
  return '完整（两环充分）';
}

// P1-2 单环明细：合同行按自带 ring；旧合同回退=分论点→A→B0 + 价值点/标准合理性→B0→C（测试推导）
function singleRingDetailRows(rows) {
  const out = [];
  for (const side of ['pro', 'con']) {
    const list = rows.filter(r => r.side === side);
    list.forEach(r => {
      if (r.ring) {
        out.push({ side, label: r.label || '支撑环节', ring: r.ring, status: r.ring === 'A→B0' ? r.a : r.b, derived: false });
      } else {
        out.push({ side, label: r.label || '分论点', ring: 'A→B0', status: r.a, derived: false });
      }
    });
    if (!list.some(r => r.ring === 'B0→C')) {
      out.push({ side, label: '价值点/标准合理性（测试推导）', ring: 'B0→C', status: worstStatus(list.map(r => r.b)), derived: true });
    }
  }
  return out;
}

// P1-1/P1-2：箭头级状态表 + 整链结论 + 支撑明细单环（数据：S2 自证 + S7 启发式攻击，标注测试推导）
function buildC5V2Ui(rows, raw) {
  if (!rows || !rows.length) return '';
  const ringWorst = (side, ring, get) => {
    const vals = rows.filter(r => r.side === side && (r.ring ? r.ring === ring : true) && get(r) !== null && get(r) !== undefined).map(get);
    return vals.length ? Math.max.apply(null, vals) : 2; // 无该环支撑 → 未论证
  };
  const self = {
    pro: { A_B0: ringWorst('pro', 'A_B0', r => r.a), B0_C: ringWorst('pro', 'B0_C', r => r.b) },
    con: { A_B0: ringWorst('con', 'A_B0', r => r.a), B0_C: ringWorst('con', 'B0_C', r => r.b) }
  };
  const atk = heuristicAttackMap(parseS7Attack(raw));
  const net = (side, ring) => {
    const s = self[side][ring];
    if (s === 2) return 2;
    const entries = atk[side][ring];
    if (entries.some(e => e.effect === 3)) return 3; // 击穿 → 被击穿（无论语境）
    const weakened = entries.some(e => e.effect === 1);
    if (weakened && entries.some(e => e.effect === 1 && e.criticality === '唯一支撑')) return Math.min(3, s + 1); // 关键/唯一支撑削弱 → 降一级
    return s; // 冗余/边缘/未削弱 → 不降级（受质疑标记由调用方加）
  };
  const weakenedNoKey = (side, ring) => {
    const entries = atk[side][ring];
    return entries.some(e => e.effect === 1) && !entries.some(e => e.effect === 1 && e.criticality === '唯一支撑');
  };
  const sideName = s => s === 'pro' ? '正方' : '反方';
  const arrowRows = [];
  for (const side of ['pro', 'con']) {
    for (const ring of ['A_B0', 'B0_C']) {
      const ringName = ring === 'A_B0' ? 'A→B0' : 'B0→C';
      const netVal = net(side, ring);
      const questioned = weakenedNoKey(side, ring) && netVal === self[side][ring];
      const netHtml = c5StatusHtml(netVal) + (questioned ? ' <span style="color:var(--dim);font-size:0.85em">（受质疑）</span>' : '');
      arrowRows.push('<tr><td>' + sideName(side) + '</td><td>' + ringName + '</td><td>' + c5StatusHtml(self[side][ring]) + '</td><td>' + attackLabel(atk[side][ring]) + '</td><td>' + netHtml + '</td><td>' + attackEvidence(atk[side][ring]) + '</td></tr>');
    }
  }
  const chainRows = ['pro', 'con'].map(s => '<tr><td>' + sideName(s) + '</td><td>' + chainTextOf(net(s, 'A_B0'), net(s, 'B0_C')) + '</td></tr>').join('');
  const detailRows = singleRingDetailRows(rows).map(d => '<tr><td>' + sideName(d.side) + '</td><td>' + d.label + '</td><td>' + d.ring + '</td><td>' + c5StatusHtml(d.status) + '</td></tr>').join('');
  return '<h3 style="font-size:1.05em;color:var(--text);margin:16px 0 8px 0">箭头级论证状态（自证 × 攻击）</h3>'
    + '<p class="ps" style="color:var(--dim)">攻击环归属：新合同按 S7 靶心列机械映射；旧合同场次为关键词反推（测试推导标注）。真值表：唯一支撑削弱→降一级；冗余/边缘→不降级（受质疑）。</p>'
    + '<table class="tb"><thead><tr><th>方</th><th>箭头</th><th>自证状态</th><th>对方攻击</th><th>净状态</th><th>攻击依据（S7）</th></tr></thead><tbody>' + arrowRows.join('') + '</tbody></table>'
    + '<h3 style="font-size:1.05em;color:var(--text);margin:16px 0 8px 0">整链结论（A→B0→C）</h3>'
    + '<table class="tb"><thead><tr><th>方</th><th>整链状态</th></tr></thead><tbody>' + chainRows + '</tbody></table>'
    + '<h3 style="font-size:1.05em;color:var(--text);margin:16px 0 8px 0">支撑环节明细（辅助，不决定完成度）</h3>'
    + '<p class="ps" style="color:var(--dim)">单环模型：分论点支撑 A→B0，价值点/标准合理性支撑 B0→C；价值点环为测试推导（真字段见段 1B-B）。</p>'
    + '<table class="tb"><thead><tr><th>方</th><th>支撑环节</th><th>作用环</th><th>自证状态</th></tr></thead><tbody>' + detailRows + '</tbody></table>';
}

// P1-1：C5 架构对比表横置（方|A|A→B0|B0|B0→C|C）+ 文案（架构自证/架构交集/矛盾联系）
function applyC5UiTransforms(html) {
  const c5Start = html.indexOf('<div class="sk c-module c5"');
  if (c5Start < 0) return html;
  const c6Start = html.indexOf('<div class="sk c-module c6"', c5Start);
  const c5End = c6Start > c5Start ? html.lastIndexOf('</div>', c6Start) : html.length;
  let c5 = html.slice(c5Start, c5End);
  const tbStart = c5.indexOf('<table class="tb">');
  const tbEnd = tbStart >= 0 ? c5.indexOf('</table>', tbStart) + 8 : -1;
  if (tbStart >= 0 && tbEnd > tbStart && c5.slice(tbStart, tbEnd).includes('A（辩题主体诠释）')) {
    const table = c5.slice(tbStart, tbEnd);
    const rowsHtml = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => {
      const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1].trim());
      return cells;
    }).filter(r => r.length >= 3);
    const rows = rowsHtml.slice(1);
    const pick = label => {
      const hit = rows.find(r => {
        const t = r[0].replace(/<[^>]+>/g, '');
        return (label === 'A' && /^A[（(]/.test(t)) || (label === 'A_B0' && t.includes('A→B0'))
          || (label === 'B0' && /^B0[（(]/.test(t)) || (label === 'B0_C' && t.includes('B0→C'))
          || (label === 'C' && /^C[（(]/.test(t));
      });
      return hit || ['', '', ''];
    };
    const A = pick('A'), AB0 = pick('A_B0'), B0 = pick('B0'), B0C = pick('B0_C'), C = pick('C');
    const row = idx => '<tr><td>' + (idx === 1 ? '正方' : '反方') + '</td><td>' + A[idx] + '</td><td>' + AB0[idx] + '</td><td>' + B0[idx] + '</td><td>' + B0C[idx] + '</td><td>' + C[idx] + '</td></tr>';
    const newTable = '<table class="tb"><thead><tr><th>方</th><th>A（辩题主体诠释）</th><th>A→B0（第一箭头）</th><th>B0（核心主张）</th><th>B0→C（第二箭头）</th><th>C（结论）</th></tr></thead><tbody>' + row(1) + row(2) + '</tbody></table>';
    c5 = c5.slice(0, tbStart) + newTable + c5.slice(tbEnd);
  }
  c5 = c5
    .replace(/>架构对比<\/h3>/, '>架构自证</h3>')
    .replace(/>交集与恰好支持<\/h3>/, '>架构交集</h3>')
    .replace(/恰好支持信号/g, '矛盾联系');
  return html.slice(0, c5Start) + c5 + html.slice(c5End);
}

function arrowMatrixSVG(entries) {
  if (!entries || entries.length === 0) return '';
  const statusStyle = {
    充分: { bg: '#e8f5e9', fg: '#2e7d32' },
    初步: { bg: '#fff8e1', fg: '#b8860b' },
    未论证: { bg: '#f5f5f5', fg: '#9e9e9e' },
    被击穿: { bg: '#ffebee', fg: '#c62828' }
  };
  const eA = entries.find(x => x.arrow === 'A→B0');
  const eB = entries.find(x => x.arrow === 'B0→C');
  if (!eA || !eB) return '';
  const cell = (status, x, center, y) => {
    const st = statusStyle[status] || { bg: '#fafafa', fg: '#999' };
    return '<rect x="' + x + '" y="' + y + '" width="130" height="38" rx="6" fill="' + st.bg + '" stroke="' + st.fg + '" stroke-width="1.5"/>'
      + '<text x="' + center + '" y="' + (y + 24) + '" text-anchor="middle" font-size="12" font-weight="bold" fill="' + st.fg + '">' + status + '</text>';
  };
  const parts = [];
  // 260805：矩阵标题移至 SVG 外（与柱状图标题同款 HTML 样式，由 renderHTML 注入），SVG 内仅保留列头
  parts.push('<svg viewBox="0 0 460 140" xmlns="http://www.w3.org/2000/svg" font-family="\'Microsoft YaHei\',sans-serif">');
  parts.push('<text x="137" y="16" text-anchor="middle" font-size="10.5" fill="#444">A→B0 第一箭头·立论主张</text>');
  parts.push('<text x="327" y="16" text-anchor="middle" font-size="10.5" fill="#444">B0→C 第二箭头·推论链</text>');
  for (const [side, sideLabel, y] of [['pro', '正方', 28], ['con', '反方', 80]]) {
    parts.push('<text x="20" y="' + (y + 24) + '" font-size="11" fill="#444">' + sideLabel + '</text>');
    parts.push(cell(eA[side] || '未论证', 72, 137, y));
    parts.push(cell(eB[side] || '未论证', 262, 327, y));
    parts.push('<text x="230" y="' + (y + 24) + '" text-anchor="middle" font-size="16" fill="#888">→</text>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ==================== C4b 图表函数（C8 三图 + C9 三轴） ====================

// C9 裁判倾向水平轴（R6a-4.5：参数化模板 + cx 公式；分母 0 → 中点 + 数据不可用）
function c9GaugeSVG(axisKey, data) {
  const C = CH.c9;
  const axis = C.axes.find(a => a.id === axisKey);
  if (!axis) return '';
  const v = (data.axes && data.axes[axisKey === 'ZHENGMING' ? '证明' : axisKey === 'SHUOFU' ? '说服' : '第三方']) || { left: 0, right: 0 };
  const denom = v.left + v.right;
  let cx = 250, unavailable = false;
  if (denom > 0) cx = r1(C.x1 + (C.x2 - C.x1) * v.right / denom);
  else unavailable = true;
  const parts = [];
  parts.push('<svg viewBox="' + C.viewBox + '" xmlns="http://www.w3.org/2000/svg">');
  parts.push('<text x="110" y="34" font-size="12" fill="#888" text-anchor="end">' + axis.left + '</text>');
  parts.push('<line x1="' + C.x1 + '" y1="12" x2="' + C.x2 + '" y2="12" stroke="#ccc" stroke-width="2"/>');
  parts.push('<polygon points="' + r1(cx - 5) + ',18 ' + cx + ',12 ' + r1(cx + 5) + ',18" fill="' + axis.color + '"/>');
  parts.push('<text x="390" y="34" font-size="12" fill="#888" text-anchor="start">' + axis.right + '</text>');
  if (unavailable) parts.push('<text x="250" y="34" text-anchor="middle" font-size="9" fill="#888">数据不可用</text>');
  parts.push('</svg>');
  return parts.join('\n');
}

// C8 共享判定（R6a-4.6.1：优势方查表 + 颜色映射）
function c8Dominance(proQ, conQ) {
  const p = proQ && proQ !== '空缺', c = conQ && conQ !== '空缺';
  if (p && !c) return '正方';
  if (!p && c) return '反方';
  if (p && c) return '均衡';
  return '空缺';
}

// 图1 基础四象限图（4.6.2）
function c8Chart1(data) {
  const C = CH.c8;
  const Qs = ['Q1', 'Q2', 'Q3', 'Q4'];
  const dom = {};
  Qs.forEach(q => { dom[q] = c8Dominance(data.pro[q], data.con[q]); });
  const labels = { 正方: '正方优势', 反方: '反方优势', 均衡: '均衡（互有对抗）', 空缺: '— 空缺' };
  const proDom = Qs.filter(q => dom[q] === '正方').length;
  const conDom = Qs.filter(q => dom[q] === '反方').length;
  const emptyN = Qs.filter(q => dom[q] === '空缺').length;
  const main = proDom >= conDom ? '正方' : '反方';
  const n = Math.max(proDom, conDom);
  const pattern = emptyN >= 2 ? '稀疏' : n >= 3 ? '主导' : '均衡';
  const rects = [
    { q: 'Q1', x: 20, y: 40 }, { q: 'Q2', x: 210, y: 40 },
    { q: 'Q4', x: 20, y: 155 }, { q: 'Q3', x: 210, y: 155 }
  ];
  // A8-P2c：对抗来源副行（模板示例 "← 被反方Q3对抗" 的数据驱动化）
  const atkSource = q => {
    const from = Qs.find(s => data.con[s] === q || data.pro[s] === q);
    if (!from) return '';
    const who = data.con[from] === q ? '反方' : '正方';
    return '← 被' + who + from + '对抗';
  };
  const parts = [];
  parts.push('<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" font-family="\'Microsoft YaHei\',sans-serif">');
  parts.push('<text x="200" y="20" text-anchor="middle" font-size="12" fill="var(--gray)">态度轴（肯定↔否定）× 理解轴（道德↔现实）</text>');
  const names = { Q1: 'Q1·肯定×道德', Q2: 'Q2·肯定×现实', Q3: 'Q3·否定×道德', Q4: 'Q4·否定×现实' };
  rects.forEach(r => {
    const d = dom[r.q], col = C.dominanceColors[d];
    parts.push('<rect x="' + r.x + '" y="' + r.y + '" width="170" height="95" rx="8" fill="' + col.bg + '" stroke="' + col.stroke + '" stroke-width="1.5"/>');
    parts.push('<text x="' + (r.x + 85) + '" y="' + (r.y + 24) + '" text-anchor="middle" font-size="13" font-weight="bold" fill="' + col.text + '">' + names[r.q] + '</text>');
    parts.push('<text x="' + (r.x + 85) + '" y="' + (r.y + 44) + '" text-anchor="middle" font-size="12" fill="' + col.text + '">' + labels[d] + '</text>');
    const src = atkSource(r.q);
    if (src) parts.push('<text x="' + (r.x + 85) + '" y="' + (r.y + 66) + '" text-anchor="middle" font-size="10" fill="#888">' + src + '</text>');
  });
  parts.push('<rect x="60" y="270" width="14" height="14" fill="#e8f5e9" stroke="#2e7d32" stroke-width="1"/><text x="80" y="282" font-size="11" fill="#666">正方优势</text>');
  parts.push('<rect x="160" y="270" width="14" height="14" fill="#e3f2fd" stroke="#1565c0" stroke-width="1"/><text x="180" y="282" font-size="11" fill="#666">反方优势</text>');
  parts.push('<rect x="260" y="270" width="14" height="14" fill="#fff8e1" stroke="#f9a825" stroke-width="1"/><text x="280" y="282" font-size="11" fill="#666">均衡</text>');
  parts.push('<rect x="330" y="270" width="14" height="14" fill="#fafafa" stroke="#ddd" stroke-width="1"/><text x="350" y="282" font-size="11" fill="#666">空缺</text>');
  parts.push('</svg>');
  parts.push('<p class="chart-caption">' + main + '占据' + n + '个象限优势·修辞格局呈' + pattern + '态势</p>');
  return parts.join('\n');
}

// 图3 跨象限对抗流图（4.6.4：固定中心坐标 + 8 条 DATA 直线）
function c8Chart3(data) {
  const C = CH.c8;
  const T = C.track;
  const Qs = ['Q1', 'Q2', 'Q3', 'Q4'];
  const parts = [];
  parts.push('<svg viewBox="' + T.viewBox + '" xmlns="http://www.w3.org/2000/svg" font-family="\'Microsoft YaHei\',sans-serif">');
  parts.push('<text x="300" y="20" text-anchor="middle" font-size="13" font-weight="bold">跨象限对抗流（双向拆分）</text>');
  // A8-P2c：箭头 marker（模板 C8图表优化模板.730.html 图3）
  parts.push('<defs>' +
    '<marker id="arrow-red" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#c62828"/></marker>' +
    '<marker id="arrow-blue" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#1565c0"/></marker>' +
    '</defs>');
  parts.push('<text x="' + T.proTitle.x + '" y="' + T.proTitle.y + '" text-anchor="middle" font-size="12" fill="' + T.proTitle.fill + '" font-weight="bold">' + T.proTitle.text + '</text>');
  let proCount = 0, conCount = 0;
  // 上排：正方攻击 → 反方（实线红·带箭头）
  Qs.forEach(q => {
    const t = data.pro[q];
    if (t === '空缺' || !/^Q[1-4]$/.test(t || '')) return;
    const y = T.proY0 + proCount * T.yStep;
    parts.push('<line x1="' + T.xFrom + '" y1="' + y + '" x2="' + T.xTo + '" y2="' + y + '" stroke="#c62828" stroke-width="2.5" marker-end="' + T.markerRed + '"/>');
    parts.push('<circle cx="' + T.xFrom + '" cy="' + y + '" r="4" fill="#c62828"/><circle cx="' + T.xTo + '" cy="' + y + '" r="4" fill="#c62828"/>');
    parts.push('<text x="' + (T.xFrom - 10) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#c62828" font-weight="bold">正方' + q + '</text>');
    parts.push('<text x="' + (T.xTo + 10) + '" y="' + (y + 4) + '" text-anchor="start" font-size="11" fill="#888" font-weight="bold">反方' + t + '</text>');
    proCount++;
  });
  parts.push('<text x="' + T.conTitle.x + '" y="' + T.conTitle.y + '" text-anchor="middle" font-size="12" fill="' + T.conTitle.fill + '" font-weight="bold">' + T.conTitle.text + '</text>');
  // 下排：反方攻击 → 正方（虚线蓝·带箭头）
  Qs.forEach(q => {
    const t = data.con[q];
    if (t === '空缺' || !/^Q[1-4]$/.test(t || '')) return;
    const y = T.conY0 + conCount * T.yStep;
    parts.push('<line x1="' + T.xTo + '" y1="' + y + '" x2="' + T.xFrom + '" y2="' + y + '" stroke="#1565c0" stroke-width="2.5" stroke-dasharray="6,3" marker-end="' + T.markerBlue + '"/>');
    parts.push('<circle cx="' + T.xTo + '" cy="' + y + '" r="4" fill="#1565c0"/><circle cx="' + T.xFrom + '" cy="' + y + '" r="4" fill="#1565c0"/>');
    parts.push('<text x="' + (T.xTo + 10) + '" y="' + (y + 4) + '" text-anchor="start" font-size="11" fill="#1565c0" font-weight="bold">反方' + q + '</text>');
    parts.push('<text x="' + (T.xFrom - 10) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#888" font-weight="bold">正方' + t + '</text>');
    conCount++;
  });
  T.legend.forEach(lg => {
    parts.push('<rect x="' + lg.x + '" y="' + lg.y + '" width="14" height="14" fill="' + lg.fill + '"/><text x="' + (lg.x + 20) + '" y="' + (lg.y + 12) + '" font-size="11" fill="#666">' + lg.label + '</text>');
  });
  parts.push('</svg>');
  const lineCount = proCount + conCount;
  const pattern = lineCount >= 3 ? '流动' : lineCount >= 1 ? '胶着' : '单向';
  parts.push('<p class="chart-caption">存在' + lineCount + '条跨象限对抗线·修辞战场呈' + pattern + '态势</p>');
  return parts.join('\n');
}

function labelsC8(d) { return d === '正方' ? '正方' : d === '反方' ? '反方' : d === '均衡' ? '均衡' : '—'; }

// ==================== C5 C3 主线全景图面板（全形态） ====================

// A7-B2：C2 类型徽章（R6a-5-C2：S11.类型 DATA 驱动；.pb 容器与 C3 底部徽章样式统一）
const C2_BADGE_MAP = {
  '1a': { cls: 't1a', label: '事件型·有清晰的决胜逻辑', desc: '结构性交锋三阶段集中在单次交锋中完成·压缩≈1' },
  '1b': { cls: 't1b', label: '过程型·有清晰的决胜逻辑', desc: '结构性交锋分布在全场时间线上·多层推进·渐进收束' },
  '1c': { cls: 't1c', label: '框架内置型·有清晰的决胜逻辑', desc: 'B0=B\'·立论中已内置容纳逻辑·全场持续应用' },
  '1d': { cls: 't1d', label: '层间迭代型·有清晰的决胜逻辑', desc: '双方各完成一层SC，后完成方B\'\'上位覆盖先完成方B\'·决胜层在最外层' },
  '2a': { cls: 't2a', label: '有起点无推进·缺乏聚合的决胜锚点', desc: '立论有容纳潜力但后续未见实质推进' },
  '2b': { cls: 't2b', label: '有推进未结晶·缺乏聚合的决胜锚点', desc: '存在SC推进但未走到容纳双方的统一结论' },
  '2c': { cls: 't2c', label: '纯碰撞型·缺乏聚合的决胜锚点', desc: '双方设计层面均无容纳空间·纯平行交火' },
  '0': { cls: 't0', label: '无真正交锋', desc: '双方各说各话·未形成实质碰撞' }
};

function c2BadgeHTML(type) {
  const m = C2_BADGE_MAP[type] || C2_BADGE_MAP['0'];
  return '<div class="pb"><span class="tg ' + m.cls + '">' + type + '型</span>' +
    '<b style="font-size:20px">· ' + m.label + '</b>' +
    '<div style="font-size:14px;text-align:left;margin-top:12px">' + m.desc + '</div></div>';
}

// A7-B2：C2 SC 追迹面板（硬门禁仅 2b；Phase II 节点内容三级路径：C7 逐节点 → structure 层级摘要 → 仅 ID）
function c2ScPanelHTML(data, structure, c7Raw) {
  if (!data || data['S11.类型'] !== '2b') return '';
  const layer0 = (structure && structure.layers && structure.layers[0]) || {};
  const b0pro = layer0.pro_B0_summary || data['S2.正方.B0'] || '—';
  const b0con = layer0.con_B0_summary || data['S2.反方.B0'] || '—';
  const cap = layer0.accommodation_potential || {};
  const b0bp = layer0.B0_equals_B_prime || '';
  const mToLayer = (structure && structure.cross_reference && structure.cross_reference.m_to_layer) || [];
  const layers = (structure && structure.layers) || [];
  const c7Map = parseMicroDigestionTable(c7Raw);
  const sideOfMid = m => contract.sideOfMid(m);
  const layerOfMid = m => { const x = mToLayer.find(e => e.m_id === m); return x ? layers.find(l => l.id === x.layer_id) : null; };
  const midList = () => {
    const fromStructure = mToLayer.map(e => e.m_id).filter(Boolean);
    if (fromStructure.length) return fromStructure;
    const list = [];
    for (const side of ['正方', '反方']) {
      const raw = data['S8.PhaseII.' + side + '.节点列表'];
      if (raw) list.push(...String(raw).split('|').map(s => s.trim()).filter(Boolean));
    }
    return list;
  };
  const detailOf = m => {
    if (c7Map[m]) return c7Map[m];                                  // 路径 1：C7 逐节点
    const l = layerOfMid(m);
    if (l && (l.received_alpha_beta || l.relocation_method))        // 路径 2：structure 层级摘要
      return { recv: l.received_alpha_beta || '', reloc: l.relocation_method || '', layerSummary: true };
    return null;                                                     // 路径 3：仅编号
  };
  const phase2 = side => {
    const count = data['S8.PhaseII.' + side + '.有效数'] || 0;
    const mids = midList().filter(m => sideOfMid(m) === side);
    const chain = mids.map((m, i) => {
      const d = detailOf(m);
      let content = '<b>' + m + '</b>';
      if (d && !d.layerSummary) content += '<br>' + d.recv + '→' + d.reloc;
      else if (d && d.layerSummary) content += '<br><span style="color:var(--dim)">' + d.recv.slice(0, 40) + '…（层级摘要）</span>';
      else content += '<br><span style="color:var(--dim)">内容不可用</span>';
      return '<div class="pn pn-p2">' + content + '</div>' + (i < mids.length - 1 ? '<div class="pa">↓</div>' : '');
    }).join('');
    return '<div class="pz pz-' + (side === '正方' ? 'zh' : 'fh') + '" style="display:flex;flex-direction:column;gap:8px">' +
      '<div style="text-align:center;font-weight:bold;color:var(--' + (side === '正方' ? 'green' : 'blue') + ');margin-bottom:4px">' + side + ' · ' + count + '次</div>' +
      (chain || '<div class="pn pn-p2">（无机械可读节点）</div>') + '</div>';
  };
  const p3 = data['S8.PhaseIII.状态'] === '已结晶' ? '结晶完成' : '有推进未结晶';
  const p3Desc = (data['S8.PhaseIII.完成方'] || '无') === '无' ? '双方均未完成结晶·未走到容纳双方的统一结论' : data['S8.PhaseIII.完成方'] + '方完成结晶';
  return '<details style="margin:16px 0">' +
    '<summary style="cursor:pointer;font-weight:bold;font-size:1.05em;color:var(--blue)">结构性交锋过程追迹面板（展开查看）</summary>' +
    '<div class="pw">' +
      '<div class="pz pz-zh"><div class="pn pn-zh">正方·Phase I 框架声明</div><div class="pn pn-p1">' + b0pro.slice(0, 30) + '</div><div class="ps">容纳潜力: ' + (cap.pro || '—') + ' | 微消化: ' + (data['S8.PhaseII.正方.有效数'] || 0) + '个有效 | ' + (b0bp === '正方' ? "B0=B'" : '非B0=B\'') + '型</div></div>' +
      '<div class="pz pz-fh"><div class="pn pn-fh">反方·Phase I 框架声明' + (b0bp === '反方' ? '<span class="b0bp-badge">B0=B\'</span>' : '') + '</div><div class="pn pn-p1">' + b0con.slice(0, 30) + '</div><div class="ps">容纳潜力: ' + (cap.con || '—') + ' | 微消化: ' + (data['S8.PhaseII.反方.有效数'] || 0) + '个有效 | ' + (b0bp === '反方' ? "B0=B'" : '非B0=B\'') + '型</div></div>' +
    '</div>' +
    '<div class="pf-arr" style="font-size:1.5em;font-weight:bold;color:var(--blue)">↓ Phase II · 微消化推进序列 ↓</div>' +
    '<div class="pw">' + phase2('正方') + phase2('反方') + '</div>' +
    '<div class="pf-arr">↓ Phase III · 结晶 ↓</div>' +
    '<div class="pc2" style="margin:16px auto;max-width:600px">' +
      '<div class="pct">' + p3 + '</div>' +
      '<div class="pcd">' + p3Desc + '</div>' +
    '</div></details>';
}

// A7-B2：O4 内容感进度条（C10·规则 4.5；S14.内容感 → Lv 查表 + width=Lv/6，Lv0=3%）
function o4ContentProgress(data) {
  const lv = String((data && data['S14.内容感']) || 'Lv0').replace(/^Lv/i, '');
  const names = ['Lv0 无法构成答案', 'Lv1 已知答案的赘述', 'Lv2 已知答案的补充', 'Lv3 已知答案的深化', 'Lv4 已知答案的重构', 'Lv5 未知答案的领受', 'Lv6 未知信念的领受'];
  const n = Math.min(6, Math.max(0, parseInt(lv) || 0));
  const width = n === 0 ? 3 : Math.round(n / 6 * 1000) / 10;
  return '<div style="margin:16px 0">' +
    '<div style="display:flex;justify-content:space-between;font-size:0.7em;color:var(--gray);margin-bottom:4px">' + names.map(x => '<span>' + x + '</span>').join('') + '</div>' +
    '<div style="background:var(--border);border-radius:6px;height:12px;overflow:hidden"><div style="background:linear-gradient(90deg,#1565c0,#43a047);height:100%;width:' + width + '%;border-radius:6px;transition:width 0.5s"></div></div>' +
    '<div style="text-align:center;margin-top:4px;font-weight:bold;color:var(--blue)">Lv' + n + ' · ' + names[n].replace('Lv' + n + ' ', '') + '</div></div>';
}

// A7-B2：O5 SC 三阶段进度条（C7·规则 4.5；S8.PhaseI/II/III 状态驱动，纯 CSS）
function o5ScProgress(data) {
  const p1 = data && (data['S8.PhaseI.正方'] === '完成' || data['S8.PhaseI.反方'] === '完成');
  const p2n = (data && (data['S8.PhaseII.正方.有效数'] || 0) + (data['S8.PhaseII.反方.有效数'] || 0)) || 0;
  const p3 = data && data['S8.PhaseIII.状态'] === '已结晶';
  const blue = '#1565c0', gray = 'var(--border)';
  return '<div style="display:flex;gap:6px;margin:16px 0;align-items:center">' +
    '<div style="flex:1;text-align:center"><div style="background:' + (p1 ? blue : gray) + ';height:10px;border-radius:5px 0 0 5px"></div><div style="font-size:0.78em;color:var(--gray);margin-top:4px">Phase I<br>框架声明</div></div>' +
    '<div style="color:var(--dim);font-size:1.2em">→</div>' +
    '<div style="flex:1;text-align:center"><div style="background:' + (p2n > 0 ? blue : gray) + ';height:10px"></div><div style="font-size:0.78em;color:var(--gray);margin-top:4px">Phase II<br>微消化 ' + p2n + '次</div></div>' +
    '<div style="color:var(--dim);font-size:1.2em">→</div>' +
    '<div style="flex:1;text-align:center"><div style="background:' + (p3 ? blue : gray) + ';height:10px;border-radius:0 5px 5px 0"></div><div style="font-size:0.78em;color:var(--gray);margin-top:4px">Phase III<br>' + (p3 ? '已结晶' : '未结晶') + '</div></div>' +
    '</div>';
}

// ==================== A8-P2b：节点元数据归一化（structure → 渲染内部模型） ====================

// 入口归一化：v1 string 节点 → 对象 {id, side:null, label:id}；v2 对象原样（浅拷贝）；形态自描述判定版本
function normalizeStructure(structure) {
  if (!structure || !structure.layers) return structure;
  const hasObjectNodes = structure.layers.some(l => (l.nodes || []).some(n => n && typeof n === 'object'));
  const version = (structure.meta && structure.meta.schema_version) || (hasObjectNodes ? 'v2' : 'v1');
  const layers = structure.layers.map(l => ({
    ...l,
    nodes: (l.nodes || []).map(n => (n && typeof n === 'object')
      ? { ...n }
      : { id: n, side: null, label: n, event_type: null, sc_mark: null })
  }));
  return { ...structure, layers, _nodeVersion: version };
}

// 构建 {id → {side,label,event_type,sc_mark,layerId}}；id 与 layerId 为渲染权威源
function buildNodeMeta(structure) {
  const map = {};
  if (!structure || !structure.layers) return map;
  structure.layers.forEach((l, i) => {
    (l.nodes || []).forEach(n => {
      const isObj = n && typeof n === 'object';
      const id = isObj ? n.id : n;
      if (!id) return;
      map[id] = {
        id,
        side: (isObj && n.side) || null,
        label: (isObj && (n.label || n.id)) || id,
        event_type: (isObj && n.event_type) || null,
        sc_mark: (isObj && n.sc_mark) || null,
        layerId: l.id || (i + 1)
      };
    });
  });
  return map;
}

// 节点归属：归一化 side 字段权威；opts.sideOf 仅 v1 兼容后备；两者皆无 → null（不静默进一侧）
function sideOfNode(n, opts) {
  if (n && typeof n === 'object' && n.side) return n.side;
  if (opts && opts.sideOf) {
    const s = opts.sideOf(n && typeof n === 'object' ? n.id : n);
    if (s === 'fh') return '反方'; // v1 旧回调语义兼容
    if (s === 'zh') return '正方';
    return s;
  }
  return null;
}

function nodeCard(n, opts, extraClass) {
  const id = (n && typeof n === 'object') ? n.id : n;
  const label = resolveNodeLabel(n, opts); // 260807：统一入口（节点自带 label → 元数据 → 兜底 ID）
  const badge = (opts && opts.b0bp) ? '<span class="b0bp-badge">B0=B\'</span>' : '';
  return '<div class="pn ' + (extraClass || 'pn-zh') + '"><b>' + id + '</b>' + badge + '<br>' + label + '</div>';
}

// 节点 label/事件类型统一解析（260807：消除 nodeCard / scEventCard 两套分叉链路）
function resolveNodeLabel(n, opts) {
  const id = nodeId(n);
  const meta = (opts && opts.nodeMeta && opts.nodeMeta[id]) || {};
  const labels = (opts && opts.nodeLabels) || {};
  return (n && typeof n === 'object' && n.label) || meta.label || labels[id] || id;
}

function resolveNodeEvent(n, opts) {
  const id = nodeId(n);
  const meta = (opts && opts.nodeMeta && opts.nodeMeta[id]) || {};
  return meta.event_type || ((n && typeof n === 'object' && n.event_type) || '事件');
}

function trackNodes(nodes, side, opts) {
  const cls = side === 'zh' ? 'pn-zh' : 'pn-fh';
  return nodes.map((n, i) =>
    nodeCard(n, opts, cls) + (i < nodes.length - 1 ? '<div class="pa">↓</div>' : '')
  ).join('\n');
}

// A8-P2b：框架铺设层侧列分流（side 权威；双方按 sc_mark；null → unassigned，不静默进一侧）
function splitFrameSide(n, opts, zh, fh, unassigned) {
  const side = sideOfNode(n, opts);
  const sc = (n && typeof n === 'object' && n.sc_mark) || '';
  if (side === '正方') { zh.push(n); return; }
  if (side === '反方') { fh.push(n); return; }
  if (side === '双方') {
    if (sc.indexOf('摩擦') >= 0 || sc.indexOf('错失') >= 0 || sc.indexOf('盲区') >= 0 || sc.indexOf('SC推进') >= 0) {
      unassigned.push(n);
      return;
    }
    zh.push(n); fh.push(n); return; // 框架铺设默认两侧各显示一次
  }
  unassigned.push(n);
}

function nodeId(n) { return (n && typeof n === 'object') ? n.id : n; }

function unassignedNote(unassigned) {
  if (!unassigned || !unassigned.length) return '';
  return '<p class="ps" style="color:var(--dim)">归属未定节点：' + unassigned.map(nodeId).join('·') + '</p>';
}

function renderC3Degraded(type, opts) {
  const data = (opts && opts.data) || {};
  const narrative = (opts && opts.narrative) || '';
  const tagMap = { 0: 't0', '1a': 't1a', '1b': 't1b', '1c': 't1c', '1d': 't1d', '2a': 't2a', '2b': 't2b', '2c': 't2c' };
  const descMap = { 0: '自说自话·未发生真正交锋', '1a': '事件型·单次结构性交锋', '1b': '过程型·多次结构性交锋', '1c': '框架内置型·B0=B\'立论', '1d': '层间迭代型·B\'\'覆盖B\'', '2a': '平行·有起点无推进', '2b': '平行·有推进未结晶', '2c': '平行·纯碰撞型' };
  return '<div style="text-align:center;margin:6px 0 16px 0;font-size:0.78em;color:var(--dim);background:rgba(255,193,0,0.08);padding:4px 12px;border-radius:12px;display:inline-block">⚠ 结构归约未完成 · 降级渲染 · 基于 Phase I/II/III 数据</div>\n' +
    '<div class="pb"><span class="tg ' + (tagMap[type] || 't0') + '">' + type + '型</span> <b>' + (descMap[type] || '') + '</b></div>\n' +
    '<p class="in">' + (narrative || '结构归约未完成，推进层细节省略') + '</p>';
}

function renderC3Zero(layers, opts) {
  const allNodes = [];
  (layers || []).forEach(l => (l.nodes || []).forEach(n => allNodes.push(n)));
  const zh = [], fh = [], unassigned = [];
  allNodes.forEach(n => {
    const side = sideOfNode(n, opts);
    if (side === '反方') fh.push(n);
    else if (side === '正方') zh.push(n);
    else unassigned.push(n);
  });
  const narrative = (opts.narrative || '双方各说各话，未发生真正交锋');
  return '<div class="pw">' +
    '<div class="pz pz-zh"><b style="color:var(--green);font-size:13px;margin-bottom:8px">正方</b>' + trackNodes(zh, 'zh', opts) + (zh.length ? '' : '<p class="ps">（无归属确定节点）</p>') + '</div>' +
    '<div class="pc"><div class="pc2" style="border-style:dashed"><span class="tg t0">0型</span><p class="pcd">' + narrative + '</p><p class="ps">无真正交锋 · 双方各说各话</p></div></div>' +
    '<div class="pz pz-fh"><b style="color:var(--blue);font-size:13px;margin-bottom:8px">反方</b>' + trackNodes(fh, 'fh', opts) + (fh.length ? '' : '<p class="ps">（无归属确定节点）</p>') + '</div>' +
    '</div>' +
    unassignedNote(unassigned) +
    '<div class="pb"><span class="tg t0">0型</span> <b>自说自话·未发生真正交锋</b></div>';
}

function renderAggUnit(unit, idx, total, opts) {
  const isLast = idx === total - 1;
  let pct = unit.title || (total === 1 ? '聚合·结构性交锋' : ('聚合·第' + (idx + 1) + '次结构性交锋' + (isLast ? '（决胜层）' : '')));
  if (opts && opts.c3Mode === 'detail' && (unit.producer || unit.layerId)) {
    const tags = [];
    if (unit.layerId) tags.push('推进层' + unit.layerId);
    if (unit.producer) tags.push(unit.producer + '发起');
    pct += ' · ' + tags.join('·');
  }
  const pcd = unit.pcd || '承认对方 → 引入B\' → 统一结论（数据待 C7 语义节点链）';
  const pcf = unit.pcf || (unit.nodes || []).map(nodeId).join('·');
  return '<div class="pf-arr">↘ ↙</div>\n' +
    '<div class="pc1" style="max-width:100%"><div class="pct">' + pct + '</div><p class="pcd">' + pcd + '</p><p class="pcf">(' + pcf + ')</p></div>\n' +
    '<div class="pm">⇣</div>\n' +
    '<div class="pu"><b>统一结论·' + (isLast ? '最终聚合' : '一次聚合') + '</b><br>' + (unit.pu || '') + '</div>';
}

// ==================== 260806 P0：1 型漏斗·合点方案 ====================
// 语义口径：层=推进步（聚合点/节拍）；层内多事件围绕同一论证点=一个推进步，事件不独立成步；
// 聚合前（框架铺设→首个SC推进层）双轨未合流→两件套分隔（绿▼+红▼）；
// 聚合后（SC推进层→下一层/收束）已合流为一条主线→单个居中主题色 ▼。

function layerSepHtml(preAggregation) {
  if (preAggregation) {
    return '<div class="pw" style="gap:16px">' +
      '<div class="pf-sep" style="--sep-color:var(--green);flex:1"></div>' +
      '<div class="pf-sep" style="--sep-color:var(--red);flex:1"></div></div>';
  }
  return '<div class="pf-sep" style="--sep-color:var(--blue)"></div>';
}

// 聚合依据：mechanisms.operation_tags（serves_layer 或节点命中）+ 层 m_ids
function operationTagsForLayer(layer, structure) {
  const tags = [];
  const nodeIds = (layer.nodes || []).map(nodeId);
  (structure.mechanisms || []).forEach(m => {
    const mechNodes = (m.nodes || []).map(nodeId);
    const match = m.serves_layer === layer.id || mechNodes.some(x => nodeIds.indexOf(x) >= 0);
    if (match && Array.isArray(m.operation_tags)) tags.push(...m.operation_tags);
  });
  return Array.from(new Set(tags));
}

// 层内事件卡：编号·事件类型 + label；摩擦卡附加“双方摩擦（X发起）·有碰撞无接收”
function scEventCard(n, cls, opts, frictionNote) {
  const id = nodeId(n);
  const evt = resolveNodeEvent(n, opts);
  const label = resolveNodeLabel(n, opts);
  const note = frictionNote ? '<br><span style="color:var(--dim)">' + frictionNote + '</span>' : '';
  return '<div class="pn ' + cls + '"><b>' + id + '·' + evt + '</b>' + note + '<br>' + label + '</div>';
}

// 双轨归属：side 权威；双方+摩擦/对方节点 → 对方轨道；无 side → producer 轨道；仍无 → unassigned
function buildLayerTracks(layer, opts, producer) {
  const zh = [], fh = [], unassigned = [];
  const seen = new Set();
  const oppSide = producer === '正方' ? '反方' : producer === '反方' ? '正方' : null;
  const frictionIds = new Set((layer.friction_nodes || []).concat((layer.friction_timeline && layer.friction_timeline.during) || []).map(nodeId).filter(Boolean));
  const oppIds = new Set((layer.opponent_nodes || []).map(nodeId).filter(Boolean));
  const push = (n, side) => {
    const id = nodeId(n);
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (side === '正方') zh.push(n);
    else if (side === '反方') fh.push(n);
  };
  (layer.nodes || []).forEach(n => {
    const id = nodeId(n);
    const s = sideOfNode(n, opts);
    if (s === '正方') push(n, '正方');
    else if (s === '反方') push(n, '反方');
    else if (s === '双方') {
      if (frictionIds.has(id) || oppIds.has(id)) push(n, oppSide || '正方');
      else unassigned.push(n);
    }
    else if (producer) push(n, producer);
    else unassigned.push(n);
  });
  (layer.opponent_nodes || []).forEach(n => {
    const id = nodeId(n);
    if (!seen.has(id)) push(n, oppSide || '正方');
  });
  return { zh, fh, unassigned, frictionIds };
}

// SC推进层：双轨事件行 → ↘↙ 汇聚 → .pc1 聚合卡（层标题/聚合依据/层摘要）→ ⇣ → .pu 统一结论
function renderSCLayer(layer, idx, opts, type, scCount, structure, covered, completer) {
  const producer = layer.producer || '';
  const layerId = layer.id || (idx + 2);
  const layerLabel = '推进层' + layerId;
  const isLast = idx === scCount - 1;
  const oppSide = producer === '正方' ? '反方' : producer === '反方' ? '正方' : null;
  const tracks = buildLayerTracks(layer, opts, producer);
  const ft = layer.friction_timeline || {};
  const parts = [];
  if (ft.before && ft.before.length) parts.push('<div style="font-size:0.78em;color:var(--dim);margin:4px 0;text-align:center">推进前摩擦：' + ft.before.join('·') + '</div>');
  const col = (heading, nodes, cls, trackIsProducer) => {
    if (!nodes.length) return '<div class="pz ' + cls + '"><b style="font-size:0.85em">' + heading + '</b><p class="ps">（无归属节点）</p></div>';
    const cards = nodes.map((n, i) => {
      const isFriction = tracks.frictionIds.has(nodeId(n));
      const note = isFriction ? '双方摩擦（' + (oppSide || '对方') + '发起）·有碰撞无接收' : '';
      const cardCls = trackIsProducer ? 'pn-p2' : (cls === 'pz-zh' ? 'pn-zh' : 'pn-fh');
      return scEventCard(n, cardCls, opts, note) + (i < nodes.length - 1 ? '<div class="pa">↓</div>' : '');
    }).join('\n');
    return '<div class="pz ' + cls + '"><b style="font-size:0.85em">' + heading + '</b>' + cards + '</div>';
  };
  parts.push('<div class="pw">' +
    col('正方轨道' + (producer === '正方' ? ' · 推进方' : ' · 对方/摩擦'), tracks.zh, 'pz-zh', producer === '正方') +
    col('反方轨道' + (producer === '反方' ? ' · 推进方' : ' · 对方/摩擦'), tracks.fh, 'pz-fh', producer === '反方') +
    '</div>');
  parts.push('<div class="pf-arr">↘ ↙</div>');
  const tags = operationTagsForLayer(layer, structure);
  const mIds = (layer.m_ids || []).join('·');
  const basisParts = [];
  if (tags.length) basisParts.push(tags.join('·'));
  if (mIds) basisParts.push(mIds);
  let title = layerLabel + ' · SC推进' + (producer ? ' · ' + producer + '发起' : '');
  if (isLast && scCount > 1) title += '（决胜层）';
  let pcd = layer.structural_change_summary || layer.push_collision || '';
  if (type === '1d') {
    if (idx === 0 && covered) pcd = '【B\' 层·先完成方 ' + covered + ' 完成】' + pcd;
    if (isLast && completer) pcd = '【B\'\' 层·后完成方 ' + completer + ' 完成·上位覆盖】' + pcd;
  }
  const pcf = (layer.nodes || []).map(nodeId).join('·');
  parts.push('<div class="pc1" style="max-width:100%">' +
    '<div class="pct">' + title + '</div>' +
    (basisParts.length ? '<p class="ps">聚合依据：' + basisParts.join(' | ') + '</p>' : '') +
    (pcd ? '<p class="pcd">' + pcd + '</p>' : '') +
    (pcf ? '<p class="pcf">(' + pcf + ')</p>' : '') +
    '</div>');
  parts.push('<div class="pm">⇣</div>');
  parts.push('<div class="pu"><b>统一结论 · ' + layerLabel + '</b><br>' + (layer.unified_conclusion || '') + '</div>');
  if (ft.after && ft.after.length) parts.push('<div style="font-size:0.78em;color:var(--dim);margin:4px 0;text-align:center">推进后摩擦：' + ft.after.join('·') + '</div>');
  return parts.join('\n');
}

// 收束·结晶金框卡：同时体现完成方与未结晶方（N7 完成·反方 / N8 未结晶·正方）
function renderCrystallization(layer, opts, type) {
  const nodes = layer.nodes || [];
  const state = layer.crystallization_state || '';
  const parts = [];
  parts.push('<div class="pc2" style="border:2px solid var(--gold);max-width:100%">');
  let title;
  if (type === '2a' || type === '2b' || type === '2c') {
    title = (state.indexOf('完成') >= 0 && state.indexOf('未') < 0) ? ('收束·结晶 · ' + state) : '收束·未结晶';
  } else {
    title = '收束·结晶' + (state ? ' · ' + state : '');
  }
  parts.push('<div class="pct" style="color:var(--gold)">' + title + '</div>');
  const statuses = nodes.map(n => {
    const s = sideOfNode(n, opts) || '—';
    const mark = (n && typeof n === 'object' && n.sc_mark) || '';
    const st = mark.indexOf('完成') >= 0 ? '完成' : mark.indexOf('未结晶') >= 0 ? '未结晶' : (mark || '—');
    return st + '·' + s + '（' + nodeId(n) + '）';
  });
  if (statuses.length) parts.push('<p class="ps">' + statuses.join(' / ') + '</p>');
  if (layer.final_unified_conclusion) parts.push('<p class="pcd">' + layer.final_unified_conclusion + '</p>');
  if (layer.final_deciding_layer) parts.push('<p class="ps" style="color:var(--dim)">' + layer.final_deciding_layer + '</p>');
  if (nodes.length) parts.push('<p class="pcf">(' + nodes.map(nodeId).join('·') + ')</p>');
  parts.push('</div>');
  return parts.join('\n');
}

function renderC3Funnel(type, layers, structure, opts) {
  opts = opts || {};
  opts.b0bp = type === '1c';
  const phase1 = layers[0] || { nodes: [] };
  const last = layers[layers.length - 1] || {};
  const zh = [], fh = [], unassigned = [];
  (phase1.nodes || []).forEach(n => splitFrameSide(n, opts, zh, fh, unassigned));
  const allUnassigned = new Set(unassigned.map(nodeId).filter(Boolean));
  const parts = [];
  parts.push('<div class="pf">');
  parts.push('<div class="pw">' +
    '<div class="pz pz-zh"><b style="color:var(--green);font-size:13px;margin-bottom:8px">正方</b>' + trackNodes(zh, 'zh', opts) + (zh.length ? '' : '<p class="ps">（无归属确定节点）</p>') + '</div>' +
    '<div class="pz pz-fh"><b style="color:var(--blue);font-size:13px;margin-bottom:8px">反方</b>' + trackNodes(fh, 'fh', opts) + (fh.length ? '' : '<p class="ps">（无归属确定节点）</p>') + '</div>' +
    '</div>');
  const scLayers = layers.slice(1, -1);
  const covered = (opts.data && opts.data['S8.PhaseIII.被覆盖完成方']) || '';
  const completer = (opts.data && opts.data['S8.PhaseIII.完成方']) || '';
  if (scLayers.length === 0) {
    // 无中间推进层：仍展示一次聚合（单次收束），再进收束金卡
    parts.push(layerSepHtml(true));
    parts.push(renderAggUnit({ pcd: last.structural_change_summary || last.final_unified_conclusion || '结构性交锋完成（单次收束）', pu: last.final_unified_conclusion || '' }, 0, 1, opts));
    parts.push(layerSepHtml(false));
  } else {
    scLayers.forEach((l, i) => {
      // 聚合前（首个推进层前）两件套绿/红；聚合后（层间/收束前）单个居中主题色 ▼
      parts.push(layerSepHtml(i === 0));
      parts.push(renderSCLayer(l, i, opts, type, scLayers.length, structure, covered, completer));
      // 1d：层间覆盖发生在 B' 聚合之后、B'' 聚合之前（两条 SC 链的交接处）
      if (type === '1d' && i === 0 && scLayers.length >= 2) {
        parts.push('<div class="pf-sep"><b>层间覆盖：后完成方 B\'\' 上位覆盖先完成方 B\'，决胜层在最外层</b></div>');
      }
    });
    parts.push(layerSepHtml(false));
  }
  if (layers.length >= 2) parts.push(renderCrystallization(last, opts));
  scLayers.forEach(l => {
    buildLayerTracks(l, opts, l.producer || '').unassigned.forEach(n => allUnassigned.add(nodeId(n)));
  });
  const unassignedList = Array.from(allUnassigned).filter(Boolean);
  if (unassignedList.length) parts.push('<p class="ps" style="color:var(--dim)">归属未定节点：' + unassignedList.join('·') + '</p>');
  const descMap = { '1a': '聚合主线·有清晰的决胜逻辑', '1b': '聚合主线·渐进收束', '1c': '聚合主线·B0=B\'框架内置', '1d': '聚合主线·层间迭代（B\'\'覆盖B\'）' };
  parts.push('<div class="pb"><span class="tg ' + ('t' + type) + '">' + type + '型</span> <b>' + (descMap[type] || '') + '</b></div>');
  parts.push('</div>');
  return parts.join('\n');
}

function renderC3ThreeColumn(type, layers, structure, opts) {
  const phase1 = layers[0] || { nodes: [] };
  const last = layers[layers.length - 1] || {};
  const zh = [], fh = [], unassigned = [];
  (phase1.nodes || []).forEach(n => splitFrameSide(n, opts, zh, fh, unassigned));
  const middle = [];
  const scLayers = layers.slice(1, -1);
  const pctText = type === '2a' ? '碰撞点·有起点无推进' : type === '2b' ? '碰撞点·有推进未结晶' : '碰撞点·纯碰撞型';
  const psText = type === '2a' ? '平行轨道·框架已铺设但从未激活' : type === '2b' ? '平行轨道·SC推进存在但未收束' : '平行轨道·纯平行交火';
  scLayers.forEach((l, i) => {
    // A7-B2/F7：推进层分隔线（2型·每个推进节点前标注推进层 ID）
    const layerLabel = '推进层' + (l.id || (i + 2));
    if (i === 0) middle.push('<div class="pf-sep-plain"></div>');
    middle.push('<div style="text-align:center;font-size:0.78em;color:var(--dim);margin:10px 0 2px 0">▾ ' + layerLabel + ' ▾</div>');
    const pct = opts.c3Mode === 'detail' && (l.id || i + 2) ? (layerLabel + ' · ' + pctText) : pctText;
    const pcd = l.push_collision || (l.structural_change_summary || '').slice(0, 120);
    // A7-B2/缺陷C：friction_nodes 附着渲染（规则 L3590：不独立成推进层）；>3 截断 + title 悬停 + word-break
    const frictionList = l.friction_nodes || [];
    const frictionDisplay = frictionList.length > 3
      ? frictionList.slice(0, 3).join('·') + '…（共' + frictionList.length + '个）'
      : frictionList.join('·');
    const frictionNote = frictionList.length
      ? '<p class="pcf" style="color:var(--dim);word-break:break-all" title="' + frictionList.join('·') + '">摩擦节点（有碰撞无接收）：' + frictionDisplay + '</p>' : '';
    middle.push('<div class="pc2"><div class="pct">' + pct + '</div><p class="ps">' + psText + '</p><p class="pcd">' + (pcd || '') + '</p><p class="pcf">(' + (l.nodes || []).map(nodeId).join('·') + ')</p>' + frictionNote + '</div>');
    // A8-P2b：推进层节点分侧——producer 权威；缺失时用 nodeMeta.side 推断；仍缺失 → unassigned（不静默）
    (l.nodes || []).forEach(n => {
      const prod = l.producer;
      if (prod === '反方') fh.push(n);
      else if (prod === '正方') zh.push(n);
      else {
        const s = sideOfNode(n, opts);
        if (s === '反方') fh.push(n);
        else if (s === '正方') zh.push(n);
        else unassigned.push(n);
      }
    });
    (l.opponent_nodes || []).forEach(n => { (l.producer === '反方' ? zh : fh).push(n); });
  });
  if (!middle.length) middle.push('<div class="pc2"><div class="pct">' + pctText + '</div><p class="ps">' + psText + '</p><p class="pcd">双方立论有容纳潜力但后续未见实质推进·≤120字</p><p class="pcf"></p></div>');
  const descMap = { '2a': '平行主线·缺乏聚合的决胜锚点', '2b': '平行主线·有推进未结晶', '2c': '平行主线·纯碰撞' };
  let out = '<div class="pw">' +
    '<div class="pz pz-zh"><b style="color:var(--green);font-size:13px;margin-bottom:8px">正方 · ' + (type + '轨道') + '</b>' + trackNodes(zh, 'zh', opts) + (zh.length ? '' : '<p class="ps">（无归属确定节点）</p>') + '</div>' +
    '<div class="pc">' + middle.join('\n') + '</div>' +
    '<div class="pz pz-fh"><b style="color:var(--blue);font-size:13px;margin-bottom:8px">反方 · ' + (type + '轨道') + '</b>' + trackNodes(fh, 'fh', opts) + (fh.length ? '' : '<p class="ps">（无归属确定节点）</p>') + '</div>' +
    '</div>';
  // 260806 实测修复：2 型三列同样渲染收束·结晶层金框卡（强制数据流规则 layers[-1] 始终金框）
  if (layers.length >= 2) out += '\n' + renderCrystallization(last, opts, type);
  out += '\n' + unassignedNote(unassigned) +
    '<div class="pb"><span class="tg ' + ('t' + type) + '">' + type + '型</span> <b>' + (descMap[type] || '') + '</b></div>';
  return out;
}

// 深度档"简述类型"：类型徽章 + 框架/B0 卡 + 聚合/碰撞摘要（无节点链细节）
function renderC3Summary(type, structure, opts) {
  opts = opts || {};
  const layers = structure.layers || [];
  const phase1 = layers[0] || {};
  const last = layers[layers.length - 1] || {};
  const tagMap = { '0': 't0', '1a': 't1a', '1b': 't1b', '1c': 't1c', '1d': 't1d', '2a': 't2a', '2b': 't2b', '2c': 't2c' };
  const descMap = { '0': '自说自话·未发生真正交锋', '1a': '事件型·单次结构性交锋', '1b': '过程型·多次结构性交锋', '1c': '框架内置型·B0=B\'立论', '1d': '层间迭代型·B\'\'覆盖B\'', '2a': '平行·有起点无推进', '2b': '平行·有推进未结晶', '2c': '平行·纯碰撞型' };
  const narrative = opts.narrative || '';
  const parts = [];
  parts.push('<div class="pb"><span class="tg ' + (tagMap[type] || 't0') + '">' + type + '型</span> <b>' + (descMap[type] || '') + '</b></div>');
  const frameNodes = (phase1.nodes || []).map(nodeId).join('·');
  if (frameNodes) parts.push('<div class="pc1"><div class="pct">框架铺设</div><p class="pcd">' + frameNodes + '</p></div>');
  if (type === '0') {
    parts.push('<div class="pc2" style="border-style:dashed"><span class="tg t0">0型</span><p class="pcd">' + (narrative || '双方各说各话') + '</p><p class="ps">无真正交锋 · 双方各说各话</p></div>');
  } else if (type === '1a' || type === '1b' || type === '1c' || type === '1d') {
    let units = (opts.aggregationUnits && opts.aggregationUnits.length)
      ? opts.aggregationUnits
      : layers.slice(1, -1).map(l => ({ pcd: l.structural_change_summary || l.push_collision || '', pu: l.unified_conclusion || last.final_unified_conclusion || '' }));
    if (units.length === 0) {
      units.push({ pcd: last.structural_change_summary || last.final_unified_conclusion || '结构性交锋完成（单次收束）', pu: last.final_unified_conclusion || '' });
    }
    // 1d（2026-08-05）：简述档同样标注 B'/B'' 归属方（DATA 驱动）
    if (type === '1d') {
      const covered = (opts.data && opts.data['S8.PhaseIII.被覆盖完成方']) || '';
      const completer = (opts.data && opts.data['S8.PhaseIII.完成方']) || '';
      units = units.map(u => ({ ...u, pcd: u.pcd }));
      if (units.length >= 1 && covered) units[0].pcd = '【B\' 层·先完成方 ' + covered + ' 完成】' + (units[0].pcd || '');
      if (units.length >= 2 && completer) units[units.length - 1].pcd = '【B\'\' 层·后完成方 ' + completer + ' 完成·上位覆盖】' + (units[units.length - 1].pcd || '');
    }
    units.forEach((u, i) => {
      const title = units.length === 1 ? '聚合·结构性交锋' : ('聚合·第' + (i + 1) + '次结构性交锋' + (i === units.length - 1 ? '（决胜层）' : ''));
      parts.push('<div class="pc1"><div class="pct">' + title + '</div><p class="pcd">' + (u.pcd || '') + '</p><p class="pcf">' + (u.pu || '') + '</p></div>');
      if (type === '1d' && i === 0 && units.length >= 2) {
        parts.push('<div class="pc2" style="border:2px solid var(--gold)"><b>层间覆盖：后完成方 B\'\' 上位覆盖先完成方 B\'，决胜层在最外层</b></div>');
      }
    });
  } else {
    const scLayers = layers.slice(1, -1);
    const pctText = type === '2a' ? '碰撞点·有起点无推进' : type === '2b' ? '碰撞点·有推进未结晶' : '碰撞点·纯碰撞型';
    scLayers.forEach(l => {
      parts.push('<div class="pc2"><div class="pct">' + pctText + '</div><p class="pcd">' + (l.push_collision || (l.structural_change_summary || '').slice(0, 120) || '') + '</p></div>');
    });
    if (!scLayers.length) parts.push('<div class="pc2"><div class="pct">' + pctText + '</div><p class="pcd">双方立论有容纳潜力但后续未见实质推进</p></div>');
  }
  return parts.join('\n');
}

function renderC3Panel(structure, effectiveType, opts) {
  opts = opts || {};
  // A8-P7：禁止降级渲染——structure 缺失或 degrade=full 一律抛错阻断（不再回退旧版 C3 降级渲染）
  if (!structure || !structure.layers) throw new Error('C3 渲染缺少 structure.layers——禁止降级渲染（结构归约必须完整）。');
  if (opts.degrade === 'full') throw new Error('degrade=full 降级模式已禁用——structure 缺失必须阻断，禁止回退旧版降级渲染。');
  // A8-P2b：入口一次归一化 + nodeMeta 构建（C3 是唯一消费节点元数据的模块，归一化局部化）
  structure = normalizeStructure(structure);
  opts.nodeMeta = buildNodeMeta(structure);
  const type = effectiveType || '0';
  if (opts.c3Mode === 'summary') return renderC3Summary(type, structure, opts);
  if (type === '0') return renderC3Zero(structure.layers, opts);
  if (type === '1a' || type === '1b' || type === '1c' || type === '1d') return renderC3Funnel(type, structure.layers, structure, opts);
  return renderC3ThreeColumn(type, structure.layers, structure, opts);
}

// 图2 反馈回路图（4.6.3：双回路 + 闭环判定）
function c8Chart2(data) {
  const Qs = ['Q1', 'Q2', 'Q3', 'Q4'];
  const sideLoop = (side, baseX) => {
    const q = data[side];
    const color = side === 'pro' ? '#2e7d32' : '#1565c0';
    const gray = '#bdbdbd';
    const parts = [];
    // C2：按模板绝对坐标重写——rect y=40/100，竖线 y=86→100 连接两行，状态 y=164；x 由 baseX（20/230）定位
    const boxes = [
      { q: 'Q1', x: baseX, y: 40 }, { q: 'Q2', x: baseX + 90, y: 40 },
      { q: 'Q4', x: baseX, y: 100 }, { q: 'Q3', x: baseX + 90, y: 100 }
    ];
    boxes.forEach(b => {
      const v = q[b.q];
      const filled = v !== '空缺';
      parts.push('<rect x="' + b.x + '" y="' + b.y + '" width="80" height="46" rx="6" fill="' + (filled ? (side === 'pro' ? '#e8f5e9' : '#e3f2fd') : '#f5f5f5') + '" stroke="' + (filled ? color : '#ddd') + '" stroke-width="1"/>');
      parts.push('<text x="' + (b.x + 40) + '" y="' + (b.y + 20) + '" text-anchor="middle" font-size="12" font-weight="bold" fill="' + (filled ? color : gray) + '">' + b.q + '</text>');
      parts.push('<text x="' + (b.x + 40) + '" y="' + (b.y + 38) + '" text-anchor="middle" font-size="10" fill="' + (filled ? '#666' : gray) + '">' + (filled ? '→ ' + v : '空缺') + '</text>');
    });
    const loop1 = q.Q1 !== '空缺' && q.Q4 !== '空缺';
    const loop2 = q.Q2 !== '空缺' && q.Q3 !== '空缺';
    const status = loop1 && loop2 ? '✅ 闭环自洽 ✓' : '⚠ 存在断环 ✗';
    parts.push('<line x1="' + (baseX + 40) + '" y1="86" x2="' + (baseX + 40) + '" y2="100" stroke="' + (loop1 ? color : '#c62828') + '" stroke-width="2.5" stroke-dasharray="' + (loop1 ? 'none' : '5,3') + '"/>');
    parts.push('<line x1="' + (baseX + 130) + '" y1="86" x2="' + (baseX + 130) + '" y2="100" stroke="' + (loop2 ? color : '#c62828') + '" stroke-width="2.5" stroke-dasharray="' + (loop2 ? 'none' : '5,3') + '"/>');
    parts.push('<text x="' + (baseX + 85) + '" y="164" text-anchor="middle" font-size="12" font-weight="bold" fill="' + (loop1 && loop2 ? color : '#c62828') + '">' + status + '</text>');
    return { html: parts.join('\n'), loop: loop1 && loop2 };
  };
  const pro = sideLoop('pro', 20), con = sideLoop('con', 230);
  const caption = '正方[' + (pro.loop ? '闭环自洽' : '存在断环') + ']·反方[' + (con.loop ? '闭环自洽' : '存在断环') + ']';
  return '<svg viewBox="0 0 420 174" xmlns="http://www.w3.org/2000/svg" font-family="\'Microsoft YaHei\',sans-serif">' +
    '<text x="110" y="20" text-anchor="middle" font-size="13" font-weight="bold" fill="#2e7d32">正方反馈回路</text>' +
    '<text x="310" y="20" text-anchor="middle" font-size="13" font-weight="bold" fill="#1565c0">反方反馈回路</text>' +
    pro.html + con.html +
    '</svg><p class="chart-caption">' + caption + '</p>';
}

// ==================== 阶段一输入解析 ====================

function extractDataMarkers(md) {
  const data = {};
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    // 260806 实测容错：模型偶发输出闭合式 <!--/DATA: ... -->，按 <!--DATA: 解析
    const m = line.match(/^<!--\s*\/?DATA:\s*(\S+?)=(.+?)\s*-->$/);
    if (m) {
      const key = m[1];
      let value = m[2].trim();
      if (/^\d+$/.test(value)) value = parseInt(value);
      // M-ID 归一化（与 pipeline 同一套契约工具），保证渲染数据与校验数据同口径
      if (key === 'S8.PhaseII.正方.节点列表' || key === 'S8.PhaseII.反方.节点列表' || key === 'S7.CP入选列表') {
        value = String(value).split(/[|,，]/).map(contract.normalizeMId).join('|');
      } else if (/^S14\.教育洞察\.(正方|反方)\.\d+$/.test(key)) {
        const parts = String(value).split('|');
        if (parts.length >= 2) parts[parts.length - 1] = contract.normalizeMId(parts[parts.length - 1]);
        value = parts.join('|');
      } else if (key === 'C8.叙事人格.正方' || key === 'C8.叙事人格.反方' || key === 'C8.人格胜负') {
        const parts = String(value).split('|');
        if (parts.length >= 3) parts[parts.length - 1] = contract.normalizeMId(parts[parts.length - 1]);
        value = parts.join('|');
      }
      data[key] = value;
    }
  }
  return data;
}

function stripTags(s) {
  return s.replace(/<!--[\s\S]*?-->/g, ' ').trim();
}

// 槽位正文“重复标题前缀”剥离（标题由骨架渲染；正文若以相同标题开头则去除，含加粗/冒号变体）
function stripSlotHeadingDup(text, title) {
  if (typeof text !== 'string') return text;
  let t = text.replace(/^\s+/, '');
  const bold = t.startsWith('**' + title + '**');
  const plain = !bold && t.startsWith(title);
  if (!bold && !plain) return text;
  let rest = bold ? t.slice(title.length + 4) : t.slice(title.length);
  rest = rest.replace(/^[：:，,．.\s]+/, '');
  rest = rest.replace(/^\n+/, '');
  return rest.length ? rest : text;
}

// 报告输出边界：读者可见文本的裸 SC → 结构性交锋（规则级兜底，替代短语枚举）
// 跳过 style/script/svg/textarea/title 原始文本、HTML 注释与标签属性；边界条件避免误伤 ASCII 单词（如 discuss）
function applyVisibleTerminology(html) {
  const src = String(html || '');
  let out = '';
  let text = '';
  let i = 0;
  const n = src.length;
  const flush = () => {
    if (!text) return;
    out += text.replace(/(^|[^A-Za-z0-9])SC(?![A-Za-z0-9])/g, '$1结构性交锋');
    text = '';
  };
  while (i < n) {
    const c = src[i];
    if (c !== '<') { text += c; i++; continue; }
    if (src.startsWith('<!--', i)) {
      flush();
      const e = src.indexOf('-->', i + 4);
      const end = e < 0 ? n : e + 3;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    flush();
    const isClose = src[i + 1] === '/';
    let j = i + 1;
    if (isClose) j++;
    let name = '';
    while (j < n && /[A-Za-z0-9]/.test(src[j])) { name += src[j]; j++; }
    const gt = src.indexOf('>', j);
    const tagEnd = gt < 0 ? n : gt + 1;
    out += src.slice(i, tagEnd);
    const lower = name.toLowerCase();
    if (!isClose && ['style', 'script', 'svg', 'textarea', 'title'].includes(lower)) {
      const close = src.toLowerCase().indexOf('</' + lower, tagEnd);
      const rawEnd = close < 0 ? n : close;
      out += src.slice(tagEnd, rawEnd);
      i = rawEnd;
      continue;
    }
    i = tagEnd;
  }
  flush();
  return out;
}

// 叙事.md → 每 C 模块的 {xp, slots}（按 INSERT 块边界拆分：两标记间文本属于前一槽）
function extractModules(narrativeMd) {
  const modules = {};
  // 消费整行标题（"## C1 胜负判决"），避免标题残留混入模块正文/pre
  const parts = narrativeMd.replace(/\r\n/g, '\n').split(/^##\s*C(\d{1,2})\b[^\n]*\n?/gm);
  // parts: [pre, '1', body1, '2', body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const id = 'C' + parts[i];
    const body = parts[i + 1] || '';
    const xpMatch = body.match(/<!--XP:([\s\S]*?)-->/);
    const slots = {};
    const segs = body.split(/(<!--INSERT_C\d+_[A-Z0-9_]+-->)/g);
    // 成对/单标记双兼容：R5 实际输出为“开标记…内容…同名关标记”，
    // 合同（L4439）亦允许“开标记…内容…下一标记”。同名第二次出现=关闭当前槽；
    // 异名出现=隐式关闭上一槽并开启新槽；两标记间文本归属当前槽。
    let current = null;
    for (const seg of segs) {
      if (/^<!--INSERT_C\d+_[A-Z0-9_]+-->$/.test(seg)) {
        const name = seg.replace(/^<!--/, '').replace(/-->$/, '');
        if (current === name) {
          current = null; // 同名关闭标记：槽内容已收集，停止追加
        } else {
          current = name;
          slots[current] = [];
        }
      } else if (current) {
        slots[current].push(seg);
      }
    }
    const slotText = {};
    for (const k of Object.keys(slots)) slotText[k] = slots[k].join('').replace(/<!--XP:[\s\S]*?-->/g, '').trim();
    // pre：第一个 INSERT 标记之前的正文（R5 实际输出可能将诗评等内容置于标记前）
    const pre = (!segs[0] || /^<!--INSERT_C\d+_[A-Z0-9_]+-->$/.test(segs[0].trim())) ? '' : segs[0];
    modules[id] = {
      xp: xpMatch ? xpMatch[1].trim() : '',
      slots: slotText,
      prose: stripTags(body.replace(/<!--XP:[\s\S]*?-->/g, '')),
      pre: pre.replace(/<!--XP:[\s\S]*?-->/g, '').trim(),
      raw: body // B2：保留未剥标签的原始正文，供 C1 表格/理由路由
    };
  }
  return modules;
}

function extractTableBlocks(md) {
  const blocks = [];
  const re = /<!--TABLE:([^>]+)-->\s*([\s\S]*?)<!--\/TABLE-->/g;
  let m;
  while ((m = re.exec(md)) !== null) blocks.push({ attrs: m[1].trim(), body: m[2].trim() });
  return blocks;
}

// 阶段一 normalize：定义 normalized content model（C4/C5/C6 的输入契约）
function normalizePhase1(transitionMd, narrativeMd) {
  const data = extractDataMarkers(transitionMd);
  // B4：未注册 INSERT 名进入 warnings（不阻断，供日志；门禁由 A2 负责）
  let registry = null;
  try { registry = contract.parseInsertRegistry(__dirname + '/Skill-Judge.md'); } catch (e) {}
  const warnings = [];
  const modules = extractModules(narrativeMd);
  if (registry) {
    const names = new Set(registry.inserts.map(r => r.name));
    for (const [id, mod] of Object.entries(modules)) {
      for (const k of Object.keys(mod.slots || {})) {
        if (!names.has(k.replace(/^INSERT_/, ''))) warnings.push('未注册INSERT名: ' + k + '（' + id + '）');
      }
    }
  }
  return {
    modules,
    tables: extractTableBlocks(narrativeMd),
    chartsData: data,           // C4 读取图表所需 DATA
    data: data,                 // C6 判决文本/深度参数读取
    rawTransition: transitionMd, // A7-B1：S2 表现场解析需要原始过渡文件文本（任务 5）
    warnings
  };
}

// ==================== 渲染（renderHTML·C4/C5/C6 桩位） ====================

function wrapProseStub(prose) {
  // C6 将替换为完整裹文（粗体/列表/段落）；本桩仅分段
  return prose.split(/\n\s*\n/).filter(Boolean).map(p => '<p class="in">' + p.trim() + '</p>').join('\n');
}

// C6 完整裹文（R6b-2 规则：TABLE→表格 / ###→h3 / ---→hr / 列表→ul / **→strong / 胜负宣告→p.wn / 诗评→div.po / BADGE→交叉验证）
function wrapProse(prose, opts) {
  opts = opts || {};
  let text = String(prose || '');
  text = text.replace(/<!--BADGE:([a-z0-9]+)-->/g, (m, x) => {
    if (opts.effectiveType && opts.effectiveType !== x) return '<!--WARNING: BADGE交叉验证失败 R6a=' + opts.effectiveType + ' R5=BADGE:' + x + '-->';
    return '';
  });
  // 剥除叙事透传的分析元数据注释（DATA/COLSPAN 是过渡产物，不应出现在最终报告；NOPUB/BADGE 语义不受影响）
  text = text.replace(/<!--(?:DATA|COLSPAN):[^>]*-->/g, '');
  // 编号小节行（如 4.1/4.2）单换行连排 → 空行分段（260807：C8 驱动力对比四段式兜底）
  text = text.replace(/\n(?=\d+\.\d+\s[^|])/g, '\n\n');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (t.startsWith('<!--TABLE:')) {
      const blockLines = [raw];
      i++;
      while (i < lines.length && !lines[i].includes('<!--/TABLE-->')) { blockLines.push(lines[i]); i++; }
      if (i < lines.length) blockLines.push(lines[i]); // 闭合行
      const block = blockLines.join('\n');
      const am = block.match(/<!--TABLE:([^>]+)-->/);
      const body = block.slice(block.indexOf('-->') + 3, block.indexOf('<!--/TABLE-->'));
      const tb = RT.renderTable({ attrs: am ? am[1].trim() : '', body: body.trim() });
      out.push(tb.html);
      i++;
      continue;
    }
    // Markdown 表格兜底（未被 TABLE 标记包裹的 |...| 连续行；允许前导 <!--COLSPAN--> 注释行，
    // 由 RT.renderTable 结构性识别通宽标题并丢弃注释，防止整表退化成带竖线的段落）
    if (t.startsWith('|') || (t === '<!--COLSPAN-->' && i + 1 < lines.length && lines[i + 1].trim().startsWith('|'))) {
      const rows = [];
      while (i < lines.length && (lines[i].trim().startsWith('|') || lines[i].trim() === '<!--COLSPAN-->')) { rows.push(lines[i].trim()); i++; }
      const body = rows.join('\n');
      const tb = RT.renderTable({ attrs: '列=', body });
      out.push(tb.html);
      continue;
    }
    if (/^###\s+/.test(t)) { out.push('<h3 style="font-size:1.05em;color:var(--text);margin:16px 0 8px 0">' + RT.processInlineBold(t.replace(/^###\s+/, '')) + '</h3>'); i++; continue; }
    if (/^-{3,}$/.test(t)) { out.push('<hr style="border:none;border-top:1px solid var(--border);margin:32px 0 24px 0">'); i++; continue; }
    if (/^\*\*(正|反)方/.test(t) && t.includes('胜（')) { out.push('<p class="wn">' + t.replace(/\*\*/g, '') + '</p>'); i++; continue; }
    // 诗评：连续 4 短行（每行 ≤25 字，无标记）
    if (i + 3 < lines.length && lines.slice(i, i + 4).every(l => { const s = l.trim(); return s.length > 0 && s.length <= 25 && !/^[#|*\-\s]/.test(s) && !s.startsWith('<!--'); })) {
      out.push('<div class="po">' + lines.slice(i, i + 4).map(l => l.trim()).join('<br>') + '</div>');
      i += 4;
      continue;
    }
    if (/^[\s]{0,2}[-*]\s+/.test(raw)) {
      const items = [];
      while (i < lines.length && /^[\s]{0,2}[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[\s]{0,2}[-*]\s+/, '')); i++; }
      out.push('<ul class="in-list">' + items.map(it => '<li>' + RT.processInlineBold(it) + '</li>').join('') + '</ul>');
      continue;
    }
    const para = [];
    while (i < lines.length) {
      const r = lines[i];
      if (r.trim() === '' || /^[\s]{0,2}[-*]\s+/.test(r) || /^###\s+/.test(r.trim()) || /^-{3,}$/.test(r.trim()) || r.trim().startsWith('<!--TABLE:') || r.includes('<!--NOPUB-->')) break;
      if (!r.includes('<!--NOPUB-->')) para.push(r);
      i++;
    }
    if (para.length) out.push('<p class="in">' + RT.processInlineBold(para.join('\n').trim()) + '</p>');
    i++;
  }
  return out.join('\n');
}

// 判决文本（C1_04_JUDGMENT）：从 DATA 组装胜负宣告；无 DATA → null（保持 prose 填充）
function verdictText(data) {
  const pro = data && data['S15.正方得分'];
  const con = data && data['S15.反方得分'];
  if (pro === undefined || con === undefined) return null;
  const winner = pro > con ? '正方' : con > pro ? '反方' : null;
  if (!winner) return '<p class="wn">双方比分持平</p>';
  return '<p class="wn">' + winner + '胜（' + pro + ':' + con + '）</p>';
}

// depth.clash：截断模块表格 tbody 至 N 行（简明=3/标准=8/详细=全部）
function truncateTableRows(html, maxRows) {
  if (!maxRows) return html;
  return html.replace(/(<table class="tb">[\s\S]*?<tbody>)([\s\S]*?)(<\/tbody>)/g, (m, pre, body, post) => {
    const rows = body.match(/<tr>/g) || [];
    if (rows.length <= maxRows) return m;
    const parts = body.split(/(?=<tr>)/);
    return pre + parts.slice(0, maxRows).join('') + post;
  });
}

// C1 子块装配（R5 合同 §R5-C1：诗评→POEM / XP→XP / 一句话理由→REASON / 六向度表→HEXAD / 判准ABCD表→JUDGMENT）
// 实际 R5 叙事存在"标记-内容错位"（内容落在前一槽/后一槽），这里按表元数据（名称=六向度/判准）确定性路由，
// 判决行按 prose 优先、DATA 兜底生成一次，杜绝重复 .wn；诗评从 pre/POEM 槽取头部四短行。
function assembleC1Blocks(mod, data, opts) {
  opts = opts || {};
  const slot = k => (mod.slots && mod.slots[k]) || '';
  const raw = String(mod.raw || '');
  // 1) 诗评：pre 优先，其次 POEM 槽；取头部连续 2-4 个匹配行（每行 ≤25 字、无标记/无 markdown 前缀）
  //    R5 合同为四句，但实际输出存在"两行、每行两句"的变体（如 judge-260730），legacy R6b 以 .po 分行渲染。
  const poemSource = (mod.pre || slot('INSERT_C1_01_POEM') || raw).replace(/\r/g, '');
  const plines = poemSource.split('\n').map(l => l.trim());
  let poem = '';
  const run = [];
  for (const l of plines) {
    if (!l || l.startsWith('<!--') || /^[#|*\-\s]/.test(l) || l.length > 25) break;
    run.push(l);
  }
  if (run.length >= 2 && run.length <= 4) {
    poem = '<div class="po">' + run.join('<br>') + '</div>';
  }
  const poemRun = run.slice();
  // 2) 判决行：prose 加粗行优先（含队名），DATA 兜底；只生成一次
  let verdict = '';
  const verdictSource = slot('INSERT_C1_01_POEM') + '\n' + slot('INSERT_C1_02_REASON');
  let vline = '';
  for (const l of verdictSource.replace(/\r/g, '').split('\n')) {
    const t = l.trim();
    if (/^\*\*(正|反)方/.test(t) && t.includes('胜（')) { vline = t; break; }
  }
  if (vline) verdict = '<p class="wn">' + vline.replace(/\*\*/g, '') + '</p>';
  else {
    const vt = verdictText(data);
    if (vt) verdict = vt;
  }
  // 3) 一句话理由：REASON 槽去除判决行与 TABLE 块后裹文
  let reasonSource = slot('INSERT_C1_02_REASON').replace(/\r/g, '');
  // B2：无 REASON 槽时从 raw 路由（去掉判决行、TABLE 块、已用作诗评的行）
  if (!reasonSource.trim() && raw) {
    reasonSource = raw;
    for (const l of poemRun) {
      const idx = reasonSource.split('\n').findIndex(x => x.trim() === l);
      if (idx >= 0) {
        const arr = reasonSource.split('\n');
        arr.splice(idx, 1);
        reasonSource = arr.join('\n');
      }
    }
  }
  if (vline && reasonSource.includes(vline)) reasonSource = reasonSource.replace(vline, '');
  // 兜底路径（无 vline）时，raw 中的粗体判决行也会被 wrapProse 转成 .wn → 先剥离，避免与 DATA 判决重复
  reasonSource = reasonSource.replace(/\*{0,2}(正|反)方\s*(?:（[^）]*）)?\s*胜\s*（\s*\d+\s*:\s*\d+\s*）\s*\*{0,2}/g, '');
  reasonSource = reasonSource.replace(/<!--TABLE:[\s\S]*?<!--\/TABLE-->/g, '').trim();
  const reason = wrapProse(reasonSource, { effectiveType: opts.effectiveType });
  // 4) 六向度表 / 判准ABCD表：按 TABLE 元数据从全部 C1 槽中路由（兼容错位叙事）
  let hexad = '', judgment = '';
  const allC1 = Object.keys(mod.slots || {}).map(k => mod.slots[k]).join('\n\n');
  const tbRe = /<!--TABLE:([^>]+)-->\s*([\s\S]*?)<!--\/TABLE-->/g;
  let m;
  while ((m = tbRe.exec(allC1)) !== null) {
    const attrs = m[1].trim();
    const tb = RT.renderTable({ attrs, body: m[2].trim() });
    if (!hexad && attrs.includes('六向度')) hexad = tb.html;
    else if (!judgment && attrs.includes('判准')) judgment = tb.html;
  }
  // B2/M7：槽内无表时从 raw 路由（关键词集合扩展：六向度/维度/六维；判准/判准要素/ABCD）
  if (!hexad && raw) {
    const blocks = extractTableBlocks(raw);
    for (const b of blocks) {
      if (hexad) break;
      if (/六向度|维度|六维/.test(b.attrs)) {
        const tb = RT.renderTable({ attrs: b.attrs, body: b.body.trim() });
        hexad = tb.html;
      }
    }
    if (!hexad) {
      const mdTb = raw.match(/(^\|[^\n]*\n\|[\s:|-]+\|[\s\S]*?)(?=\n\n|\n###|\n\*\*|\n<!--|$)/gm);
      for (const block of mdTb || []) {
        const head = block.split('\n')[0];
        if (head.includes('向度')) {
          const tb = RT.renderTable({ attrs: '列=', body: block.trim() });
          hexad = tb.html;
          break;
        }
      }
    }
  }
  if (!judgment && raw) {
    const blocks = extractTableBlocks(raw);
    for (const b of blocks) {
      if (judgment) break;
      if (/判准|ABCD/.test(b.attrs)) {
        const tb = RT.renderTable({ attrs: b.attrs, body: b.body.trim() });
        judgment = tb.html;
      }
    }
    if (!judgment) {
      const mdTb = raw.match(/(^\|[^\n]*\n\|[\s:|-]+\|[\s\S]*?)(?=\n\n|\n###|\n\*\*|\n<!--|$)/gm);
      for (const block of mdTb || []) {
        const head = block.split('\n')[0];
        if (head.includes('判准')) {
          const tb = RT.renderTable({ attrs: '列=', body: block.trim() });
          judgment = tb.html;
          break;
        }
      }
    }
  }
  if (!hexad && slot('INSERT_C1_03_HEXAD')) hexad = wrapProse(slot('INSERT_C1_03_HEXAD'), { effectiveType: opts.effectiveType });
  if (!judgment && slot('INSERT_C1_04_JUDGMENT')) judgment = wrapProse(slot('INSERT_C1_04_JUDGMENT'), { effectiveType: opts.effectiveType });
  // 5) 深度档：简明 → 省略判准四要素（C1_04_JUDGMENT）
  if (opts.depth && opts.depth.verdict === '简明') judgment = '';
  return { poem, verdict, reason, hexad, judgment };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const R8_READER_GUIDE_CSS_START = '/* R8_READER_GUIDE_CSS_START */';
const R8_READER_GUIDE_CSS_END = '/* R8_READER_GUIDE_CSS_END */';
const R8_REPORT_GUIDE_SLOT = '<!--R8_REPORT_GUIDE_SLOT-->'; // 仅用于迁移旧集中式 R8-M1 报告
const R8_REPORT_GUIDE_START = '<!--R8_REPORT_GUIDE_START-->'; // 旧集中式标记，仅兼容剥离
const R8_REPORT_GUIDE_END = '<!--R8_REPORT_GUIDE_END-->'; // 旧集中式标记，仅兼容剥离
const R8_REPORT_GUIDE_STYLE_START = '/* R8_REPORT_GUIDE_STYLE_START */';
const R8_REPORT_GUIDE_STYLE_END = '/* R8_REPORT_GUIDE_STYLE_END */';
const R8_SECTION_IDS = Array.from({ length: 12 }, (_, i) => 'C' + (i + 1));

// R8 样式是独立导览产物的 implementation 细节；常规报告 interface 永不携带它。
function reportCss(css) {
  const start = String(css).indexOf(R8_READER_GUIDE_CSS_START);
  if (start < 0) return String(css);
  const end = String(css).indexOf(R8_READER_GUIDE_CSS_END, start);
  if (end < 0) throw new Error('R8 reader-guide CSS 结束标记缺失');
  const before = String(css).slice(0, start).replace(/\s+$/, '');
  const after = String(css).slice(end + R8_READER_GUIDE_CSS_END.length).replace(/^\s+/, '');
  return before + (after ? '\n' + after : '\n');
}

function readerGuideCss(css) {
  const start = String(css).indexOf(R8_READER_GUIDE_CSS_START);
  if (start < 0) throw new Error('R8 reader-guide CSS 起始标记缺失');
  const end = String(css).indexOf(R8_READER_GUIDE_CSS_END, start);
  if (end < 0) throw new Error('R8 reader-guide CSS 结束标记缺失');
  return String(css).slice(start, end + R8_READER_GUIDE_CSS_END.length);
}

function renderReaderGuideCards(guide, headingTag) {
  if (!guide || !Array.isArray(guide.cards)) throw new Error('R8 渲染需要已验收的 reader-guide');
  const tag = headingTag || 'h2';
  if (!/^h[1-6]$/.test(tag)) throw new Error('R8 卡片标题级别不合法');
  return guide.cards.map(card => {
    return '<article class="reader-guide-card" id="reader-guide-' + escapeHtml(card.sectionId) + '">' +
      '<' + tag + '>' + escapeHtml(card.sectionId) + ' 章节导览</' + tag + '>' +
      '<dl><dt>本章说什么</dt><dd>' + escapeHtml(card.what) + '</dd>' +
      '<dt>为什么重要</dt><dd>' + escapeHtml(card.why) + '</dd>' +
      '<dt>一句话结论</dt><dd>' + escapeHtml(card.conclusion) + '</dd></dl></article>';
  }).join('\n');
}

function countExact(text, token) {
  return String(text).split(token).length - 1;
}

function embeddedGuideStart(sectionId) {
  return '<!--R8_REPORT_GUIDE_START:' + sectionId + '-->';
}

function embeddedGuideEnd(sectionId) {
  return '<!--R8_REPORT_GUIDE_END:' + sectionId + '-->';
}

function renderEmbeddedReaderGuideCard(card, plainCard) {
  const sectionId = escapeHtml(card.sectionId);
  const plain = plainCard || card;
  const dual = (field) => '<dd data-orig="' + escapeHtml(card[field]) + '" data-plain="' + escapeHtml(plain[field]) + '">' + escapeHtml(card[field]) + '</dd>';
  return embeddedGuideStart(card.sectionId) +
    '<details class="reader-guide-card reader-guide-card-embedded" id="reader-guide-' + sectionId + '">' +
    '<summary>章节导览</summary>' +
    '<dl style="margin-top:12px"><dt>本章说什么</dt>' + dual('what') +
    '<dt>为什么重要</dt>' + dual('why') +
    '<dt>一句话结论</dt>' + dual('conclusion') + '</dl></details>' +
    embeddedGuideEnd(card.sectionId);
}

function stripEmbeddedReaderGuide(html) {
  let output = String(html);
  const legacyStarts = countExact(output, R8_REPORT_GUIDE_START);
  const legacyEnds = countExact(output, R8_REPORT_GUIDE_END);
  const currentStarts = Array.from(output.matchAll(/<!--R8_REPORT_GUIDE_START:(C(?:[1-9]|1[0-2]))-->/g)).map(m => m[1]);
  const currentEnds = Array.from(output.matchAll(/<!--R8_REPORT_GUIDE_END:(C(?:[1-9]|1[0-2]))-->/g)).map(m => m[1]);
  const styleStarts = countExact(output, R8_REPORT_GUIDE_STYLE_START);
  const styleEnds = countExact(output, R8_REPORT_GUIDE_STYLE_END);
  const hasLegacy = legacyStarts || legacyEnds;
  const hasCurrent = currentStarts.length || currentEnds.length;
  if (legacyStarts !== legacyEnds || legacyStarts > 1 || (hasLegacy && hasCurrent)) {
    throw new Error('R8 主报告旧导览标记不成对或与分章导览混用');
  }
  if (hasCurrent) {
    const expected = R8_SECTION_IDS.join('|');
    const starts = Array.from(new Set(currentStarts)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const ends = Array.from(new Set(currentEnds)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    if (currentStarts.length !== 12 || currentEnds.length !== 12 || starts.join('|') !== expected || ends.join('|') !== expected) {
      throw new Error('R8 主报告分章导览必须恰为 C1—C12 且标记成对');
    }
  }
  const embedded = !!(hasLegacy || hasCurrent);
  if (styleStarts !== styleEnds || styleStarts > 1 || (embedded ? styleStarts !== 1 : styleStarts !== 0)) {
    throw new Error('R8 主报告导览样式标记与导览区块不一致');
  }
  if (!embedded) return { html: output, embedded: false };
  if (hasLegacy) {
    output = output.replace(/<!--R8_REPORT_GUIDE_START-->[\s\S]*?<!--R8_REPORT_GUIDE_END-->/, R8_REPORT_GUIDE_SLOT);
    output = output.replace(/\n[ \t]*<!--R8_REPORT_GUIDE_SLOT-->[ \t]*\n/, '\n');
    output = output.replace(R8_REPORT_GUIDE_SLOT, '');
  } else {
    output = output.replace(/<!--R8_REPORT_GUIDE_START:(C(?:[1-9]|1[0-2]))-->[\s\S]*?<!--R8_REPORT_GUIDE_END:\1-->/g, '');
  }
  output = output.replace(/<style>\s*\/\* R8_REPORT_GUIDE_STYLE_START \*\/[\s\S]*?\/\* R8_REPORT_GUIDE_STYLE_END \*\/\s*<\/style>/, '');
  return { html: output, embedded: true };
}

function insertEmbeddedReaderGuideCard(html, card, plainCard) {
  const sectionId = String(card.sectionId || '');
  if (!R8_SECTION_IDS.includes(sectionId)) throw new Error('R8 导览出现非法章节: ' + sectionId);
  const domId = sectionId.toLowerCase();
  const re = new RegExp('(<div\\b[^>]*\\bid="' + domId + '"[^>]*>\\s*<h2\\b[^>]*>[\\s\\S]*?<\\/h2>)', 'g');
  const matches = html.match(re) || [];
  if (matches.length !== 1) throw new Error('R8 主报告缺少唯一章节宿主: ' + sectionId);
  return html.replace(re, match => match + renderEmbeddedReaderGuideCard(card, plainCard));
}

// 纯渲染 seam：只接受已验收 guide / plainGuide 与普通报告 HTML；不读模型、提示、裁决输入或文件系统。
function embedReaderGuideIntoReport(html, guide, plainGuide) {
  if (!guide || !Array.isArray(guide.cards)) throw new Error('R8 渲染需要已验收的 reader-guide');
  const byId = new Map(guide.cards.map(card => [card.sectionId, card]));
  if (guide.cards.length !== 12 || byId.size !== 12 || !R8_SECTION_IDS.every(id => byId.has(id))) {
    throw new Error('R8 主报告导览必须恰含 C1—C12 十二张卡');
  }
  const plainCards = plainGuide && Array.isArray(plainGuide.cards) ? plainGuide.cards : [];
  const plainById = new Map(plainCards.map(card => [card.sectionId, card]));
  if (plainGuide && (plainCards.length !== 12 || plainById.size !== 12 || !R8_SECTION_IDS.every(id => plainById.has(id)))) {
    throw new Error('R8 主报告白话导览必须恰含 C1—C12 十二张卡');
  }
  const stripped = stripEmbeddedReaderGuide(html);
  let base = stripped.html;
  base = base.replace(/\n[ \t]*<!--R8_REPORT_GUIDE_SLOT-->[ \t]*\n/, '\n').replace(R8_REPORT_GUIDE_SLOT, '');
  if (countExact(base, '</head>') !== 1) throw new Error('R8 主报告 head 不唯一');
  const style = '<style>' + R8_REPORT_GUIDE_STYLE_START + '\n' + readerGuideCss(readAssetText('report.css')) + '\n' + R8_REPORT_GUIDE_STYLE_END + '</style>';
  let output = base.replace('</head>', style + '</head>');
  for (const sectionId of R8_SECTION_IDS) output = insertEmbeddedReaderGuideCard(output, byId.get(sectionId), plainById.get(sectionId));
  return output;
}

// R8：独立导览页与主报告内嵌卡共用同一纯卡片渲染函数。
function renderReaderGuide(guide) {
  const css = readAssetText('report.css');
  const cards = renderReaderGuideCards(guide, 'h2');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>读者章节导览</title><style>' + css + '</style></head><body><main class="reader-guide"><header><h1>读者章节导览</h1><p>独立 R8 产物；逐章梳理既有 R6 与结构化裁决。</p></header>' + cards + '</main></body></html>';
}

// 批 2（260812）：C8 叙事人格渲染补全——P2.5 数据层齐备但此前无消费位点
// （CONSUMER_MAP 曾声明 renderC3Panel 消费为假声明，本函数为真实消费点；接入锚点 = 修辞格局总评前骨架位）
function renderC8Persona(data) {
  const pro = data['C8.叙事人格.正方'];
  const con = data['C8.叙事人格.反方'];
  const win = data['C8.人格胜负'];
  if (!pro && !con && !win) return '';
  const rows = [];
  for (const [side, raw] of [['正方', pro], ['反方', con]]) {
    if (!raw) continue;
    const parts = String(raw).split('|');
    const tag = (parts[0] || '').trim();
    const desc = (parts[1] || '').trim();
    if (!tag && !desc) continue;
    rows.push('<tr><td>' + side + '</td><td><strong>' + escapeHtml(tag) + '</strong>' + (desc ? '<br>' + escapeHtml(desc) : '') + '</td></tr>');
  }
  const winRow = win
    ? '<tr><td>人格胜负</td><td><strong>' + escapeHtml(String(win).split('|')[0]) + '</strong></td></tr>' : '';
  return '<div id="c8-persona"><h3 style="font-size:1.05em;color:var(--text);margin:16px 0 8px 0">叙事人格</h3>' +
    '<table class="tb"><thead><tr><th>方</th><th>姿态标签与解读</th></tr></thead><tbody>' +
    rows.join('') + winRow + '</tbody></table></div>';
}

// B6：执行骨架 data-condition（当前仅 def=是 → S4.定义争议触发）。条件不满足 → 整个容器（含嵌套 div）移除
function removeDataConditionBlocks(html, data) {
  const re = /<div\s+data-condition="([^"]+)">/g;
  let m, out = '', last = 0;
  while ((m = re.exec(html)) !== null) {
    const cond = m[1];
    const eq = cond.indexOf('=');
    const key = eq >= 0 ? cond.slice(0, eq) : cond;
    const val = eq >= 0 ? cond.slice(eq + 1) : '';
    const dataKey = key === 'def' ? 'S4.定义争议触发' : key;
    out += html.slice(last, m.index);
    let depth = 1, i = m.index + m[0].length;
    while (i < html.length && depth > 0) {
      if (/^<div(?:\s|>)/.test(html.slice(i))) { depth++; i++; }
      else if (html.startsWith('</div>', i)) {
        depth--;
        i += 6; // '</div>'
        if (depth === 0) break;
      } else i++;
    }
    const block = html.slice(m.index, Math.min(i, html.length));
    if (String(data[dataKey]) === String(val)) out += block;
    else out += '<!--WARNING: 条件块未满足已移除（' + dataKey + '≠' + val + '）-->';
    last = i;
  }
  return out + html.slice(last);
}

// B3/M2：同模块内重复 h3 去重（保留首个）。模块 div 是兄弟节点，用前瞻切分。
function dedupeModuleH3(html) {
  return html.replace(/(<div class="sk[^"]* c-module c\d+"[^>]*>)([\s\S]*?)(?=<div class="sk[^"]* c-module c\d+"[^>]*>|$)/g, (m, open, body) => {
    const seen = new Set();
    const newBody = body.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, (hm, text) => {
      const key = text.replace(/<[^>]+>/g, '').trim();
      if (seen.has(key)) return '';
      seen.add(key);
      return hm;
    });
    return open + newBody;
  });
}

function renderHTML(normalized, opts) {
  opts = opts || {};
  // M-ID 契约：structure 入口幂等归一（覆盖 CLI 直读 JSON.parse 与 pipeline 传入两条路径）
  if (opts.structure && typeof opts.structure === 'object') {
    opts.structure = contract.normalizeStructureIds(opts.structure);
  }
  let html = readAssetText('skeleton.html');
  const css = reportCss(readAssetText('report.css'));
  const data = normalized.data || {};
  const effType = opts.effectiveType || data['S11.类型'] || '0';
  if (normalized.warnings && normalized.warnings.length)
    console.warn('[normalize] 渲染输入警告: ' + normalized.warnings.join('; '));

  // 1) CSS 注入
  html = html.replace(/<style>[\s\S]*?<\/style>/, '<style>' + css + '</style>');
  // A6/标题修复：<title> 占位 [辩题] 用 S1.辩题 替换（旧数据无 S1.辩题 → 明确标注，不再残留占位）
  html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>辩论裁判报告 · ' + escapeHtml(data['S1.辩题'] || '（辩题未提供）') + '</title>');
  // 260805 页头/目录填充：辩题 + 场次（场次从 transition-final 首段解析，带兜底）
  const titleMd = normalized.rawTransition || '';
  const occM = titleMd.match(/本场比赛为([^，。]+)[，。]/);
  const proM = titleMd.match(/正方为([^（(]+)（/);
  const conM = titleMd.match(/反方为([^（(]+)（/);
  let occLine = '';
  if (occM) {
    occLine = occM[1].trim();
    if (proM) occLine += ' · 正方' + proM[1].trim();
    if (conM) occLine += ' vs 反方' + conM[1].trim();
  }
  html = html.replace(/【辩题】/g, escapeHtml(data['S1.辩题'] || '（辩题未提供）'));
  html = html.replace(/【场次】/g, escapeHtml(occLine || '（场次信息未提供）'));
  // 源锚层 v1（E-2/G-1）：免责横幅注入——disclaimer=true（类型 A/B 确认继续）时报告顶部注入，
  // 文案单一事实源 = html-contract.js DISCLAIMER_TEXT；白话层对含该文案单元标记 fixed 不送译
  if (opts.disclaimer === true) {
    var banner = '<div class="disclaimer-banner" data-fixed-text="1">⚠️ ' + HC3.DISCLAIMER_TEXT + '</div>';
    html = html.replace(/<body[^>]*>/, function(m) { return m + banner; });
  }
  // A8-ERR-1：前端交互脚本注入（主题切换 + API 配置面板功能）
  html = html.replace(/<script>\s*\/\* toggleTheme \*\/\s*<\/script>/, '<script>' + frontendJs() + '</script>');
  // B6：data-condition 条件块执行（S4.定义争议触发 != 是 → 移除 C4 审查块，含其内部占位）
  html = removeDataConditionBlocks(html, data);

  // A7-B2：C2 类型徽章 + SC 追迹面板（数据驱动；SC 面板硬门禁仅 2b）
  html = html.replace(/<!--\s*R6a预建:\s*类型徽章[\s\S]*?-->/g, c2BadgeHTML(effType));
  const c7Raw = Object.values((normalized.modules.C7 && normalized.modules.C7.slots) || {}).join('\n\n')
    + '\n\n' + (normalized.modules.C7 && normalized.modules.C7.prose || '');
  html = html.replace(/<!--\s*R6a预建:\s*SC追迹面板[\s\S]*?-->/g, c2ScPanelHTML(data, opts.structure, c7Raw));

  // A7-B2：O4/O5 CSS 进度条（C10 内容感 / C7 SC 三阶段）
  html = html.replace(/<!--O4_CONTENT_PROGRESS-->/g, o4ContentProgress(data));
  html = html.replace(/<!--O5_SC_PROGRESS-->/g, o5ScProgress(data));

  // 2) 每模块：XP 替换 + INSERT 槽位填充（按叙事内 INSERT 块边界拆分后的 slotText）
  for (const [id, mod] of Object.entries(normalized.modules || {})) {
    const c1 = id === 'C1' ? assembleC1Blocks(mod, normalized.data, opts) : null;
    const xpRe = new RegExp('<!--INSERT_' + id + '_XP-->', 'g');
    html = html.replace(xpRe, mod.xp ? mod.xp : ''); // 骨架已提供 <p class="xp"> 外层，只填内容（防嵌套 p）
    const proseRe = new RegExp('<!--INSERT_' + id + '_([A-Z0-9_]+)-->', 'g');
    html = html.replace(proseRe, (m, slot) => {
      const full = id + '_' + slot;
      if (slot === 'XP') return m; // 已处理
      if (slot.startsWith('CHART')) return '<!--CHART_STUB:' + full + '-->'; // C4 填充
      if (id === 'C1' && c1) {
        // C1 子块按装配结果填充（顺序由骨架决定：诗评→XP→判决+理由→雷达→六向度→判准）
        if (slot === '01_POEM') return c1.poem;
        if (slot === '02_REASON') return c1.verdict + (c1.reason ? '\n' + c1.reason : '');
        if (slot === '03_HEXAD') return c1.hexad;
        if (slot === '04_JUDGMENT') return c1.judgment;
      }
      let slotText = (mod.slots && mod.slots['INSERT_' + full]);
      if (!slotText) return '<!--WARNING: 槽位缺失 ' + full + '（B1 兜底：留空）-->'; // 260806 B1：缺失槽位→留空+警告，不再整章 prose 塞第一个槽
      // 260805 C12：推理链拆成“链式一行 + 文字解说”（沿 XX→XX…的路径 提取）
      if (id === 'C12' && slot === '11_CHAIN') {
        const cm = slotText.match(/沿(.+?)的路径/);
        if (cm) {
          const chain = cm[1].split('→').map(s => s.trim()).join(' → ');
          const rest = String(slotText).replace(/^推理链·\s*/, '').replace(/沿.+?的路径：?/, '');
          const chainLine = '<div style="text-align:center;font-weight:600;font-size:1.05em;color:var(--blue);margin:10px 0 8px 0">' + chain + '</div>';
          return chainLine + wrapProse(rest.trim(), { effectiveType: opts.effectiveType });
        }
      }
      // C12 成长建议：正文禁止重复“成长建议”标题（骨架已渲染 h3）
      if (id === 'C12' && slot === '14_GROWTH') slotText = stripSlotHeadingDup(slotText, '成长建议');
      // C4 Toulmin 卡片：正文禁止重复卡片标题（标题由骨架渲染）
      if (id === 'C4') {
        const c4Title = { C1_FIELD_A: '场A·场内碰撞', C2_FIELD_B: '场B·场选择', C3_FIELD_C: '场C·元场', C4_DIAGNOSIS: '综合诊断' }[slot];
        if (c4Title) slotText = stripSlotHeadingDup(slotText, c4Title);
      }
      let wrapped = wrapProse(slotText, { effectiveType: opts.effectiveType });
      if (id === 'C6' && opts.depth && opts.depth.clash) {
        const maxRows = opts.depth.clash === '仅关键2-3个' ? 3 : opts.depth.clash === '标准5-8个' ? 8 : 0;
        wrapped = truncateTableRows(wrapped, maxRows);
      }
      return wrapped;
    });
  }
  // B3/M2：同模块内重复 h3 去重（保留首个；骨架新增 C11 h3 后，模型自带的 ### 不再重复）
  html = dedupeModuleH3(html);

  // 3) C3 面板桩位（C5 填充：renderC3Panel）
  if (opts.structure) {
    const c3Mode = (opts.depth && opts.depth.mainline === '简述类型') ? 'summary'
      : (opts.depth && opts.depth.mainline === '逐环节追踪') ? 'detail' : 'standard';
    const panel = renderC3Panel(opts.structure, opts.effectiveType, {
      nodeLabels: opts.nodeLabels,
      degrade: opts.degrade,
      data: normalized.data,
      narrative: (normalized.modules.C3 && normalized.modules.C3.prose || '').slice(0, 60),
      aggregationUnits: opts.aggregationUnits,
      sideOf: opts.sideOf,
      c3Mode
    });
    // 批甲 RR-1（F6 扩展）：R4.5 裁决标注——全部已裁决 right/left 维度（X=裁决侧「=」后值；ADJ-14 已保证 pair=登记表 pair）
    const adjNote = (() => {
      const adj = opts.adjudication;
      if (!adj || !Array.isArray(adj.conflicts)) return '';
      const notes = adj.conflicts
        .filter(c => c.adjudicated === 'left' || c.adjudicated === 'right')
        .map(c => {
          const side = (c.pair || [])[(c.adjudicated === 'right') ? 1 : 0] || '';
          return { dim: c.dimension, x: String(side).split('=')[1] || '' };
        });
      if (!notes.length) return '';
      return '<div class="adj-note">经 R4.5 裁决，本节以「' + notes[0].x + '」为准（' + notes[0].dim + '）</div>';
    })();
    html = html.replace(/<!--\s*R6a-5生成的C3全景图[\s\S]*?-->/g, panel + adjNote);
  } else {
    html = html.replace(/<!--\s*R6a-5生成的C3全景图[\s\S]*?-->/g, '<!--C3_PANEL_STUB-->');
  }

  // 5) C4a 图表注入（C4b 的 C8/C9 桩位保留；A7-B3：S2 现场解析需要 rawTransition）
  const s2Raw = normalized.rawTransition || '';
  const cd = buildChartData(normalized.chartsData || {}, s2Raw);
  const c5Raw = Object.values((normalized.modules.C5 && normalized.modules.C5.slots) || {}).join('\n\n');
  // A7-B3/问题12：箭头评估表存在但解析为空 → WARNING（表缺失的降级场景不报）
  const parsedArrow = parseArrowAssessment(c5Raw);
  // 260805 口径统一：S2 矩阵优先（机械解析）→ 箭头状态/论证完成度与柱状图同源；无 S2 矩阵时回退 R5 评估表
  const s2Parsed = parseArrowStatusFromS2(s2Raw);
  const matrixEntries = s2Parsed.rows.length ? matrixEntriesFromRows(s2Parsed.rows) : parsedArrow;
  const arrowMatrix = injectChart(arrowMatrixSVG(matrixEntries), 'matrix');
  const arrowWarning = /<!--TABLE:[^>]*箭头论证评估表/.test(c5Raw) && parsedArrow.length === 0
    ? '<!--WARNING: 箭头论证评估表解析失败-->' : '';
  html = html.replace(/<!--CHART_STUB:C1_CHART_RADAR-->/g, injectChart(radarSVG(cd.radar), 'radar'));
  // A7-B3/E-10 完整解：S2 箭头计数可用 → 双柱状图（A→B0 / B0→C）；否则汇总图 + 矩阵图
  // 260805：柱状图标题简化为箭头名；图下按正反方列各分论点论证内容与完成明细（S2 分论点链×矩阵配对）
  const arrowDetail = s2Parsed.rows.length ? s2ArrowDetails(s2Parsed.rows, s2Raw) : null;
  const bars = cd.arrowCounts
    ? injectChart(barSVG(cd.arrowCounts.A_B0, 'A→B0', arrowDetail && arrowDetail.A_B0), 'bar') + '\n' + injectChart(barSVG(cd.arrowCounts.B0_C, 'B0→C', arrowDetail && arrowDetail.B0_C), 'bar')
    : injectChart(barSVG(cd.bar), 'bar');
  const c5Note = ''; // 260806：判定/统计口径说明不再上屏（内部口径仅实现层注释，禁止加回）
  // 260805：矩阵标题与柱状图标题同款样式（HTML div），与上方内容保持间距
  const matrixTitle = '<div style="text-align:center;font-weight:bold;font-size:1.05em;margin:20px 0 4px 0">论证完成度</div>';
  html = html.replace(/<!--CHART_STUB:C5_CHART_BAR-->/g, bars + (c5Note ? '\n' + c5Note : '') + (arrowMatrix ? '\n' + matrixTitle + arrowMatrix : '') + (arrowWarning ? '\n' + arrowWarning : ''));
  html = html.replace(/<!--CHART_STUB:C6_CHART_DONUT-->/g, injectChart(donutSVG(cd.donut), 'donut'));
  html = html.replace(/<!--CHART_STUB:C7_CHART_SC-->/g, injectChart(scBarSVG(cd.sc), 'scBar'));
  html = html.replace(/<!--CHART_STUB:C8_CHART_1-->/g, injectChart(c8Chart1(cd.c8), 'c8Chart1'));
  html = html.replace(/<!--CHART_STUB:C8_CHART_2-->/g, injectChart(c8Chart2(cd.c8), 'c8Chart2'));
  html = html.replace(/<!--CHART_STUB:C8_CHART_3-->/g, injectChart(c8Chart3(cd.c8), 'c8Chart3'));
  html = html.replace(/<!--CHART_STUB:C9_CHART_ZHENGMING-->/g, injectChart(c9GaugeSVG('ZHENGMING', cd.c9), 'c9'));
  html = html.replace(/<!--CHART_STUB:C9_CHART_SHUOFU-->/g, injectChart(c9GaugeSVG('SHUOFU', cd.c9), 'c9'));
  html = html.replace(/<!--CHART_STUB:C9_CHART_DISAN-->/g, injectChart(c9GaugeSVG('DISAN', cd.c9), 'c9'));

  // 260805 C5 版式与数据一致性：
  // 1) 「箭头论证评估」解释块紧贴矩阵图下方（当前叙事顺序在论证完成度之后，渲染侧移动到矩阵后）；
  // 2) 「论证完成度」表由 S2 矩阵机械重算（口径=每分论点两箭头短板取劣），替换 R5 摘要表。
  const c5CompH3 = '<h3 style="font-size:1.05em;color:var(--text);margin:16px 0 8px 0">论证完成度</h3>';
  const c5ArrowH3 = '<h3 style="font-size:1.05em;color:var(--text);margin:16px 0 8px 0">箭头论证评估</h3>';
  const compIdx = html.indexOf(c5CompH3);
  if (compIdx >= 0) {
    const arrowIdx = html.indexOf(c5ArrowH3, compIdx);
    if (arrowIdx >= 0) {
      const c6Idx = html.indexOf('<div class="sk c-module c6"', arrowIdx);
      const c5Close = html.lastIndexOf('</div>', c6Idx);
      if (c5Close > arrowIdx) {
        const block = html.slice(arrowIdx, c5Close);
        html = html.replace(block, '');
        const newCompIdx = html.indexOf(c5CompH3);
        if (newCompIdx >= 0) html = html.slice(0, newCompIdx) + block + html.slice(newCompIdx);
      }
    }
    if (s2Parsed.rows.length) {
      const comp = completionCountsFromRows(s2Parsed.rows);
      const rowsHtml = '<tbody>'
        + '<tr><td>正方</td><td>' + comp.pro[0] + '</td><td>' + comp.pro[1] + '</td><td>' + comp.pro[2] + '</td><td>' + comp.pro[3] + '</td></tr>'
        + '<tr><td>反方</td><td>' + comp.con[0] + '</td><td>' + comp.con[1] + '</td><td>' + comp.con[2] + '</td><td>' + comp.con[3] + '</td></tr>'
        + '</tbody>';
      const compRe = /(<h3 style="font-size:1.05em;color:var\(--text\);margin:16px 0 8px 0">论证完成度<\/h3>\s*<table class="tb">\s*<thead>[\s\S]*?<\/thead>\s*)<tbody>[\s\S]*?<\/tbody>/;
      html = html.replace(compRe, (m, pre) => pre + rowsHtml);
    }
  }

  // 260806 P1-1/P1-2：C5 渲染 UI 落地——箭头级状态表/整链结论/支撑明细单环（数据先启发式+测试推导标注；真字段见段 1B）
  const c5ui = buildC5V2Ui(s2Parsed.rows, s2Raw);
  if (c5ui) {
    const c5EndIdx = html.indexOf('<div class="sk c-module c6"');
    const c5CloseIdx = c5EndIdx > 0 ? html.lastIndexOf('</div>', c5EndIdx) : -1;
    if (c5CloseIdx > 0) html = html.slice(0, c5CloseIdx) + c5ui + html.slice(c5CloseIdx);
  }

  // 批 2（260812）：C8 叙事人格机械表——锚点 = 修辞格局总评（insight-box）之前骨架位。
  // 禁止插入任何 INSERT 槽内部：此处已在 L1934 槽位填充之后，锚点为骨架固定容器（skeleton.html C8 段）。
  const c8PersonaHtml = renderC8Persona(data);
  if (c8PersonaHtml) {
    const c8Anchor = '<div class="insight-box"><h4>📊 修辞格局总评';
    const c8Idx = html.indexOf(c8Anchor);
    if (c8Idx > 0) html = html.slice(0, c8Idx) + c8PersonaHtml + html.slice(c8Idx);
  }

  // 260805：术语统一（SC→结构性交锋，读者可见层）+ 清理空段落
  html = applyC5UiTransforms(html); // 260806 P1-1：架构对比表横置 + 文案（架构自证/架构交集/矛盾联系）
  html = applyVisibleTerminology(html); // 260807：规则级可见文本 SC→结构性交锋（替代短语枚举）
  html = html.replace(/<p class="in">\s*<\/p>/g, '');
  // 思路分享标题统一归 C12(9)；清除 C12 之前（C1-C11）残留的同名 h3
  // （旧场次单标记格式会把 "### 辩题思路分享" 挂在选手表槽位末尾）
  const c12Pos = html.indexOf('<div class="sk c-module c12"');
  if (c12Pos > 0) html = html.slice(0, c12Pos).replace(/<h3[^>]*>辩题思路分享<\/h3>/g, '') + html.slice(c12Pos);

  // A7-B2/问题9：收尾清理非功能性 HTML 注释（保留 RADAR_DATA/WARNING 规则注释）
  html = html.replace(/<!--(?!RADAR_DATA:)(?!WARNING:)[\s\S]*?-->/g, '');
  // 注释清理后再清一次空段（注释占位的 <p class="in"></p> 在此刻才真正为空）
  html = html.replace(/<p class="in">\s*<\/p>/g, '');

  return html;
}

// ==================== G8 自检 ====================

function selfCheckG8(html, registry) {
  const errors = [];
  const warnings = [];
  const cMods = [];
  for (let i = 1; i <= 12; i++) if (new RegExp('class="sk[^"]* c-module c' + i + '\\b').test(html)) cMods.push('c' + i);
  if (cMods.length !== 12) errors.push('G8-1: C 模块 div 数量=' + cMods.length + '（缺 ' + [1,2,3,4,5,6,7,8,9,10,11,12].filter(x => !cMods.includes('c' + x)).join(',') + '）');
  if (!/<style>/.test(html)) errors.push('G8-2: <style> 缺失');
  const residue = (html.match(/<!--INSERT_[A-Z0-9_]+-->/g) || []).length;
  if (residue > 0) warnings.push('G8-3: INSERT 残留 ' + residue + ' 处（骨架阶段预期值，C4/C5/C6 填充后应为 0）');
  const stubs = (html.match(/<!--(CHART_STUB|C3_PANEL_STUB|VERDICT_TEXT_STUB):?[\s\S]*?-->/g) || []).length;
  if (stubs > 0) warnings.push('G8-4: 桩位 ' + stubs + ' 处（C4/C5/C6 待填充）');
  if (registry && Array.isArray(registry)) {
    const active = registry.filter(r => r.consumer !== 'deprecated');
    const present = active.filter(r => html.includes('<!--INSERT_' + r.name + '-->'));
    // 填充后不应有活跃 INSERT 残留
  }
  return { ok: errors.length === 0, errors, warnings, modules: cMods };
}

// ==================== 前端交互脚本（主题切换 + API 配置面板） ====================

// R7 阶段 2：原文/白话双版本切换（独立常量：frontendJs 与 injectPlainToggle 共用，避免重复定义）
const PLAIN_TOGGLE_SET_MODE_LEGACY = 'function setPlainMode(on,persist){var b=document.getElementById("plainBtn");if(!b)return false;if(on)document.body.classList.add("plain");else document.body.classList.remove("plain");if(persist)try{localStorage.setItem("judge_plain",on?"1":"0");}catch(e){}b.textContent=on?"原文":"白话";b.setAttribute("aria-pressed",on?"true":"false");var els=document.querySelectorAll("[data-plain]");for(var i=0;i<els.length;i++){var v=on?els[i].getAttribute("data-plain"):els[i].getAttribute("data-orig");if(v!==null)els[i].innerHTML=v;}return true;}';
const PLAIN_TOGGLE_SET_MODE_GUIDE_PRESERVE_V1 = 'function setPlainMode(on,persist){var b=document.getElementById("plainBtn");if(!b)return false;if(on)document.body.classList.add("plain");else document.body.classList.remove("plain");if(persist)try{localStorage.setItem("judge_plain",on?"1":"0");}catch(e){}b.textContent=on?"原文":"白话";b.setAttribute("aria-pressed",on?"true":"false");var els=document.querySelectorAll("[data-plain]");for(var i=0;i<els.length;i++){var g=els[i].querySelector?els[i].querySelector(".reader-guide-card-embedded"):null,gh=g?g.outerHTML:"",v=on?els[i].getAttribute("data-plain"):els[i].getAttribute("data-orig");if(v!==null){els[i].innerHTML=v;if(gh&&els[i].querySelector&&!els[i].querySelector(".reader-guide-card-embedded")){var h=els[i].querySelector("h2.st");if(h)h.insertAdjacentHTML("afterend",gh);}}}return true;}';
const PLAIN_TOGGLE_SET_MODE = 'function setPlainMode(on,persist){var b=document.getElementById("plainBtn");if(!b)return false;if(on)document.body.classList.add("plain");else document.body.classList.remove("plain");if(persist)try{localStorage.setItem("judge_plain",on?"1":"0");}catch(e){}b.textContent=on?"原文":"白话";b.setAttribute("aria-pressed",on?"true":"false");var els=document.querySelectorAll("[data-plain]");for(var i=0;i<els.length;i++){var g=els[i].querySelector?els[i].querySelector(".reader-guide-card-embedded"):null,gh=g?g.outerHTML:"",v=on?els[i].getAttribute("data-plain"):els[i].getAttribute("data-orig");if(v!==null){els[i].innerHTML=v;if(gh&&els[i].querySelector&&!els[i].querySelector(".reader-guide-card-embedded")){var h=els[i].querySelector("h2.st");if(h){h.insertAdjacentHTML("afterend",gh);var ng=els[i].querySelector(".reader-guide-card-embedded"),ge=ng?ng.querySelectorAll("[data-plain]"):[];for(var j=0;j<ge.length;j++){var gv=on?ge[j].getAttribute("data-plain"):ge[j].getAttribute("data-orig");if(gv!==null)ge[j].innerHTML=gv;}}}}}return true;}';
const PLAIN_TOGGLE_JS = [
  'function plainToggleIsEditable(el){for(var node=el;node&&node!==document.body;node=node.parentElement){var tag=String(node.tagName||"").toLowerCase(),editable=node.getAttribute&&node.getAttribute("contenteditable");if(tag==="input"||tag==="textarea"||tag==="select"||node.isContentEditable||(editable!==null&&editable!=="false"))return true;}return false;}',
  PLAIN_TOGGLE_SET_MODE,
  'function togglePlain(){return setPlainMode(!document.body.classList.contains("plain"),true);}',
  'document.addEventListener("keydown",function(e){if(!e.cancelable||!e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||e.repeat||String(e.key||"").toLowerCase()!=="t"||plainToggleIsEditable(e.target))return;if(togglePlain())e.preventDefault();});'
].join('');

// R8-M1 生产迁移 seam：只允许把已知旧版 plain-toggle runtime 精确升级到当前版；
// 当前版幂等，未知版本阻断，避免为 UI 修复模糊改写报告脚本或正文。
function migratePlainToggleRuntime(html) {
  const text = String(html || '');
  if (text.includes(PLAIN_TOGGLE_SET_MODE)) return text;
  if (text.includes(PLAIN_TOGGLE_SET_MODE_GUIDE_PRESERVE_V1)) return text.replace(PLAIN_TOGGLE_SET_MODE_GUIDE_PRESERVE_V1, PLAIN_TOGGLE_SET_MODE);
  if (text.includes(PLAIN_TOGGLE_SET_MODE_LEGACY)) return text.replace(PLAIN_TOGGLE_SET_MODE_LEGACY, PLAIN_TOGGLE_SET_MODE);
  throw new Error('R8 主报告 plain-toggle runtime 不属于可迁移版本');
}

const PLAIN_TOGGLE_RESTORE_JS = 'document.addEventListener("DOMContentLoaded",function(){var pb=document.getElementById("plainBtn");if(pb){var ps="";try{ps=localStorage.getItem("judge_plain")||"";}catch(e){}setPlainMode(ps==="1",false);}});';
const REPORT_FRONTEND_INIT_JS = 'document.addEventListener("DOMContentLoaded",function(){loadApiConfig();var saved="";try{saved=localStorage.getItem("judge_theme")||"";}catch(e){}if(saved==="dark"){document.body.classList.add("dark");}else{document.body.classList.remove("dark");}var t=document.getElementById("themeBtn");if(t)t.textContent=document.body.classList.contains("dark")?"浅色模式":"深色模式";var pb=document.getElementById("plainBtn");if(pb){var ps="";try{ps=localStorage.getItem("judge_plain")||"";}catch(e){}setPlainMode(ps==="1",false);}});';

// A8-ERR-1：注入完整前端 JS——骨架中的 theme-bar / api-config 面板不再是死 UI；
// saveApiConfig 同时写入 localStorage 并导出 .api-config.json（供 Node 执行器 --api-config / 工作目录消费）
function frontendJs() {
  return [
    // 与 Skill-Judge.md R6a-6 规则同款（CONFIG_KEYS=judge_api_*），扩展：导出 .api-config.json + anthropic 端点测试
    // A8-P7：主题切换持久化——保存到 localStorage judge_theme；按钮文案 = 当前主题的反向动作
    'function toggleTheme(){var b=document.body;var dark=b.classList.toggle("dark");try{localStorage.setItem("judge_theme",dark?"dark":"light");}catch(e){}var t=document.getElementById("themeBtn");if(t)t.textContent=dark?"浅色模式":"深色模式";}',
    // R7 阶段 2：原文/白话双版本切换（data-plain/data-orig 生成期注入，无运行时缓存边界缺陷）
    PLAIN_TOGGLE_JS,
    'var CONFIG_KEYS={url:"judge_api_url",model:"judge_api_model",key:"judge_api_key"};',
    'function loadApiConfig(){document.getElementById("cfg-api-url").value=localStorage.getItem(CONFIG_KEYS.url)||"https://api.deepseek.com/anthropic";document.getElementById("cfg-model").value=localStorage.getItem(CONFIG_KEYS.model)||"deepseek-v4-pro";document.getElementById("cfg-api-key").value=localStorage.getItem(CONFIG_KEYS.key)||"";}',
    'function saveApiConfig(){var url=document.getElementById("cfg-api-url").value.trim();var model=document.getElementById("cfg-model").value.trim();var key=document.getElementById("cfg-api-key").value.trim();if(!url||!model||!key){setApiStatus("请填写完整配置","err");return;}localStorage.setItem(CONFIG_KEYS.url,url);localStorage.setItem(CONFIG_KEYS.model,model);localStorage.setItem(CONFIG_KEYS.key,key);setApiStatus("✅ 已保存，已导出 .api-config.json","ok");var provider=url.indexOf("/anthropic")>=0||url.indexOf("/v1/messages")>=0?"anthropic-compatible":(url.indexOf("/chat/completions")>=0||url.indexOf("/v1/chat")>=0)?"openai-compatible":"custom";try{var blob=new Blob([JSON.stringify({provider:provider,baseUrl:url,model:model,apiKey:key},null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=".api-config.json";document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},500);}catch(e){}}',
    'function clearApiConfig(){if(!confirm("清除所有 API 配置？"))return;Object.values(CONFIG_KEYS).forEach(function(k){localStorage.removeItem(k);});document.getElementById("cfg-api-url").value="";document.getElementById("cfg-model").value="";document.getElementById("cfg-api-key").value="";setApiStatus("已清除","");}',
    'function toggleApiConfig(){var body=document.getElementById("api-config-body");var arrow=document.getElementById("api-config-arrow");if(!body)return;body.classList.toggle("open");if(arrow)arrow.textContent=body.classList.contains("open")?"▼":"▶";}',
    'async function testApiConnection(){var url=document.getElementById("cfg-api-url").value.trim();var model=document.getElementById("cfg-model").value.trim();var key=document.getElementById("cfg-api-key").value.trim();if(!url||!model||!key){setApiStatus("请先保存配置","err");return;}setApiStatus("⏳ 测试中...","");var ant=url.indexOf("/anthropic")>=0||url.indexOf("/v1/messages")>=0;var endpoint=url.replace(/\\/+$/,"")+(ant?"/v1/messages":"/chat/completions");try{var resp=await fetch(endpoint,{method:"POST",headers:ant?{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"}:{"Content-Type":"application/json","Authorization":"Bearer "+key},body:JSON.stringify(ant?{model:model,max_tokens:8,messages:[{role:"user",content:"Hi"}]}:{model:model,messages:[{role:"user",content:"Hi"}],max_tokens:8})});if(resp.ok){setApiStatus("✅ 连接成功","ok");}else{setApiStatus("❌ "+resp.status,"err");}}catch(e){setApiStatus("❌ "+e.message,"err");}}',
    'function setApiStatus(msg,type){var el=document.getElementById("api-status");if(!el)return;el.textContent=msg;el.className="status"+(type?" "+type:"");}',
    // A8-P7：默认浅色；仅当用户此前明确保存过 dark 才应用深色（不再跟随系统偏好）
    REPORT_FRONTEND_INIT_JS
  ].join('\n');
}

// R7 阶段 2/3：双版本切换按钮注入（仅当存在 data-plain 时；无白话版则原样返回）
function injectPlainToggle(html) {
  if (!/data-plain=/.test(html) || html.includes('id="plainBtn"')) return html;
  const btn = '<button id="plainBtn" class="plain-toggle" type="button" aria-pressed="false" aria-keyshortcuts="Alt+T" title="切换原文/白话（Alt+T）" onclick="togglePlain()">白话</button>';
  if (html.includes('class="theme-bar"')) html = html.replace('class="theme-bar"', 'class="theme-bar plain-toggle-host"');
  if (html.includes('<button id="themeBtn"')) {
    html = html.replace('<button id="themeBtn"', btn + '<button id="themeBtn"');
  } else if (html.includes('class="theme-bar plain-toggle-host"')) {
    html = html.replace(/<div class="theme-bar plain-toggle-host">/, '<div class="theme-bar plain-toggle-host">' + btn);
  } else {
    // 兜底：无 theme-bar 结构（如 mock 占位/旧模板）时插到 body 开头
    html = html.replace(/<body[^>]*>/, m => m + '\n' + btn);
  }
  // 兜底：HTML 缺 togglePlain 定义时随按钮注入完整运行时（含持久化恢复）
  if (!html.includes('function togglePlain')) {
    html = html.replace(/<\/body>/, '<script>' + PLAIN_TOGGLE_JS + PLAIN_TOGGLE_RESTORE_JS + '</script>\n</body>');
  }
  return html;
}

// ==================== CLI ====================

function main() {
  // 卡 9（260815）：CLI 自检依赖动态 require（仅 require.main 直跑时加载——被 require 时零 PC，web 可打包）
  const PC = require('./pipeline-controller.js');
  const args = process.argv.slice(2);
  const transition = args[0];
  const narrative = args[1];
  const structurePath = args[2];
  const outIdx = args.indexOf('--out');
  const outDirIdx = args.indexOf('--out-dir');
  // A8-ERR-1 C9：输出目录唯一解析（显式 --out-dir；未提供 --out 时无默认路径，结构性消除 fallback）
  let outDir = null;
  if (outDirIdx >= 0) {
    try {
      outDir = PC.ensureFreshOutputDir(transition, args[outDirIdx + 1], args.includes('--force')).dir;
    } catch (e) {
      console.error('[' + (e.code || 'ERR') + '] ' + e.message);
      process.exit(1);
    }
    // C9b 输入归属校验：中间文件必须已位于 outDir 内（机械保证“所有文件都在当次目录”）
    for (const input of [transition, narrative, structurePath].filter(Boolean)) {
      if (path.dirname(path.resolve(input)) !== path.resolve(outDir)) {
        console.error('[ERR_OUTPUT_ISOLATION] 中间文件必须位于输出目录（--out-dir）内: ' + input);
        process.exit(1);
      }
    }
  }
  if (outIdx < 0 && !outDir) {
    console.error('用法: node render-report.js <transition-final.md> <叙事.md> [structure.json] (--out <report.html> | --out-dir <目录>) [--depth-* ...]');
    process.exit(2);
  }
  const out = outIdx >= 0 ? args[outIdx + 1] : path.join(outDir, 'report.html');
  const depth = {};
  for (const flag of ['--depth-verdict', '--depth-mainline', '--depth-clash']) {
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1]) depth[flag.replace('--depth-', '')] = args[idx + 1];
  }
  if (!transition || !narrative) {
    console.error('用法: node render-report.js <transition-final.md> <叙事.md> [structure.json] (--out <report.html> | --out-dir <目录>) [--depth-verdict 简明|标准|详细] [--depth-mainline 简述类型|标准全景图|逐环节追踪] [--depth-clash 仅关键2-3个|标准5-8个|逐回合全部]');
    process.exit(1);
  }
  const normalized = normalizePhase1(fs.readFileSync(transition, 'utf-8'), fs.readFileSync(narrative, 'utf-8'));
  const opts = {};
  if (Object.keys(depth).length) opts.depth = depth;
  // A8-P7：structure.json 为渲染必需输入——缺失即报错退出，禁止降级渲染
  if (!structurePath || !fs.existsSync(structurePath)) {
    console.error('[ERR_STRUCTURE_REQUIRED] structure.json 缺失——禁止降级渲染（C3 必须按推进层完整渲染）。请先通过 R4 门禁。');
    process.exit(1);
  }
  opts.structure = JSON.parse(fs.readFileSync(structurePath, 'utf-8'));
  const data = normalized.data || {};
  const g0 = PC.checkEffectiveType(data, opts.structure, null);
  if (g0.errors.length) {
    console.error('G0 门禁失败: ' + g0.errors.map(e => e.rule + ' ' + e.message).join(' | '));
    process.exit(1);
  }
  opts.effectiveType = g0.effectiveType;
  const html = renderHTML(normalized, opts);
  if (!fs.existsSync(path.dirname(out))) fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf-8');
  const g8 = selfCheckG8(html, null);
  console.log(JSON.stringify({ out, bytes: Buffer.byteLength(html, 'utf-8'), g8 }, null, 2));
  process.exit(g8.ok ? 0 : 1);
}

module.exports = { normalizePhase1, renderHTML, renderReaderGuide, embedReaderGuideIntoReport, stripEmbeddedReaderGuide, migratePlainToggleRuntime, selfCheckG8, extractModules, extractTableBlocks, wrapProseStub, wrapProse, verdictText, truncateTableRows, assembleC1Blocks, c2BadgeHTML, c2ScPanelHTML, o4ContentProgress, o5ScProgress, injectChart, radarSVG, barSVG, donutSVG, scBarSVG, buildChartData, parseArrowAssessment, normalizeStatus, parseArrowStatusFromS2, arrowStatusFromRows, completionCountsFromRows, matrixEntriesFromRows, parseS2ArgumentChain, parseS2B0, s2ArrowDetails, parseMicroDigestionTable, arrowMatrixSVG, c8Chart1, c8Chart2, c8Chart3, c9GaugeSVG, c8Dominance, renderC3Panel, renderC3Summary, renderC8Persona, readAssetText, frontendJs, injectPlainToggle, removeDataConditionBlocks, dedupeModuleH3, stripSlotHeadingDup, resolveNodeLabel, resolveNodeEvent, applyVisibleTerminology, parseS7Attack, heuristicAttackMap, singleRingDetailRows, buildC5V2Ui, applyC5UiTransforms };

if (require.main === module) main();
