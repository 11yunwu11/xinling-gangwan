// 日记模块（MA2 / 计划书 F1、F3）：
// 写日记 → LLM 总结出 {情绪标签, 关键事件, 主题} → 存 data/ → 向量化入库（失败存 null 待回填）

const store = require('./store');
const time = require('./time');
const { embedOne, embedParams } = require('./embedding');
const { chatStream } = require('./llm');

function diaryEmbedText(text, summary) {
  const s = summary ? `情绪：${(summary.emotions || []).join('、')}；事件：${(summary.keyEvents || []).join('、')}` : '';
  return `${s}\n${text}`.trim();
}

// 调 LLM 生成结构化总结；解析失败时退化为空总结（正文永远保留）
async function summarizeDiary(cfg, text) {
  const { baseUrl, apiKey, model } = cfg.llm;
  const prompt = [
    '请阅读下面这篇日记，只输出一个 JSON 对象（不要输出任何其他文字），格式：',
    '{"emotions":["情绪词，2~4个，如 低落/焦虑/平静"],"keyEvents":["关键事件，1~3条短句"],"theme":"一个主题词，如 考试/人际/休息"}',
    '',
    '日记内容：',
    text,
  ].join('\n');

  const r = await chatStream({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: 'system', content: '你是情绪日记的总结助手，只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
  });

  const match = r.content.match(/\{[\s\S]*\}/);
  if (!match) return { emotions: [], keyEvents: [], theme: '' };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      emotions: (parsed.emotions || []).slice(0, 4),
      keyEvents: (parsed.keyEvents || []).slice(0, 3),
      theme: parsed.theme || '',
    };
  } catch {
    return { emotions: [], keyEvents: [], theme: '' };
  }
}

// 完整落库流程；embedding 失败不影响日记保存（返回 diary.embedding=null）
async function saveDiary(cfg, text) {
  const dateKey = time.currentLogicalKey(cfg.wakeTime);
  const summary = await summarizeDiary(cfg, text);
  const diary = store.addDiary({ dateKey, text, summary, embedding: null });

  try {
    const embedding = await embedOne(embedParams(cfg), diaryEmbedText(text, summary));
    return store.updateDiary(diary.id, { embedding });
  } catch (err) {
    console.warn('[diary] 向量化失败（日记已保存，将在下次启动时回填）：', err.message);
    return diary;
  }
}

module.exports = { saveDiary, summarizeDiary, diaryEmbedText };
