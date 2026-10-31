// 日记（MA2）：列表 / 保存（AI 总结）/ 删除

const express = require('express');
const config = require('../lib/config');
const store = require('../lib/store');
const { saveDiary } = require('../lib/diary');

module.exports = () => {
  const router = express.Router();

  router.get('/diaries', (req, res) => {
    // 不把向量发给前端
    const diaries = store
      .listDiaries()
      .slice()
      .reverse()
      .map(({ embedding, ...rest }) => rest);
    res.json(diaries);
  });

  router.post('/diary', async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: '日记内容不能为空' });
    try {
      const diary = await saveDiary(config.get(), text);
      const { embedding, ...rest } = diary;
      res.json(rest);
    } catch (err) {
      res.status(502).json({ error: err.message || '日记总结失败' });
    }
  });

  // 删除单篇日记（同时从记忆库移除）
  router.delete('/diaries/:id', (req, res) => {
    const ok = store.deleteDiary(req.params.id);
    if (!ok) return res.status(404).json({ error: '日记不存在' });
    res.json({ ok: true });
  });

  return router;
};
