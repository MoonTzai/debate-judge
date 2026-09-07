// Debate-Judge TABLE 预渲染器
// 用法: node render-tables.js <叙事.md> [输出路径]
// 将叙事.md 中所有 <!--TABLE:...-->...<!--/TABLE--> 块转为 HTML <table class="tb">

const fs = require('fs');
const path = require('path');

// ========== 类型规则 ==========

const VERDICT_COLS = ['赢家', '胜方', '裁决结果'];
const INTEGRITY_COLS = ['状态'];

function isVerdictCol(colName) {
  return VERDICT_COLS.some(k => colName.includes(k));
}
function isIntegrityCol(colName) {
  return INTEGRITY_COLS.some(k => colName.includes(k));
}

// ========== TABLE 块提取 ==========

function extractTableBlocks(md) {
  const blocks = [];
  const regex = /<!--TABLE:([^>]+)-->([\s\S]*?)<!--\/TABLE-->/g;
  let match;
  while ((match = regex.exec(md)) !== null) {
    blocks.push({
      full: match[0],
      attrs: match[1].trim(),
      body: match[2].trim(),
      index: match.index
    });
  }
  return blocks;
}

function parseAttrs(attrStr) {
  const attrs = {};
  const pairs = attrStr.split(',').map(s => s.trim());
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      attrs[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return attrs;
}

// ========== 分隔行判定（7fixes） ==========

function isSeparatorRow(line) {
  const t = line.trim();
  return /^\|[-|:\s]*$/.test(t) && /-{3,}/.test(t);
}

// ========== 核心渲染 ==========

function renderTable(block) {
  const attrs = parseAttrs(block.attrs);
  const type = attrs['类型'] || 'default';
  const colNames = (attrs['列'] || '').split('|').map(s => s.trim()).filter(Boolean);

  // Step 2: 标准化数据行
  const lines = block.body.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !isSeparatorRow(l))   // 丢弃分隔行（覆盖14种合法变体）
    .filter(l => !l.startsWith('<!--')); // F-13：丢弃 <!--COLSPAN--> 等注释行，防止污染列数

  if (lines.length === 0) return { html: '', warnings: ['空表格'] };

  // Step 3: COLSPAN 通宽标题识别（F-13）
  // 模式：首行单非空单元格 且 次行 ≥2 非空单元格 → 首行=通宽标题行、次行=表头。
  // 依赖表结构特征而非 <!--COLSPAN--> 注释，R5 格式漂移时仍能正确判定。
  const cellSplit = line => line.split('|').map(s => s.trim()).slice(1, -1);
  let titleCell = null;
  let headerIndex = 0;
  if (lines.length >= 2) {
    const first = cellSplit(lines[0]);
    const second = cellSplit(lines[1]);
    if (first.filter(c => c.length > 0).length === 1 && second.filter(c => c.length > 0).length >= 2) {
      titleCell = first.find(c => c.length > 0);
      headerIndex = 1;
    }
  }

  // 列数：按表头行（headerIndex）计算；slice(1,-1) 排除首尾空元素，与数据行语义一致（消除尾随管道导致 nCols 多 1）
  const headerCells = cellSplit(lines[headerIndex]);
  const nCols = colNames.length || headerCells.length || 1;

  const rows = [];
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const cells = cellSplit(lines[i]);
    // 如果列数不匹配
    if (cells.length !== nCols && cells.length > 0) {
      warnings.push(`行${i+1}: 列数=${cells.length} 预期=${nCols}`);
    }
    rows.push(cells);
  }

  // Step 4: 类型规则
  let verdictColIdx = -1;
  let integrityColIdx = -1;

  // 使用标记中的列名找赢家列和状态列
  if (colNames.length > 0) {
    verdictColIdx = colNames.findIndex(c => isVerdictCol(c));
    integrityColIdx = colNames.findIndex(c => isIntegrityCol(c));
  }
  // 兜底：搜索表头行
  if (verdictColIdx < 0 && rows.length > headerIndex) {
    verdictColIdx = rows[headerIndex].findIndex(c => isVerdictCol(c));
  }
  if (integrityColIdx < 0 && rows.length > headerIndex) {
    integrityColIdx = rows[headerIndex].findIndex(c => isIntegrityCol(c));
  }

  // Step 5: HTML 生成
  const cls = type === 'integrity' ? 'tb integrity' : 'tb';
  let html = '<table class="' + cls + '">\n';

  // F-13：通宽标题行（表头之前）
  if (titleCell !== null) {
    html += `<tr><td colspan="${nCols}" style="font-weight:bold;background:var(--card);padding:10px">${processInlineBold(titleCell)}</td></tr>\n`;
  }

  // thead（headerIndex 行作表头）
  html += '<thead>\n';
  html += '<tr>';
  for (let j = 0; j < rows[headerIndex].length; j++) {
    html += `<th>${rows[headerIndex][j]}</th>`;
  }
  html += '</tr>\n';
  html += '</thead>\n';

  // tbody
  html += '<tbody>\n';
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    // COLSPAN 检测：仅一个非空单元格
    if (row.filter(c => c.length > 0).length === 1) {
      const cell = row.find(c => c.length > 0) || '';
      html += `<tr><td colspan="${nCols}" style="font-weight:bold;background:var(--card);padding:10px">${processInlineBold(cell)}</td></tr>\n`;
      continue;
    }
    // A8-P1c：首列标签 + 唯一内容列 → 内容列 colspan（如 C1 六向度表"三轴对径"行）；仅 nCols>2 时生效（避免 colspan=1 噪音）
    if (nCols > 2 && row[0] && String(row[0]).trim().length > 0) {
      const contentIdx = row.findIndex((c, i) => i > 0 && String(c || '').trim().length > 0);
      const otherNonEmpty = row.some((c, i) => i > 0 && i !== contentIdx && String(c || '').trim().length > 0);
      if (contentIdx > 0 && !otherNonEmpty) {
        html += '<tr><td>' + processInlineBold(row[0]) + '</td><td colspan="' + (nCols - 1) + '">' + processInlineBold(row[contentIdx]) + '</td></tr>\n';
        continue;
      }
    }

    html += '<tr>';
    for (let j = 0; j < row.length; j++) {
      let cell = row[j];

      // 内联粗体转换
      cell = processInlineBold(cell);

      // Verdict 着色
      if (j === verdictColIdx) {
        if (cell === '正' || cell.startsWith('正方')) {
          cell = `<span style="color:var(--green);font-weight:bold">${cell}</span>`;
        } else if (cell === '反' || cell.startsWith('反方')) {
          cell = `<span style="color:var(--blue);font-weight:bold">${cell}</span>`;
        } else if (cell === '平') {
          cell = `<span style="color:var(--dim)">${cell}</span>`;
        }
      }

      // Integrity 状态 emoji
      if (j === integrityColIdx) {
        if (cell.includes('通过')) {
          cell = cell.replace('通过', '🟢 通过');
        } else if (cell.includes('不通过')) {
          cell = cell.replace('不通过', '🔴 不通过');
        } else if (cell.includes('警告')) {
          cell = cell.replace('警告', '🟡 警告');
        }
      }

      html += `<td>${cell}</td>`;
    }
    html += '</tr>\n';
  }
  html += '</tbody>\n</table>';

  return { html, warnings };
}

