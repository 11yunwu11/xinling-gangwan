// 聊天记忆沉淀（2026-10-19 需求方选定方案 B / 计划书 F3 扩展）：
// - 每天在起床时间的定时任务里，把"昨天"的树洞对话浓缩成小结并向量化入库
// - 服务启动时补算漏掉的天（服务没开机也不会丢）
// - 小结进入 RAG 记忆池（标注"树洞对话小结"），树洞跨天能记住聊过的内容
// - 存储：data/chat_digests.json（每周报保持只读日记，不受影响）

const store = require('./store');
const time = require('./time');
const { embedOne, embedParams } = require('./embedding');
const { chatStream } = require('./llm');

function readDigests() {
  return store.readJsonFile('chat_digests.json', []);
}

function writeDigests(list) {
  store.writeJsonFile('chat_digests.json', list);
}

// 待小结的逻辑日：今天之前、有用户发言、尚未小结
function pendingKeys(cfg) {
  const todayKey = time.currentLogicalKey(cfg.wakeTime);
  const digested = new Set(readDigests().map((d) => d.dateKey));
  const all = store.readAllChats();
  return Object.keys(all)
    .filter(
      (k) =>
        k &&
        k !== 'null' &&
        k < todayKey &&
        !digested.has(k) &&
        (all[k] || []).some((m) => m.role === 'user')
    )
    .sort();
}

function buildTranscript(msgs) {
  return msgs
    .map((m) => `${m.role === 'user' ? 'TA' : '树洞'}：${String(m.content || '').slice(0, 150)}`)
    .join('\n')
    .slice(0, 3000);
}

async function digestDay(cfg, key) {
  const msgs = store.readChat(key);
  if (!msgs.some((m) => m.role === 'user')) return null;

  const r = await chatStream({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    messages: [
      {
        role: 'system',
        content:
          '你是对话归档助手。把一天的树洞对话浓缩成一段客观、温和的小结（120 字以内），供未来的树洞回忆"那天聊过什么"。用第三人称"TA"称呼用户，只输出小结正文，不要评价和建议。',
      },
      { role: 'user', content: `这是 ${key} 的对话记录：\n${buildTranscript(msgs)}\n\n请输出当天对话小结。` },
    ],
  });

  const text = r.content.trim();
  const embedding = await embedOne(embedParams(cfg), `[${key} 聊天小结] ${text}`);

  const digest = {
    id: `chat-${key}`,
    dateKey: key,
    text,
    embedding,
    createdAt: new Date().toISOString(),
  };
  const list = readDigests().filter((d) => d.dateKey !== key);
  list.push(digest);
  writeDigests(list);
  return digest;
}

// 补算所有漏掉的天（cron 每日触发 + 启动时触发）
async function digestPending(cfg) {
  const results = [];
  for (const key of pendingKeys(cfg)) {
    try {
      const d = await digestDay(cfg, key);
      if (d) {
        results.push(d);
        console.log(`[chatdigest] ${key} 的对话已沉淀为记忆`);
      }
    } catch (err) {
      console.warn(`[chatdigest] ${key} 小结失败（下次启动重试）：`, err.message);
    }
  }
  return results;
}

module.exports = { digestPending, digestDay, listDigests: readDigests };
