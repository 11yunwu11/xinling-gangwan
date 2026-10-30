// Skill 系统（MA3 / 约束 C13）：外挂技能文件（skills/*.md）→ 注册为 agent 可调用的工具
// "外挂"体现在：新增一个 md 文件并重启，agent 就多一个能力，无需改代码。
//
// frontmatter 字段：
//   name:        工具名（注册为 skill_<name>）
//   description: 何时调用（会作为工具 description 交给模型）
//   context:     none | knowledge | week_diaries | previous_diary（执行时注入 {{context}}）
// 正文为提示词模板，支持 {{user_request}} 占位。

const fs = require('fs');
const path = require('path');
const store = require('./store');
const time = require('./time');
const rag = require('./rag');
const { embedOne, embedParams } = require('./embedding');
const { chatStream } = require('./llm');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');
// 用户自建技能存 data/skills/（同一 md 格式）；内置目录 skills/ 受保护，API 只能增删用户目录
const USER_SKILLS_DIR = () => path.join(store.DATA_DIR, 'skills');

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

let cached = null;

function readDirSkills(dir, builtin) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        name: meta.name || f.replace(/\.md$/, ''),
        description: meta.description || '',
        context: meta.context || 'none',
        body,
        builtin,
      };
    });
}

function listSkills() {
  if (cached) return cached;
  const builtins = readDirSkills(SKILLS_DIR, true);
  const builtinNames = new Set(builtins.map((s) => s.name));
  // 自定义技能与内置重名时忽略（内置优先，防止覆盖危机兜底等关键技能）
  const users = readDirSkills(USER_SKILLS_DIR(), false).filter((s) => {
    if (builtinNames.has(s.name)) {
      console.warn(`[skills] 自定义技能「${s.name}」与内置技能重名，已忽略`);
      return false;
    }
    return true;
  });
  cached = [...builtins, ...users];
  return cached;
}

// 用户文件变动后由路由调用，下一次 listSkills 重新扫盘
function refresh() {
  cached = null;
}

function isBuiltinName(name) {
  return listSkills().some((s) => s.builtin && s.name === name);
}

// 新增自定义技能（写 data/skills/<name>.md）；name 必须已通过路由层校验
function writeSkill({ name, description, context = 'none', body }) {
  fs.mkdirSync(USER_SKILLS_DIR(), { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\ncontext: ${context}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(USER_SKILLS_DIR(), `${name}.md`), md, 'utf8');
  refresh();
  return { name, description, context, body, builtin: false };
}

// 删除自定义技能；内置目录永不触碰。返回 false = 不是可删的自定义技能
function deleteSkill(name) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) return false;
  const file = path.join(USER_SKILLS_DIR(), `${name}.md`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  refresh();
  return true;
}

// 导入（覆盖模式）用：清空用户技能目录（内置目录不受影响）
function clearCustomSkills() {
  const dir = USER_SKILLS_DIR();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  refresh();
}

// 供内置 crisis_support 工具读取的回应指引
function getCrisisGuidance() {
  const s = listSkills().find((x) => x.name === 'crisis-response');
  return s ? s.body : '先接住情绪，不追问细节；温和确认安全；鼓励联系专业援助或信任的人。';
}

/* ---------- 上下文构建 ---------- */

function diaryLine(d) {
  const s = d.summary || {};
  const tags = (s.emotions || []).join('/');
  const events = (s.keyEvents || []).join('；');
  return `- [${d.dateKey}]${tags ? ` 情绪:${tags}｜` : ''}${events ? ` 事件:${events}｜` : ''}${d.text.slice(0, 160)}`;
}

function previousDiaryContext(cfg) {
  const info = time.getTimeInfo(cfg.wakeTime);
  const key = info.previousLogicalDay.key;
  const diaries = store.listDiaries().filter((d) => d.dateKey === key);
  if (!diaries.length) return `（${key} 的上一逻辑日没有日记记录，请使用通用温柔早安，不要编造"你昨天…"）`;
  return diaries.map(diaryLine).join('\n');
}

function weekDiariesContext(cfg) {
  const diaries = store.listDiaries();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const recent = diaries.filter((d) => new Date(d.createdAt) >= weekAgo);
  if (!recent.length) return '（最近 7 天没有日记记录）';
  return recent.map(diaryLine).join('\n');
}

async function knowledgeContext(cfg, userText) {
  const kb = store.readKb();
  const entries = kb ? kb.entries : [];
  if (!entries.length) return '（知识库为空，请依据通用心理学常识回答，不作诊断）';
  const qvec = await embedOne(embedParams(cfg), userText);
  const hits = rag.topK(entries, qvec, 3, (cfg.rag && cfg.rag.threshold) || 0.3);
  if (!hits.length) return '（知识库未命中相关卡片，请依据通用心理学常识回答，不作诊断）';
  return hits.map((k) => `[${k.title}] ${k.text}`).join('\n\n');
}

/* ---------- 工具注册 ---------- */

function skillToolDefs() {
  return listSkills()
    .filter((s) => s.name !== 'crisis-response') // 危机指引非调用型
    .map((s) => ({
      type: 'function',
      function: {
        name: `skill_${s.name}`,
        description: s.description,
        parameters: { type: 'object', properties: {} },
      },
    }));
}

async function buildSkillContext(skill, cfg, userText) {
  switch (skill.context) {
    case 'knowledge':
      return knowledgeContext(cfg, userText);
    case 'week_diaries':
      return weekDiariesContext(cfg);
    case 'previous_diary':
      return previousDiaryContext(cfg);
    default:
      return '（无）';
  }
}

async function execSkill(toolName, { cfg, userText, onEvent, contextOverride } = {}) {
  const skill = listSkills().find((s) => `skill_${s.name}` === toolName);
  if (!skill) return { ok: false, error: `未知技能 ${toolName}` };

  let context = '（无）';
  if (contextOverride !== undefined) {
    context = contextOverride; // 外部已构建好上下文（如周报使用最近 7 个逻辑日）
  } else {
    try {
      context = await buildSkillContext(skill, cfg, userText);
    } catch (err) {
      console.warn(`[skill:${skill.name}] 上下文构建失败：`, err.message);
      context = '（上下文检索暂不可用，请基于通用常识完成任务，不作诊断）';
    }
  }

  const prompt = skill.body
    .replace(/\{\{context\}\}/g, context)
    .replace(/\{\{user_request\}\}/g, userText || '');

  const { baseUrl, apiKey, model } = cfg.llm;
  const r = await chatStream({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: 'system', content: `你正在执行「${skill.name}」技能。严格按技能指令完成任务。` },
      { role: 'user', content: prompt },
    ],
  });

  // 任务分解技能：解析 JSON 数组，交回 agent 逐条 add_task（编排的展示窗口）
  if (skill.name === 'task_planning') {
    const m = r.content.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr) && arr.length) {
          return { ok: true, tasks: arr.map((x) => String(x.title || x).trim()).filter(Boolean) };
        }
      } catch {
        /* 落回原文返回 */
      }
    }
  }

  return { ok: true, result: r.content.trim() };
}

module.exports = { listSkills, skillToolDefs, execSkill, getCrisisGuidance, refresh, isBuiltinName, writeSkill, deleteSkill, clearCustomSkills };