// ========== 主函数 ==========

function renderAllTables(md) {
  const blocks = extractTableBlocks(md);
  const report = [];
  let result = md;
  let offset = 0;

  for (const block of blocks) {
    const { html, warnings } = renderTable(block);
    const start = block.index + offset;
    const end = start + block.full.length;
    result = result.slice(0, start) + html + result.slice(end);
    offset += html.length - block.full.length;

    const name = parseAttrs(block.attrs)['名称'] || '未命名';
    report.push({ name, warnings });
  }

  return { rendered: result, report };
}

// ========== 内联文本处理（7fixes） ==========

function processInlineBold(text) {
  // 粗体标记转换：2026-08-05 修复——去掉“后跟 CJK 标点/空白”的 lookahead 限制，
  // 否则 `**架构箭头**为评估对象`（粗体后直接跟中文）会被漏转，残留在报告中
  return text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
}

// ========== 列表转换（7fixes·兜底） ==========

function convertLists(block) {
  // 将连续以 - 或 * 开头的行合并为 <ul class="in-list">
  const lines = block.split('\n');
  const result = [];
  let inList = false;
  let listItems = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const listMatch = trimmed.match(/^[-*]\s+(.*)/);
    if (listMatch) {
      if (!inList) { inList = true; listItems = []; }
      listItems.push(listMatch[1]);
    } else {
      if (inList) {
        result.push('<ul class="in-list">' + listItems.map(item => '<li>' + item + '</li>').join('') + '</ul>');
        inList = false; listItems = [];
      }
      result.push(line);
    }
  }
  if (inList) result.push('<ul class="in-list">' + listItems.map(item => '<li>' + item + '</li>').join('') + '</ul>');
  return result.join('\n');
}

// ========== CLI ==========

function main() {
  const args = process.argv.slice(2);
  const inputFile = args[0];
  if (!inputFile) {
    console.error('用法: node render-tables.js <叙事.md> [输出路径]');
    process.exit(1);
  }

  const md = fs.readFileSync(inputFile, 'utf-8');
  const { rendered, report } = renderAllTables(md);

  const outFile = args[1] || inputFile.replace(/\.md$/, '-rendered.md');
  fs.writeFileSync(outFile, rendered, 'utf-8');

  console.log(`输入: ${inputFile} (${md.length} chars)`);
  console.log(`输出: ${outFile} (${rendered.length} chars)`);
  console.log(`表格: ${report.length} 个`);

  let warnings = 0;
  for (const r of report) {
    if (r.warnings.length > 0) {
      console.log(`  ⚠ ${r.name}: ${r.warnings.join('; ')}`);
      warnings++;
    }
  }
  console.log(`警告: ${warnings} 个`);
  console.log(warnings === 0 ? '✅ 全部通过' : '⚠️ 有警告，请检查');
}

if (require.main === module) main();

module.exports = { renderAllTables, extractTableBlocks, renderTable, parseAttrs, isSeparatorRow, processInlineBold, convertLists };
