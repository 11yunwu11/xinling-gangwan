// 晨间安抚（M4 / 约束 C6、计划书 F4）：
// - node-cron 在每日起床时间预生成（scheduler.js 调度）
// - 打开网站时 GET /api/comfort 兜底：当日缺失且已配置则现场生成
// - 当日已读标记；数据存 data/comfort.json

const store = require('./store');
const time = require('./time');
const skills = require('./skills');

const FALLBACK_TEXT = '早上好，新的一天。愿你被温柔对待，也温柔对待自己。今天也允许自己慢慢来。';

function readState() {
  return store.readJsonFile('comfort.json', null);
}

function writeState(state) {
  store.writeJsonFile('comfort.json', state);
  return state;
}

// 生成（或复用）当前逻辑日的安抚语
async function ensureComfort(cfg) {
  const key = time.currentLogicalKey(cfg.wakeTime);
  const existing = readState();
  if (existing && existing.key === key) return existing;

  let text = FALLBACK_TEXT;
  try {
    const r = await skills.execSkill('skill_morning_comfort', { cfg, userText: '早安，给我今天的安抚吧' });
    if (r.ok && r.result && r.result.trim()) text = r.result.trim();
  } catch (err) {
    console.warn('[comfort] 生成失败，使用兜底文案：', err.message);
  }

  return writeState({ key, text, generatedAt: new Date().toISOString(), read: false });
}

function markRead() {
  const s = readState();
  if (!s) return null;
  return writeState({ ...s, read: true });
}

module.exports = { ensureComfort, markRead };
