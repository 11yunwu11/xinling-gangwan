// 每日任务（F5）：日历绑定视图所需的 增/删/打卡/列表 接口

const express = require('express');
const config = require('../lib/config');
const store = require('../lib/store');
const time = require('../lib/time');
const tasksLib = require('../lib/tasks');

module.exports = () => {
  const router = express.Router();

  // 列表（惰性生成今日任务）+ todayKey（前端日历定位"今天"用）
  router.get('/tasks', (req, res) => {
    tasksLib.ensureDailyTask(config.get());
    const cfg = config.get();
    res.json({
      todayKey: time.currentLogicalKey(cfg.wakeTime),
      tasks: store.listTasks().slice().reverse(), // 新的在前
    });
  });

  // 手动添加任务（任务页日历绑定：可指定归属日期）
  router.post('/tasks', (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: '任务内容不能为空' });
    if (title.length > 120) return res.status(400).json({ error: '任务内容不能超过 120 字' });
    const cfg = config.get();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : time.currentLogicalKey(cfg.wakeTime);
    const task = store.addTask({ title, date, source: 'manual' });
    res.json({ ok: true, task });
  });

  // 打卡完成 + AI 鼓励语
  router.post('/tasks/:id/complete', async (req, res) => {
    const task = await tasksLib.completeTask(req.params.id, config.get());
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
  });

  // 删除任务（手动清理记错/不想留的条目）
  router.delete('/tasks/:id', (req, res) => {
    const tasks = store.listTasks();
    const next = tasks.filter((t) => t.id !== req.params.id);
    if (next.length === tasks.length) return res.status(404).json({ error: '任务不存在' });
    store.setTasks(next);
    res.json({ ok: true });
  });

  return router;
};
