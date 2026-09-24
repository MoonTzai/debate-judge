'use strict';

// Export presentation only. This module never reinterprets judgment or scores.
function toMarkdown(html, Parser) {
  Parser = Parser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!Parser) throw new Error('Markdown 导出需要浏览器 DOMParser');
  const doc = new Parser().parseFromString(String(html || ''), 'text/html');
  const cell = text => text.trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
  function walk(node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script','style','head','button','input','select','textarea','nav','svg'].includes(tag) ||
        node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' ||
        /display\s*:\s*none/i.test(node.getAttribute('style') || '')) return '';
    const content = () => Array.from(node.childNodes).map(walk).join('');
    if (tag === 'br') return '\n';
    if (tag === 'table') {
      const rows = Array.from(node.rows).map(row => Array.from(row.cells).map(c => cell(Array.from(c.childNodes).map(walk).join(''))));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(r => r.length));
      const line = r => '| ' + Array.from({length:width}, (_,i)=>r[i] || '').join(' | ') + ' |';
      return '\n\n' + line(rows[0]) + '\n' + line(Array(width).fill('---')) + '\n' + rows.slice(1).map(line).join('\n') + '\n\n';
    }
    const text = content().trim();
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + text + '\n\n';
    if (tag === 'li') return '\n- ' + text.replace(/\n/g, '\n  ');
    if (tag === 'blockquote') return '\n\n' + text.split('\n').map(s=>'> ' + s).join('\n') + '\n\n';
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      return /^(https?:|#)/i.test(href) ? '[' + text + '](' + href + ')' : text;
    }
    if (tag === 'strong' || tag === 'b') return text ? '**' + text + '**' : '';
    if (tag === 'em' || tag === 'i') return text ? '*' + text + '*' : '';
    if (['p','div','section','article','header','footer','main','ul','ol','details','summary','figure','figcaption'].includes(tag))
      return text ? '\n\n' + text + '\n\n' : '';
    return content();
  }
  return walk(doc.body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
module.exports = { toMarkdown };
