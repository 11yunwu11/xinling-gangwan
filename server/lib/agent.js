// Agent 多步循环（计划书 F2 / 约束 C13、C11）：
// - 动态工具注册表：内置工具 + 外挂 Skills（skill_*）+ MCP 工具（mcp_*）
// - 多步循环：调用工具 → 拿到结果 → 继续决策 → 流式输出最终回应
// - RAG 双池检索：对话前对用户消息向量化，命中则分源注入【TA 过去的记录】【心理学参考】
// - 危机两层检测：第一层（关键词）在这里；第二层（LLM 语义）在系统提示词中硬性规定

const config = require('./config');
const store = require('./store');
const time = require('./time');
const rag = require('./rag');
const kb = require('./kb');
const skills = require('./skills');
const mcp = require('./mcp');
const chatdigest = require('./chatdigest');
const { embedOne, embedParams } = require('./embedding');
const { chatStream, llmParams } = require('./llm');

const MAX_ROUNDS = 8;

const BUILTIN_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'add_task',
      description:
        '为用户写入一条任务/约定。当用户明确表达想为自己设定任务或约定（例如"设定一个任务，我要…"）时调用。任务要写清楚、可执行、一句话。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务内容，一句话、可执行' },
          date: { type: 'string', description: '归属日期 YYYY-MM-DD，默认当前逻辑日，一般无需填写' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time_info',
      description: '获取当前日期时间、星期，以及按用户起床时间换算的当前/上一逻辑日窗口。当需要确认"今天/昨天"等时间语义时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crisis_support',
      description:
        '当用户流露自伤、轻生或伤害自己的念头（包括委婉表达，如"我消失了会更好"）时必须调用；调用后按返回的指引给予温暖关怀的回应。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function detectCrisis(text, cfg) {
  const words = (cfg.crisisKeywords && cfg.crisisKeywords.length
    ? cfg.crisisKeywords
    : ['想死', '不想活', '自杀', '轻生']);
  return words.some((w) => w && String(text).includes(w));
}

function buildSystemPrompt(cfg, crisis, ragContext) {
  const info = time.getTimeInfo(cfg.wakeTime);

  const extras = [
    ...skills.callableSkills().map((s) => `- skill_${s.name}（技能）：${s.description}`),
    ...mcp.listMcpToolDefs().map((t) => `- ${t.function.name}（外部工具）：${t.function.description}`),
  ];

  return [
    '你是「心灵港湾」的树洞伙伴，一个温暖、真诚、不评判的倾听者。用户在这里记录情绪、倾诉心事。',
    '',
    '基本原则：',
    '- 先共情、接住情绪，再在对方需要时提供视角；不评判、不说教。',
    '- 不做心理诊断、不给医疗建议；必要时温和地建议寻求专业帮助。',
    '- 回应简短自然，像朋友聊天，不刷屏、不堆列表。',
    '- 用户提到"今天/昨天/这周"时，以下面的时间信息为准；不确定时调用 get_time_info。',
    '',
    '当前时间信息（来自服务端时钟）：',
    JSON.stringify(info, null, 2),
    '',
    '内置工具：add_task（用户明确想设定任务/约定时调用）、get_time_info（确认时间语义）、crisis_support（用户流露自伤/轻生念头时必须立即调用）。',
    extras.length ? `你还可以调用以下能力（是否使用由你判断，不要机械调用）：\n${extras.join('\n')}` : '',
    ragContext ? `\n以下是检索到的相关背景，供你自然地化用（引用过去的事要像"记得"，不要像念档案）：\n\n${ragContext}` : '',
    crisis
      ? '\n【危机提示】刚才的用户消息命中了危机关键词。你必须立即调用 crisis_support 工具，然后：若结合上下文判断是习语或玩笑（如"累死了"），自然轻松地回应即可（求助资源卡片已由界面展示）；若判断是真实风险，按危机回应原则回应：不评判、不追问细节、先接住情绪、温和确认 TA 现在是否安全、鼓励联系信任的人或专业援助，绝不美化或回避。'
      : '',
  ]
    .filter((x) => x && x.length)
    .join('\n');
}

async function execTool(name, argsJson, { cfg, userText, onEvent }) {
  let args = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    /* 参数解析失败按空参数处理 */
  }

  if (name === 'add_task') {
    const title = String(args.title || '').trim();
    if (!title) return { ok: false, error: '任务内容为空' };
    const task = store.addTask({
      title,
      date: args.date || time.currentLogicalKey(cfg.wakeTime),
      source: 'agent',
    });
    return { ok: true, task };
  }

  if (name === 'get_time_info') {
    return time.getTimeInfo(cfg.wakeTime);
  }

  if (name === 'crisis_support') {
    const hotlines = cfg.hotlines || [];
    onEvent({ type: 'crisis', hotlines });
    return { ok: true, hotlines, guidance: skills.getCrisisGuidance() };
  }

  if (name.startsWith('skill_')) {
    return skills.execSkill(name, { cfg, userText, onEvent });
  }

  if (name.startsWith('mcp_')) {
    return mcp.execMcpTool(name, argsJson);
  }

  return { ok: false, error: `未知工具：${name}` };
}

