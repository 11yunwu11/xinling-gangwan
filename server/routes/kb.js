// 知识库：可视化列表 + 自定义卡片增删（内置卡片受保护）

const express = require('express');
const config = require('../lib/config');
const store = require('../lib/store');
const kb = require('../lib/kb');

module.exports = () => {
  const router = express.Router();

  // 卡片列表（不含向量）——能力页展示用
  router.get('/kb', (req, res) => {
    const kbData = store.readKb();
    const entries = kbData ? kbData.entries : [];
    res.json({
      built: !!kbData,
      count: entries.length,
      cards: entries.map(({ embedding, ...rest }) => rest),
    });
  });

  // 新增自定义知识卡片（内置卡片受保护，本接口只写 data/knowledge/）
  router.post('/kb/cards', async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const tags = String(b.tags || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    const text = String(b.text || '').trim();
    if (!title || !text) return res.status(400).json({ error: '标题和内容不能为空' });
    if (title.includes('\n') || title.length > 60) return res.status(400).json({ error: '标题要单行且不超过 60 字' });
    if (text.length > 5000) return res.status(400).json({ error: '内容不能超过 5000 字' });

    const card = kb.writeCard({ title, tags, text });
    let rebuilt;
    try {
      rebuilt = await kb.ensureKb(config.get()); // cardsKey 变化 → 重新向量化（含新卡片）
    } catch (err) {
      rebuilt = { error: err.message };
    }
    res.json({ ok: true, card, rebuilt });
  });

  // 删除自定义知识卡片；内置卡片永远删不掉（安全兜底）
  router.delete('/kb/cards/:id', async (req, res) => {
    const ok = kb.deleteCard(req.params.id);
    if (!ok) return res.status(404).json({ error: '卡片不存在，或这是内置卡片（内置内容不可删除）' });
    let rebuilt;
    try {
      rebuilt = await kb.ensureKb(config.get());
    } catch (err) {
      rebuilt = { error: err.message };
    }
    res.json({ ok: true, rebuilt });
  });

  return router;
};
