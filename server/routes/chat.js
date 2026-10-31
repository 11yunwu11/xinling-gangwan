// 对话接口：SSE 流式返回 agent 事件
// { text } 正常发言；{ regenerate: true } 重新生成（回到最近一条用户消息重跑）

const express = require('express');
const { handleUserMessage, regenerateResponse } = require('../lib/agent');

module.exports = () => {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    const regenerate = !!b.regenerate;

    if (!text && !regenerate) return res.status(400).json({ error: '消息不能为空' });
    if (text && regenerate) return res.status(400).json({ error: 'text 与 regenerate 不能同时传' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 客户端中途断开（刷新/关页）时：停止向已销毁的 socket 写入，避免 EPIPE 未捕获错误打崩进程；
    // agent 本轮照常跑完（结果照常落盘），只是不再对外发送
    let closed = false;
    req.on('close', () => { closed = true; });
    res.on('error', () => { closed = true; });
    const send = (ev) => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        closed = true;
      }
    };

    try {
      if (regenerate) {
        await regenerateResponse(send);
      } else {
        await handleUserMessage(text, send);
      }
    } catch (err) {
      send({ type: 'error', message: err.message || '服务内部错误' });
    }
    if (!closed && !res.destroyed) res.end();
  });

  return router;
};
