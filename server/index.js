const path = require('path');
const express = require('express');
const config = require('./lib/config');
const store = require('./lib/store');
const time = require('./lib/time');
const kb = require('./lib/kb');
const skills = require('./lib/skills');
const mcp = require('./lib/mcp');
const { embedOne, embedParams } = require('./lib/embedding');
const { saveDiary, diaryEmbedText } = require('./lib/diary');
const { handleUserMessage, regenerateResponse } = require('./lib/agent');
const tasksLib = require('./lib/tasks');
const comfort = require('./lib/comfort');
const review = require('./lib/review');
const scheduler = require('./lib/scheduler');
const chatdigest = require('./lib/chatdigest');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(config.ROOT, 'public')));

app.get('/api/health', (req, res) => {
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

/* ---------- 配置（首启配置窗口 / ⚙ 设置） ---------- */

// 只返回可公开回显的字段，绝不含 apiKey（对话模型与 embedding 都不回显 key）
app.get('/api/config/public', (req, res) => {
  const cfg = config.get();
  const emb = embedParams(cfg);
  res.json({
    configured: config.isConfigured(cfg),
    model: cfg.llm && cfg.llm.model,
    baseUrl: cfg.llm && cfg.llm.baseUrl,
    embeddingModel: emb.model,
    embeddingBaseUrl: (cfg.embedding && cfg.embedding.baseUrl) || '',
    embeddingSeparate: !!(cfg.embedding && (cfg.embedding.baseUrl || cfg.embedding.apiKey || cfg.embedding.model)),
    wakeTime: cfg.wakeTime,
  });
});

app.post('/api/config', (req, res) => {
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
  }
  res.json({ ok: true, configured: config.isConfigured(saved) });
});

/* ---------- 晨间安抚（M4） ---------- */

// 兜底 pull：当日缺失且已配置则现场生成（C6）
app.get('/api/comfort', async (req, res) => {
  const c = config.get();
  if (!config.isConfigured(c)) return res.json({ available: false });
  try {
    const s = await comfort.ensureComfort(c);
    res.json({ available: true, key: s.key, text: s.text, read: !!s.read });
  } catch (err) {
    res.status(502).json({ error: err.message || '安抚生成失败' });
  }
});

app.post('/api/comfort/read', (req, res) => {
  res.json(comfort.markRead() || { ok: false });
});

/* ---------- 回顾与分析（M5 / F9） ---------- */

app.get('/api/stats', (req, res) => {
  res.json({ ...review.computeStats(), todayKey: time.currentLogicalKey(config.get().wakeTime) });
});

app.get('/api/report', (req, res) => {
  res.json(review.latestReport());
});

app.post('/api/report', async (req, res) => {
  const c = config.get();
  if (!config.isConfigured(c)) return res.status(400).json({ error: '请先完成配置' });
  try {
    res.json(await review.generateWeeklyReport(c));
  } catch (err) {
    res.status(502).json({ error: err.message || '周报生成失败' });
  }
});

/* ---------- 导出 / 导入（M5 / F6） ---------- */

app.get('/api/export', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="xinling-gangwan-export.json"');
  res.json({
    app: 'xinling-gangwan',
    version: 1,
    exportedAt: new Date().toISOString(),
    diaries: store.listDiaries(),
    tasks: store.listTasks(),
    chats: store.readAllChats(),
    chatDigests: chatdigest.listDigests(),
    reports: store.readJsonFile('reports.json', []),
    // 自定义知识卡片/技能（内置内容在仓库里，随代码分发，不进导出）
    customKnowledge: kb.readCards().filter((c) => !c.builtin).map(({ builtin, ...rest }) => rest),
    customSkills: skills.listSkills().filter((s) => !s.builtin).map(({ builtin, ...rest }) => rest),
  });
});

