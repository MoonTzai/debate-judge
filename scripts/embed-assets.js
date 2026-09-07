// L5+C10b 单文件交付：将 assets/、schemas/ 与渲染器 JS 内嵌为 Skill-Judge.md 尾部块（幂等），只更新 canonical Skill。
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
  // 幂等重建（卡 3 修复现状非幂等 bug：原删除正则 \n? 只吞一个换行 → 块区边界空行每次累积）：
  // 只重建 PC_START 之前的块区（整块删除并吞块后空白 \s*，块序 = BLOCKS 序）；
  // 行首锚定（^ + m，卡 8 教训同款）：源码内块标记字面量（如 contract.js loadInputContract 正则）
  // 均非行首（前缀 content.match(/ 等）——杜绝跨内容误删；PC 块/尾部绝不触碰
  const head = content.slice(0, idx).replace(/^<!-- EMBED_ASSET:[A-Z0-9_]+_START -->[\s\S]*?^<!-- EMBED_ASSET:[A-Z0-9_]+_END -->\s*/gm, '');
  const blockText = blocks.map(buildBlock).join('\n') + '\n\n';
  return head + blockText + content.slice(idx);
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

const skillPath = path.join(root, 'Skill-Judge.md');
const skill = upsertAssetList(embed(fs.readFileSync(skillPath, 'utf-8')));
fs.writeFileSync(skillPath, skill, 'utf-8');
console.log('canonical Skill updated: Skill-Judge.md');
