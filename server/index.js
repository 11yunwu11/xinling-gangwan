// 心灵港湾服务入口：装配路由 + 启动初始化。
// 路由按领域拆在 routes/（config/chat/comfort/chats/tasks/diary/kb/skills/review/abilities/backup）。

const path = require('path');
const express = require('express');
const config = require('./lib/config');
const store = require('./lib/store');
const kb = require('./lib/kb');
const mcp = require('./lib/mcp');
const scheduler = require('./lib/scheduler');
const chatdigest = require('./lib/chatdigest');
const { embedOne, embedParams } = require('./lib/embedding');
const { diaryEmbedText } = require('./lib/diary');
const { syncStoredEmbeddings } = require('./lib/reembed');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(config.ROOT, 'public')));

/* ---------- 首次配置后的初始化（仅一次；配置变更触发的增量动作走各自接口） ---------- */

let initDone = false;
function postSetupInit(currentCfg) {
  if (initDone) return;
  initDone = true;
  (async () => {
    try {
      const r = await kb.ensureKb(currentCfg);
      console.log(`[kb] 知识库${r.built ? '已构建' : '检查完成'}：${r.count} 张卡片（${r.reason}）`);
    } catch (err) {
      console.warn('[kb] 知识库构建失败（不影响其他功能）：', err.message);
    }

    try {
      const pending = store.listDiaries().filter((d) => !d.embedding);
      if (pending.length) {
        for (const d of pending) {
          const vec = await embedOne(embedParams(currentCfg), diaryEmbedText(d.text, d.summary));
          store.updateDiary(d.id, { embedding: vec });
        }
        console.log(`[diary] 已回填 ${pending.length} 篇日记的向量`);
      }
    } catch (err) {
      console.warn('[diary] 向量回填失败（下次启动继续）：', err.message);
    }

    try {
      const r = await syncStoredEmbeddings(currentCfg);
      if (r.changed) console.log('[reembed] 启动时已对齐向量空间（详见上方日志）');
    } catch (err) {
      console.warn('[reembed] 向量空间对齐失败（下次启动重试）：', err.message);
    }

    try {
      await mcp.initMcpServers(currentCfg);
    } catch (err) {
      console.warn('[mcp] 初始化失败（不影响其他功能）：', err.message);
    }

    try {
      const digested = await chatdigest.digestPending(currentCfg);
      if (digested.length) console.log(`[chatdigest] 启动补算：${digested.length} 天的聊天已沉淀为记忆`);
    } catch (err) {
      console.warn('[chatdigest] 补算失败（不影响其他功能）：', err.message);
    }
  })();
}

/* ---------- 路由装配 ---------- */

app.use('/api', require('./routes/config')({ postSetupInit }));
app.use('/api', require('./routes/chat')());
app.use('/api', require('./routes/comfort')());
app.use('/api', require('./routes/chats')());
app.use('/api', require('./routes/tasks')());
app.use('/api', require('./routes/diary')());
app.use('/api', require('./routes/kb')());
app.use('/api', require('./routes/skills')());
app.use('/api', require('./routes/review')());
app.use('/api', require('./routes/abilities')());
app.use('/api', require('./routes/backup')());

/* ---------- 启动 ---------- */

const cfg = config.get();
const port = Number(cfg.port) || 3000;
// C7/C18 权衡：默认监听全部网卡（手机局域网访问需要）；LAN 内任意设备都能访问，介意可在
// config.json 加 "host": "127.0.0.1" 仅限本机
const host = cfg.host || '0.0.0.0';
app.listen(port, host, () => {
  console.log('────────────────────────────────────────────');
  console.log('  心灵港湾 已启动 🌊');
  console.log(`  本机访问   http://localhost:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    console.log(`  手机访问   http://<本机IP>:${port} （同一 WiFi；数据在你局域网内明文可见）`);
  }
  if (!config.isConfigured(cfg)) {
    console.log('  ⚠ 尚未配置 API Key：请在打开的页面弹窗中填入（会保存到本地 config.json）。');
  }
  console.log('────────────────────────────────────────────');

  if (config.isConfigured(cfg)) {
    postSetupInit(cfg);
    try {
      scheduler.initScheduler(cfg);
    } catch (err) {
      console.warn('[scheduler] 排程失败（不影响其他功能）：', err.message);
    }
  }
});
