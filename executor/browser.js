// A8-P3b：统一轮次执行器·浏览器适配层（W 系列 = P3 的浏览器端，独立工程不在本批次实现）
// 共享 executor/core.js 与 executor/api-provider.js 的调度/门禁逻辑，仅替换宿主：
//   Node  host-node.js   → fs/path + 文件落盘
//   Web   browser.js    → fetch + IndexedDB/Blob 下载
// 本文件提供接口契约与最小实现，供 W 系列独立立项时填充。
'use strict';
const core = require('./core.js');
const api = require('./api-provider.js');

// 浏览器宿主接口契约（W 系列实现时按此签名对接 core.runPipeline 的宿主适配）
// async function loadPrompt(round) -> string        // 从 IndexedDB/内嵌块读取 prompt
// async function saveArtifact(round, text) -> void  // 落盘（IndexedDB 或下载）
// async function loadArtifact(round) -> string|null // 断点续跑
async function createBrowserHost() {
  return {
    name: 'browser',
    core,
    api,
    // 以下为契约占位：W 系列实现 IndexedDB 适配后启用
    async loadPrompt() { throw new Error('[executor/browser] W 系列独立工程：loadPrompt 未实现'); },
    async saveArtifact() { throw new Error('[executor/browser] W 系列独立工程：saveArtifact 未实现'); },
    async loadArtifact() { return null; }
  };
}

module.exports = { createBrowserHost };
