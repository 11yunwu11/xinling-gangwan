// 晨间安抚（M4）：pull 兜底 + 已读标记

const express = require('express');
const config = require('../lib/config');
const comfort = require('../lib/comfort');

module.exports = () => {
  const router = express.Router();

  // 兜底 pull：当日缺失且已配置则现场生成（C6）
  router.get('/comfort', async (req, res) => {
    const c = config.get();
    if (!config.isConfigured(c)) return res.json({ available: false });
    try {
      const s = await comfort.ensureComfort(c);
      res.json({ available: true, key: s.key, text: s.text, read: !!s.read });
    } catch (err) {
      res.status(502).json({ error: err.message || '安抚生成失败' });
    }
  });

  router.post('/comfort/read', (req, res) => {
    res.json(comfort.markRead() || { ok: false });
  });

  return router;
};
