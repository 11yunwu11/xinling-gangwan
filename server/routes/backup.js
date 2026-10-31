// 导出 / 导入（M5 / F6）：全量数据 + 自定义知识/技能

const express = require('express');
const config = require('../lib/config');
const store = require('../lib/store');
const kb = require('../lib/kb');
const skills = require('../lib/skills');
const chatdigest = require('../lib/chatdigest');

// 数组型列表的 覆盖/合并 双模式收拢（diaries/tasks/reports/chatDigests 同形）
// read()/write() 读写整张列表；keyOf 给出去重键；返回新增条数
function applyListMode({ mode, incoming, read, write, keyOf }) {
  if (mode === 'overwrite') {
    write(incoming);
    return incoming.length;
  }
  const existing = read();
  const seen = new Set(existing.map(keyOf));
  let added = 0;
  for (const item of incoming) {
    const k = keyOf(item);
    if (k === null || k === undefined || seen.has(k)) continue;
    existing.push(item);
    seen.add(k);
    added++;
  }
  write(existing);
  return added;
}

module.exports = () => {
  const router = express.Router();

  router.get('/export', (req, res) => {
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

  router.post('/import', async (req, res) => {
    const data = req.body && req.body.data;
    const mode = req.body && req.body.mode === 'overwrite' ? 'overwrite' : 'merge';
    if (!data || data.app !== 'xinling-gangwan') {
      return res.status(400).json({ error: '这不是心灵港湾的导出文件' });
    }

    const counts = {};

    if (Array.isArray(data.diaries)) {
      counts.diaries = applyListMode({ mode, incoming: data.diaries, read: () => store.listDiaries(), write: (l) => store.setDiaries(l), keyOf: (d) => d.id });
    }
    if (Array.isArray(data.tasks)) {
      counts.tasks = applyListMode({ mode, incoming: data.tasks, read: () => store.listTasks(), write: (l) => store.setTasks(l), keyOf: (t) => t.id });
    }
    if (Array.isArray(data.reports)) {
      counts.reports = applyListMode({ mode, incoming: data.reports, read: () => store.readJsonFile('reports.json', []), write: (l) => store.writeJsonFile('reports.json', l), keyOf: (r) => r.id });
    }
    if (Array.isArray(data.chatDigests)) {
      counts.chatDigests = applyListMode({ mode, incoming: data.chatDigests, read: () => store.readJsonFile('chat_digests.json', []), write: (l) => store.writeJsonFile('chat_digests.json', l), keyOf: (d) => d.dateKey });
    }

    // 对话按天分文件、条目按 at|role 签名去重（形状特殊，单独处理）
    if (data.chats && typeof data.chats === 'object') {
      counts.chats = 0;
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

    // 自定义技能（内置技能不参与导入导出；writeSkill 内部有防御性净化，非法条目跳过）
    if (Array.isArray(data.customSkills)) {
      counts.customSkills = 0;
      if (mode === 'overwrite') skills.clearCustomSkills();
      const existingNames = new Set(skills.listSkills().map((s) => s.name));
      for (const s of data.customSkills) {
        const name = String((s && s.name) || '').trim().toLowerCase();
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) continue;
        if (skills.isBuiltinName(name)) continue;
        if (mode === 'merge' && existingNames.has(name)) continue;
        const description = String((s && s.description) || '').trim();
        const body = String((s && s.body) || '').trim();
        if (!description || !body) continue;
        try {
          skills.writeSkill({
            name,
            description: description.slice(0, 120),
            context: (s && s.context) || 'none',
            body: body.slice(0, 8000),
          });
          counts.customSkills++;
        } catch {
          /* 净化后仍非法的条目跳过 */
        }
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

  return router;
};
