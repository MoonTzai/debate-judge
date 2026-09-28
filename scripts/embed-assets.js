// L5+C10b 单文件交付：将 assets/、schemas/ 与渲染器 JS 内嵌为 Skill-Judge.md 尾部块（幂等），并同步三镜像。
// 运行：node scripts/embed-assets.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

// 卡 3（260815）：闭包资产清单单一源 = install-skill BLOCKS；
// blocks = BLOCKS∖PIPELINE_CONTROLLER，数量与 lang、块序均由清单派生
const { BLOCKS } = require('../install-skill.js');
const blocks = BLOCKS.filter(b => b.name !== 'PIPELINE_CONTROLLER').map(({ name, file, lang }) => ({ name, lang, file }));

function buildBlock(b) {
  const content = fs.readFileSync(path.join(root, b.file), 'utf-8').replace(/\r\n/g, '\n').trim();
  return '<!-- EMBED_ASSET:' + b.name + '_START -->\n```' + b.lang + '\n' + content + '\n```\n<!-- EMBED_ASSET:' + b.name + '_END -->';
}

// 卡 3：EMBED_ASSET_LIST 生成器（构建期写入，install-skill 只读校验——防鸡生蛋协议；
// 栅栏 ```text 逐字对齐 plain-language.test.js L173 解析，install-skill verify 兼容）
function buildAssetList() {
  return '<!-- EMBED_ASSET_LIST -->\n```text\n' + BLOCKS.map(b => b.name).join('\n') + '\n```\n<!-- /EMBED_ASSET_LIST -->';
}

function embed(content) {
  // A8-P4 修复：拆串，避免命中内嵌源码中的完整字面量
  const marker = '<!-- PIPELINE_CONTROLLER_' + 'START -->';
  const idx = content.indexOf(marker);
  if (idx < 0) throw new Error('PIPELINE_CONTROLLER_START 未找到');
  // Some earlier deliveries placed assets AFTER the controller. Rebuild both
  // outer regions, retaining the controller itself and all non-asset text. Only
  // registered, line-anchored, matched marker pairs are removed; source literals
  // inside the controller are never interpreted as asset boundaries.
  const endMarker = '<!-- PIPELINE_CONTROLLER_' + 'END -->';
  const end = content.indexOf(endMarker, idx + marker.length);
  if (end < 0) throw new Error('PIPELINE_CONTROLLER_END 未找到');
  const controllerEnd = end + endMarker.length;
  const names = new Set(blocks.map(b => b.name));
  const stripAssets = region => region.replace(/^<!-- EMBED_ASSET:([A-Z0-9_]+)_START -->[\s\S]*?^<!-- EMBED_ASSET:\1_END -->\s*/gm,
    (whole, name) => names.has(name) ? '' : whole);
  const head = stripAssets(content.slice(0, idx));
  const blockText = blocks.map(buildBlock).join('\n') + '\n\n';
  return head + blockText + content.slice(idx, controllerEnd) + stripAssets(content.slice(controllerEnd));
}

// 卡 3：EMBED_ASSET_LIST 尾部区块更新（lastIndexOf 定位，与 install-skill verify 语义一致；幂等；
// lastIndexOf=-1 首次创建路径：文件尾追加）
function upsertAssetList(skill) {
  const listText = buildAssetList();
  const head = '<!-- EMBED_ASSET_LIST -->';
  const idx = skill.lastIndexOf(head);
  if (idx >= 0) {
    const close = '<!-- /EMBED_ASSET_LIST -->';
    const closeIdx = skill.indexOf(close, idx + head.length);
    const end = closeIdx >= 0 ? closeIdx + close.length : skill.length;
    return skill.slice(0, idx) + listText + skill.slice(end);
  }
  return skill.replace(/\n*$/, '') + '\n' + listText + '\n';
}

function syncR6aCssTemplate(content) {
  content = String(content).replace(/\r\n/g, '\n');
  const marker = '### R6a-3 CSS';
  const idx = content.indexOf(marker);
  if (idx < 0) throw new Error('R6a-3 CSS 模板未找到');
  const open = content.indexOf('```css', idx);
  if (open < 0) throw new Error('R6a-3 CSS 开始围栏未找到');
  const bodyStart = open + '```css'.length;
  const close = content.indexOf('```', bodyStart);
  if (close < 0) throw new Error('R6a-3 CSS 结束围栏未找到');
  const css = fs.readFileSync(path.join(root, 'assets', 'report.css'), 'utf-8').replace(/\r\n/g, '\n').trim();
  return content.slice(0, bodyStart) + '\n' + css + '\n' + content.slice(close);
}

function renderSkillContent(content) {
  return upsertAssetList(embed(syncR6aCssTemplate(String(content))));
}

function writeEmbeddedMirrors() {
  const skillPath = path.join(root, 'Skill-Judge.md');
  const skill = renderSkillContent(fs.readFileSync(skillPath, 'utf-8'));
  fs.writeFileSync(skillPath, skill, 'utf-8');
  for (const m of ['Debate-Judge.md', '.claude/skills/debate-judge/SKILL.md']) {
    fs.writeFileSync(path.join(root, m), skill, 'utf-8');
  }
  return skill;
}

function main() {
  writeEmbeddedMirrors();
  console.log('embedded blocks written:', blocks.map(b => b.name).join(', '));
  console.log('mirrors synced: Debate-Judge.md, .claude/skills/debate-judge/SKILL.md');
}

if (require.main === module) main();
module.exports = {
  blocks,
  buildBlock,
  buildAssetList,
  embed,
  upsertAssetList,
  syncR6aCssTemplate,
  renderSkillContent,
  writeEmbeddedMirrors
};
