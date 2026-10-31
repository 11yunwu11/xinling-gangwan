// 配置与健康检查（首启配置窗口 / ⚙ 设置）

const express = require('express');
const config = require('../lib/config');
const store = require('../lib/store');
const { embedParams } = require('../lib/embedding');
const { syncStoredEmbeddings } = require('../lib/reembed');
const scheduler = require('../lib/scheduler');
const mcp = require('../lib/mcp');
const chatdigest = require('../lib/chatdigest');

const SKILL_CONTEXTS = ['none', 'knowledge', 'week_diaries', 'previous_diary'];

function validMcpServer(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const name = String(entry.name || '').trim();
  if (!name || String(entry.transport || 'stdio') === 'http') {
    return !!name && !!String(entry.url || '').trim();
  }
  return !!String(entry.command || '').trim();
}

module.exports = ({ postSetupInit }) => {
  const router = express.Router();

  router.get('/health', (req, res) => {
    const cfg = config.get();
    res.json({
      ok: true,
      usingExampleConfig: !!cfg._usingExample,
      needsSetup: !config.isConfigured(cfg),
      model: cfg.llm && cfg.llm.model,
      embeddingModel: embedParams(cfg).model,
      wakeTime: cfg.wakeTime,
      kbCards: (store.readKb() || { entries: [] }).entries.length,
      mcpTools: mcp.listMcpToolsForUi().length,
      chatDigests: chatdigest.listDigests().length,
    });
  });

  // 只返回可公开回显的字段，绝不含 apiKey（对话模型与 embedding 都不回显 key）
  router.get('/config/public', (req, res) => {
    const cfg = config.get();
    const emb = embedParams(cfg);
    res.json({
      configured: config.isConfigured(cfg),
      model: cfg.llm && cfg.llm.model,
      baseUrl: cfg.llm && cfg.llm.baseUrl,
      embeddingModel: emb.model,
      embeddingBaseUrl: (cfg.embedding && cfg.embedding.baseUrl) || '',
      embeddingSeparate: !!(cfg.embedding && (cfg.embedding.baseUrl || cfg.embedding.apiKey || cfg.embedding.model)),
      mcpServers: cfg.mcpServers || [],
      wakeTime: cfg.wakeTime,
    });
  });

  router.post('/config', (req, res) => {
    const b = req.body || {};
    const partial = { llm: {}, embedding: {} };
    if (b.apiKey !== undefined) partial.apiKey = String(b.apiKey).trim();
    if (b.model) partial.llm.model = String(b.model).trim();
    if (b.baseUrl) partial.llm.baseUrl = String(b.baseUrl).trim();
    if (b.embeddingModel) partial.embeddingModel = String(b.embeddingModel).trim();
    if (b.embedding && typeof b.embedding === 'object') {
      const e = b.embedding;
      if (e.baseUrl) partial.embedding.baseUrl = String(e.baseUrl).trim();
      if (e.model) partial.embedding.model = String(e.model).trim();
      if (e.apiKey) partial.embedding.apiKey = String(e.apiKey).trim(); // 留空 = 保留旧值/沿用对话 Key
    }
    if (Array.isArray(b.mcpServers)) {
      // F0/F8：设置页可配 MCP 服务器；非法条目直接拒绝（避免存进坏配置）
      const servers = b.mcpServers.filter(validMcpServer);
      if (servers.length !== b.mcpServers.length) {
        return res.status(400).json({ error: 'MCP 服务器配置不合法：每项需要 name，stdio 需要 command，http 需要 url' });
      }
      partial.mcpServers = servers;
    }
    if (b.wakeTime && /^\d{1,2}:\d{2}$/.test(String(b.wakeTime).trim())) {
      partial.wakeTime = String(b.wakeTime).trim();
    }
    if (!Object.keys(partial.embedding).length) delete partial.embedding;

    const before = config.get();
    if (!config.isConfigured(before) && !partial.apiKey) {
      return res.status(400).json({ error: '请填写 API Key' });
    }

    const saved = config.save(partial);
    if (config.isConfigured(saved)) {
      postSetupInit(saved);
      scheduler.initScheduler(saved); // 起床时间可能变化 → 重新排程
      // 向量空间一致性 + MCP 重载都在后台做，保存请求立即返回
      syncStoredEmbeddings(saved)
        .then((r) => { if (r.changed) console.log('[config] 已按新 embedding 参数重嵌入全部向量'); })
        .catch((err) => console.warn('[config] 重嵌入失败（下次启动重试）：', err.message));
      if (partial.mcpServers) {
        mcp.reinitMcpServers(saved)
          .then((results) => console.log('[config] MCP 已按新配置重载：', results.map((r) => `${r.serverName}:${r.ok ? 'ok' : 'fail'}`).join(', ')))
          .catch((err) => console.warn('[config] MCP 重载失败：', err.message));
      }
    }
    res.json({ ok: true, configured: config.isConfigured(saved) });
  });

  return router;
};
