// 每日任务（F5）：列表（惰性生成今日任务）+ 打卡

const express = require('express');
const config = require('../lib/config');
const store = require('../lib/store');
const tasksLib = require('../lib/tasks');

module.exports = () => {
  const router = express.Router();

  router.get('/tasks', (req, res) => {
    tasksLib.ensureDailyTask(config.get()); // 每天首次访问时生成今日随机任务（F5）
    res.json(store.listTasks().slice().reverse()); // 新的在前
  });

  // 打卡完成 + AI 鼓励语
  router.post('/tasks/:id/complete', async (req, res) => {
    const task = await tasksLib.completeTask(req.params.id, config.get());
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
  });

  return router;
};
