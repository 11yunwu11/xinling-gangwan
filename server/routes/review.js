// 回顾与分析（M5 / F9）：统计 + AI 周报

const express = require('express');
const config = require('../lib/config');
const time = require('../lib/time');
const review = require('../lib/review');

module.exports = () => {
  const router = express.Router();

  router.get('/stats', (req, res) => {
    res.json({ ...review.computeStats(), todayKey: time.currentLogicalKey(config.get().wakeTime) });
  });

  router.get('/report', (req, res) => {
    res.json(review.latestReport());
  });

  router.post('/report', async (req, res) => {
    const c = config.get();
    if (!config.isConfigured(c)) return res.status(400).json({ error: '请先完成配置' });
    try {
      res.json(await review.generateWeeklyReport(c));
    } catch (err) {
      res.status(502).json({ error: err.message || '周报生成失败' });
    }
  });

  return router;
};