app.post('/api/import', async (req, res) => {
  const data = req.body && req.body.data;
  const mode = req.body && req.body.mode === 'overwrite' ? 'overwrite' : 'merge';
  if (!data || data.app !== 'xinling-gangwan') {
    return res.status(400).json({ error: '这不是心灵港湾的导出文件' });
  }

  const counts = { diaries: 0, tasks: 0, chats: 0, reports: 0 };

  if (Array.isArray(data.diaries)) {
    if (mode === 'overwrite') {
      store.setDiaries(data.diaries);
      counts.diaries = data.diaries.length;
    } else {
      const existing = new Set(store.listDiaries().map((d) => d.id));
      const merged = store.listDiaries();
      for (const d of data.diaries) {
        if (!existing.has(d.id)) {
          merged.push(d);
          existing.add(d.id);
          counts.diaries++;
        }
      }
      store.setDiaries(merged);
    }
  }

  if (Array.isArray(data.tasks)) {
    if (mode === 'overwrite') {
      store.setTasks(data.tasks);
      counts.tasks = data.tasks.length;
    } else {
      const existing = new Set(store.listTasks().map((t) => t.id));
      const merged = store.listTasks();
      for (const t of data.tasks) {
        if (!existing.has(t.id)) {
          merged.push(t);
          existing.add(t.id);
          counts.tasks++;
        }
      }
      store.setTasks(merged);
    }
  }

  if (data.chats && typeof data.chats === 'object') {
    if (mode === 'overwrite') {
      store.writeAllChats(data.chats);
      counts.chats = Object.keys(data.chats).length;
    } else {
      const all = store.readAllChats();
      for (const [key, msgs] of Object.entries(data.chats)) {
        const existing = all[key] || [];
        const seen = new Set(existing.map((m) => `${m.at}|${m.role}`));
        const toAdd = msgs.filter((m) => !seen.has(`${m.at}|${m.role}`));
        all[key] = [...existing, ...toAdd];
        if (toAdd.length) counts.chats++;
      }
      store.writeAllChats(all);
    }
  }

  if (Array.isArray(data.reports)) {
    if (mode === 'overwrite') {
      store.writeJsonFile('reports.json', data.reports);
      counts.reports = data.reports.length;
    } else {
      const existing = new Set(store.readJsonFile('reports.json', []).map((r) => r.id));
      const merged = [...store.readJsonFile('reports.json', [])];
      for (const r of data.reports) {
        if (!existing.has(r.id)) {
          merged.push(r);
          existing.add(r.id);
          counts.reports++;
        }
      }
      store.writeJsonFile('reports.json', merged);
    }
  }

  if (Array.isArray(data.chatDigests)) {
    if (mode === 'overwrite') {
      store.writeJsonFile('chat_digests.json', data.chatDigests);
      counts.chatDigests = data.chatDigests.length;
    } else {
      const existing = new Set(store.readJsonFile('chat_digests.json', []).map((d) => d.dateKey));
      const merged = [...store.readJsonFile('chat_digests.json', [])];
      for (const d of data.chatDigests) {
        if (!existing.has(d.dateKey)) {
          merged.push(d);
          existing.add(d.dateKey);
          counts.chatDigests++;
        }
      }
      store.writeJsonFile('chat_digests.json', merged);
    }
  }

  // 自定义知识卡片（内置卡片在仓库里，不参与导入导出）
  let kbChanged = false;
  if (Array.isArray(data.customKnowledge)) {
    counts.customKnowledge = 0;
    if (mode === 'overwrite') kb.clearCustomCards();
    const existingIds = new Set(kb.readCards().filter((c) => !c.builtin).map((c) => c.id));
    for (const c of data.customKnowledge) {
      const title = String((c && c.title) || '').trim();
      const text = String((c && c.text) || '').trim();
      if (!title || !text) continue;
      if (mode === 'merge' && c.id && existingIds.has(c.id)) continue;
      kb.writeCard({
        id: c.id,
        title: title.slice(0, 60),
        tags: Array.isArray(c.tags) ? c.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6) : [],
        text: text.slice(0, 5000),
      });
      counts.customKnowledge++;
      kbChanged = true;
    }
  }

  // 自定义技能（内置技能不参与导入导出；重名/非法条目跳过）
  if (Array.isArray(data.customSkills)) {
    counts.customSkills = 0;
    if (mode === 'overwrite') skills.clearCustomSkills();
    const existingNames = new Set(skills.listSkills().map((s) => s.name));
    for (const s of data.customSkills) {
      const name = String((s && s.name) || '').trim().toLowerCase();
      const description = String((s && s.description) || '').trim();
      const body = String((s && s.body) || '').trim();
      const context = String((s && s.context) || 'none').trim();
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || !description || !body) continue;
      if (skills.isBuiltinName(name)) continue;
      if (mode === 'merge' && existingNames.has(name)) continue;
      skills.writeSkill({
        name,
        description: description.slice(0, 120),
        context: ['none', 'knowledge', 'week_diaries', 'previous_diary'].includes(context) ? context : 'none',
        body: body.slice(0, 8000),
      });
      counts.customSkills++;
    }
  }

  // 自定义卡片有变动 → 重新向量化知识库（失败不阻塞导入，下次启动会再对齐）
  let kbRebuild = null;
  if (kbChanged) {
    try {
      kbRebuild = await kb.ensureKb(config.get());
    } catch (err) {
      kbRebuild = { error: err.message };
    }
  }

  res.json({ ok: true, mode, counts, kbRebuild });
});

/* ---------- 聊天记录本地浏览 ---------- */

// 有聊天记录的日子列表（新的在前）
app.get('/api/chats', (req, res) => {
  const all = store.readAllChats();
  const list = Object.keys(all)
    .filter((k) => k && k !== 'null' && (all[k] || []).length)
    .sort()
    .reverse()
    .map((k) => ({ key: k, count: all[k].length }));
  res.json(list);
});

// 当前逻辑日的对话（刷新页面后自动载入）
app.get('/api/chats/current', (req, res) => {
  const cfg = config.get();
  const key = time.currentLogicalKey(cfg.wakeTime);
  res.json({ key, messages: store.readChat(key) });
});

