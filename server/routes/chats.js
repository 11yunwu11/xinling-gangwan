// 聊天记录本地浏览 + 多版本切换

const express = require('express');
const config = require('../lib/config');
const store = require('../lib/store');
const time = require('../lib/time');

module.exports = () => {
  const router = express.Router();

  // 有聊天记录的日子列表（新的在前）
  router.get('/chats', (req, res) => {
    const all = store.readAllChats();
    const list = Object.keys(all)
      .filter((k) => k && k !== 'null' && (all[k] || []).length)
      .sort()
      .reverse()
      .map((k) => ({ key: k, count: all[k].length }));
    res.json(list);
  });

  // 当前逻辑日的对话（刷新页面后自动载入）
  router.get('/chats/current', (req, res) => {
    const cfg = config.get();
    const key = time.currentLogicalKey(cfg.wakeTime);
    res.json({ key, messages: store.readChat(key) });
  });

  // 指定日期的对话（只读回看）
  router.get('/chats/:key', (req, res) => {
    const key = req.params.key;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return res.status(400).json({ error: '日期格式不对' });
    res.json({ key, messages: store.readChat(key) });
  });

  // 切换某条回应的多版本（重新 roll 留下的历史版本之间来回看）
  // body: { dir: 'prev'|'next' }（越界环绕）或 { to: <版本序号> }
  router.post('/chats/:key/message/:index/variant', (req, res) => {
    const key = req.params.key;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return res.status(400).json({ error: '日期格式不对' });

    const index = Number(req.params.index);
    const msg = store.readChat(key)[index];
    if (!msg || msg.role !== 'assistant') return res.status(404).json({ error: '消息不存在' });

    const total = (msg.variants || []).length;
    if (total < 2) return res.status(400).json({ error: '这条回应还没有多个版本' });

    let to;
    if (typeof (req.body && req.body.to) === 'number') {
      to = req.body.to;
    } else {
      const cur = msg.variantIndex || 0;
      to = cur + ((req.body && req.body.dir) === 'prev' ? -1 : 1);
      if (to < 0) to = total - 1;
      if (to >= total) to = 0;
    }
    if (!Number.isInteger(to) || to < 0 || to >= total) return res.status(400).json({ error: '版本序号超出范围' });

    const updated = store.updateChatMessage(key, index, { content: msg.variants[to], variantIndex: to });
    res.json({ ok: true, content: updated.content, variantIndex: to, variantTotal: total });
  });

  return router;
};