// 对话前 RAG：用户消息向量化 → 双池检索 → 分源拼装（失败静默跳过，不阻塞对话）
async function retrieveContext(cfg, userText) {
  try {
    const qvec = await embedOne(embedParams(cfg), userText);
    const result = rag.retrieveBoth({
      diaries: [
        ...store.listDiaries().map((d) => ({
          dateKey: d.dateKey,
          text: d.text,
          summary: d.summary,
          embedding: d.embedding,
        })),
        // 聊天小结进入同一记忆池（标注"树洞对话小结"）
        ...chatdigest.listDigests().map((d) => ({
          dateKey: d.dateKey,
          text: `（树洞对话小结）${d.text}`,
          embedding: d.embedding,
        })),
      ],
      kb: kb.loadKb(),
      queryVec: qvec,
      topK: (cfg.rag && cfg.rag.topK) || 3,
      threshold: (cfg.rag && cfg.rag.threshold) || 0.3,
    });
    return rag.formatForPrompt(result);
  } catch (err) {
    console.warn('[rag] 检索跳过：', err.message);
    return '';
  }
}

function ensureConfigured(cfg) {
  const { apiKey } = cfg.llm || {};
  if (!apiKey || apiKey.includes('填入')) {
    throw new Error('尚未配置 API Key：请在 ⚙ 设置里填入你的 Key（保存到本地 config.json）');
  }
}

// 生成主体：RAG 检索 → 多步循环 → 最终回应落盘。发送与重新生成共用。
// rerollIndex：对指定下标的 assistant 消息"重 roll"——新回应作为新版本追加进它的 variants，
// content 指向最新版本；不传则作为新消息追加。
async function runAgent({ cfg, logicalKey, userText, onEvent, crisis, rerollIndex }) {
  const history = store.readChat(logicalKey).slice(-30);

  onEvent({ type: 'status', text: '翻翻记忆…' });
  const ragContext = await retrieveContext(cfg, userText);

  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg, crisis, ragContext) },
    ...history,
  ];
  const tools = [...BUILTIN_TOOL_DEFS, ...skills.skillToolDefs(), ...mcp.listMcpToolDefs()];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    onEvent({ type: 'status', text: round === 0 ? '树洞在听…' : '整理一下…' });

    const r = await chatStream({
      ...llmParams(cfg),
      messages,
      tools,
      onDelta: (t) => onEvent({ type: 'delta', text: t }),
    });

    if (r.toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: r.content || '',
        tool_calls: r.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        })),
      });
      for (const tc of r.toolCalls) {
        onEvent({ type: 'tool', name: tc.name });
        let result;
        try {
          result = await execTool(tc.name, tc.args, { cfg, userText, onEvent });
        } catch (err) {
          result = { ok: false, error: err.message || '工具执行失败' };
        }
        // 任务分解：技能返回任务数组 → agent 逐条写入（编排）
        if (tc.name === 'skill_task_planning' && result.ok && Array.isArray(result.tasks)) {
          const added = [];
          for (const title of result.tasks) {
            const task = store.addTask({
              title,
              date: time.currentLogicalKey(cfg.wakeTime),
              source: 'agent',
            });
            onEvent({ type: 'tool', name: 'add_task' });
            added.push(task.title);
          }
          result = { ok: true, addedCount: added.length, added };
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue; // 带着工具结果进入下一轮决策
    }

    if (Number.isInteger(rerollIndex)) {
      const slot = store.readChat(logicalKey)[rerollIndex];
      const variants = [...((slot && slot.variants) || [slot.content]), r.content];
      store.updateChatMessage(logicalKey, rerollIndex, {
        content: r.content,
        variants,
        variantIndex: variants.length - 1,
        at: new Date().toISOString(),
      });
      onEvent({ type: 'done', messageIndex: rerollIndex, variantIndex: variants.length - 1, variantTotal: variants.length });
    } else {
      const msgs = store.readChat(logicalKey);
      store.appendChat(logicalKey, { role: 'assistant', content: r.content, variants: [r.content], variantIndex: 0 });
      onEvent({ type: 'done', messageIndex: msgs.length, variantIndex: 0, variantTotal: 1 });
    }
    return r.content;
  }

  throw new Error('对话轮次超出上限，请稍后再试');
}

async function handleUserMessage(userText, onEvent) {
  const cfg = config.get();
  ensureConfigured(cfg);

  const crisis = detectCrisis(userText, cfg);
  if (crisis) onEvent({ type: 'crisis', hotlines: cfg.hotlines || [] });

  const logicalKey = time.currentLogicalKey(cfg.wakeTime);
  store.appendChat(logicalKey, { role: 'user', content: userText });

  return runAgent({ cfg, logicalKey, userText, onEvent, crisis });
}

// 重新生成（重新 roll）：回到当前逻辑日最近一条用户消息。若其后已有回应，则对它 reroll
// 并保留旧版本（多版本之间可来回切换）；若其后有其他残留（报错本就不落盘，正常为空）则清掉。
// 生成失败时错误不落盘，所以"有消息没回应"和"对旧回应不满意"走的是同一条路。
async function regenerateResponse(onEvent) {
  const cfg = config.get();
  ensureConfigured(cfg);

  const logicalKey = time.currentLogicalKey(cfg.wakeTime);
  const msgs = store.readChat(logicalKey);
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) throw new Error('这条对话里还没有你的消息，先说点什么吧');

  const userText = msgs[lastUser].content;
  const rerollIndex = msgs.length === lastUser + 2 && msgs[lastUser + 1].role === 'assistant'
    ? lastUser + 1
    : null;
  if (rerollIndex === null && msgs.length > lastUser + 1) store.writeChat(logicalKey, msgs.slice(0, lastUser + 1));

  const crisis = detectCrisis(userText, cfg);
  if (crisis) onEvent({ type: 'crisis', hotlines: cfg.hotlines || [] });

  return runAgent({ cfg, logicalKey, userText, onEvent, crisis, rerollIndex });
}

module.exports = { handleUserMessage, regenerateResponse, detectCrisis };