// 指定日期的对话（只读回看）
app.get('/api/chats/:key', (req, res) => {
  const key = req.params.key;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return res.status(400).json({ error: '日期格式不对' });
  res.json({ key, messages: store.readChat(key) });
});

// 切换某条回应的多版本（重新 roll 留下的历史版本之间来回看）
// body: { dir: 'prev'|'next' }（越界环绕）或 { to: <版本序号> }
app.post('/api/chats/:key/message/:index/variant', (req, res) => {
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

/* ---------- 任务 ---------- */

app.get('/api/tasks', (req, res) => {
  tasksLib.ensureDailyTask(config.get()); // 每天首次访问时生成今日随机任务（F5）
  res.json(store.listTasks().slice().reverse()); // 新的在前
});

// 打卡完成 + AI 鼓励语
app.post('/api/tasks/:id/complete', async (req, res) => {
  const task = await tasksLib.completeTask(req.params.id, config.get());
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

/* ---------- 日记（MA2） ---------- */

app.get('/api/diaries', (req, res) => {
  // 不把向量发给前端
  const diaries = store
    .listDiaries()
    .slice()
    .reverse()
    .map(({ embedding, ...rest }) => rest);
  res.json(diaries);
});

app.post('/api/diary', async (req, res) => {
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
app.delete('/api/diaries/:id', (req, res) => {
  const ok = store.deleteDiary(req.params.id);
  if (!ok) return res.status(404).json({ error: '日记不存在' });
  res.json({ ok: true });
});

/* ---------- 知识库可视化 ---------- */

// 卡片列表（不含向量）——能力页展示用
app.get('/api/kb', (req, res) => {
  const kbData = store.readKb();
  const entries = kbData ? kbData.entries : [];
  res.json({
    built: !!kbData,
    count: entries.length,
    cards: entries.map(({ embedding, ...rest }) => rest),
  });
});

// 新增自定义知识卡片（内置卡片受保护，本接口只写 data/knowledge/）
app.post('/api/kb/cards', async (req, res) => {
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
app.delete('/api/kb/cards/:id', async (req, res) => {
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

/* ---------- 自定义技能 ---------- */

const SKILL_CONTEXTS = ['none', 'knowledge', 'week_diaries', 'previous_diary'];

// 新增自定义技能（写 data/skills/<name>.md）；内置技能受保护且不可重名
app.post('/api/skills', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().toLowerCase();
  const description = String(b.description || '').trim();
  const context = String(b.context || 'none').trim();
  const body = String(b.body || '').replace(/\r\n/g, '\n').trim();

  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    return res.status(400).json({ error: '技能名要以小写字母开头，只能含小写英文、数字、- 和 _（最长 32 位）' });
  }
  if (skills.isBuiltinName(name)) return res.status(400).json({ error: `「${name}」是内置技能，不能重名（内置技能不可覆盖）` });
  if (!description || description.includes('\n') || description.length > 120) {
    return res.status(400).json({ error: '调用时机描述必填、单行、不超过 120 字（模型据此决定何时调用）' });
  }
  if (!SKILL_CONTEXTS.includes(context)) return res.status(400).json({ error: '上下文类型不合法' });
  if (!body) return res.status(400).json({ error: '提示词模板不能为空' });
  if (body.length > 8000) return res.status(400).json({ error: '提示词模板不能超过 8000 字' });

  const skill = skills.writeSkill({ name, description, context, body });
  res.json({ ok: true, skill });
});

// 删除自定义技能；内置技能永远删不掉（安全兜底）
app.delete('/api/skills/:name', (req, res) => {
  const ok = skills.deleteSkill(req.params.name);
  if (!ok) return res.status(404).json({ error: '技能不存在，或这是内置技能（内置内容不可删除）' });
  res.json({ ok: true });
});

/* ---------- 能力面板（MA3） ---------- */

app.get('/api/abilities', (req, res) => {
  res.json({
    skills: skills.listSkills()
      .filter((s) => s.name !== 'crisis-response')
      .map((s) => ({ tool: `skill_${s.name}`, name: s.name, description: s.description, builtin: !!s.builtin })),
    mcpTools: mcp.listMcpToolsForUi(),
    builtin: ['add_task', 'get_time_info', 'crisis_support'],
  });
});

// 对话接口：SSE 流式返回 agent 事件
// { text } 正常发言；{ regenerate: true } 重新生成（回到最近一条用户消息重跑，替换其后的旧回应）
app.post('/api/chat', async (req, res) => {
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
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

  try {
    if (regenerate) {
      await regenerateResponse(send);
    } else {
      await handleUserMessage(text, send);
    }
  } catch (err) {
    send({ type: 'error', message: err.message || '服务内部错误' });
  }
  res.end();
});

/* ---------- 启动 ---------- */

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

const cfg = config.get();
const port = Number(cfg.port) || 3000;
app.listen(port, () => {
  console.log('────────────────────────────────────────────');
  console.log('  心灵港湾 已启动 🌊');
  console.log(`  本机访问   http://localhost:${port}`);
  console.log('  手机访问   http://<本机IP>:' + port + ' （同一 WiFi）');
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
