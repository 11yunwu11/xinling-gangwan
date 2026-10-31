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
const { parseFrontmatter } = require('./frontmatter');
const { diaryLine } = require('./diary');
const { embedOne, embedParams } = require('./embedding');
const { chatStream, llmParams } = require('./llm');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');
// 用户自建技能存 data/skills/（同一 md 格式）；内置目录 skills/ 受保护，API 只能增删用户目录
const USER_SKILLS_DIR = () => path.join(store.DATA_DIR, 'skills');

let cached = null;
let cachedStamp = '';

// 目录 mtime 指纹：手动往目录里放/删 md 文件也即刻生效，不必重启（计划书 F7）
function dirStamp() {
  const stamp = (dir) => {
    try {
      return fs.statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  };
  return `${stamp(SKILLS_DIR)}|${stamp(USER_SKILLS_DIR())}`;
}

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
  const stamp = dirStamp();
  if (cached && cachedStamp === stamp) return cached;
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
  cachedStamp = stamp;
  return cached;
}

// 可调用的技能（排除危机指引——它仅供内置 crisis_support 工具读取，非调用型）
function callableSkills() {
  return listSkills().filter((s) => s.name !== 'crisis-response');
}

// 用户文件变动后由路由调用，下一次 listSkills 重新扫盘
function refresh() {
  cached = null;
  cachedStamp = '';
}

function isBuiltinName(name) {
  return listSkills().some((s) => s.builtin && s.name === name);
}

// 新增自定义技能（写 data/skills/<name>.md）。路由层已校验；这里再做一层防御性净化，
// 保证导入等旁路进来的数据也破坏不了 frontmatter 结构
function writeSkill({ name, description, context = 'none', body }) {
  const cleanName = String(name).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(cleanName)) throw new Error(`非法技能名：${name}`);
  const cleanDesc = String(description).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cleanDesc) throw new Error('技能 description 不能为空');
  const cleanContext = ['none', 'knowledge', 'week_diaries', 'previous_diary'].includes(context) ? context : 'none';
  const cleanBody = String(body).replace(/\r\n/g, '\n').trim().slice(0, 8000);
  if (!cleanBody) throw new Error('技能提示词模板不能为空');

  fs.mkdirSync(USER_SKILLS_DIR(), { recursive: true });
  const md = `---\nname: ${cleanName}\ndescription: ${cleanDesc}\ncontext: ${cleanContext}\n---\n\n${cleanBody}\n`;
  fs.writeFileSync(path.join(USER_SKILLS_DIR(), `${cleanName}.md`), md, 'utf8');
  refresh();
  return { name: cleanName, description: cleanDesc, context: cleanContext, body: cleanBody, builtin: false };
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
  return callableSkills().map((s) => ({
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

  const r = await chatStream({
    ...llmParams(cfg),
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

module.exports = { listSkills, callableSkills, skillToolDefs, execSkill, getCrisisGuidance, refresh, isBuiltinName, writeSkill, deleteSkill, clearCustomSkills };
