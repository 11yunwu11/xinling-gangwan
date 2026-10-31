// 自定义技能：新增 / 删除（内置技能受保护）

const express = require('express');
const skills = require('../lib/skills');

const SKILL_CONTEXTS = ['none', 'knowledge', 'week_diaries', 'previous_diary'];

module.exports = () => {
  const router = express.Router();

  // 新增自定义技能（写 data/skills/<name>.md）；内置技能受保护且不可重名
  router.post('/skills', (req, res) => {
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
  router.delete('/skills/:name', (req, res) => {
    const ok = skills.deleteSkill(req.params.name);
    if (!ok) return res.status(404).json({ error: '技能不存在，或这是内置技能（内置内容不可删除）' });
    res.json({ ok: true });
  });

  return router;
};
