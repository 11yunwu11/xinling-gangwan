// 每日任务（计划书 F5）：任务池外置在 task-pool.json（可自行增删），
// 按"逻辑日"确定性抽取——同一天永远是同一个任务，第二天自动换新（避免连续重复）。

const fs = require('fs');
const path = require('path');
const store = require('./store');
const time = require('./time');
const { chatStream } = require('./llm');

const POOL_PATH = path.join(__dirname, '..', '..', 'task-pool.json');

const FALLBACK_POOL = [
  '在窗户前看一分钟的天空',
  '给自己倒一杯温水，慢慢喝完',
  '伸展身体一分钟，转转肩膀',
];

function loadPool() {
  try {
    const j = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
    const arr = Array.isArray(j) ? j : j.tasks;
    const clean = (arr || []).filter((x) => typeof x === 'string' && x.trim());
    return clean.length ? clean : FALLBACK_POOL;
  } catch {
    return FALLBACK_POOL;
  }
}

// 用日期字符串做种子，保证同一天全平台结果一致
function pickFor(dayKey) {
  const pool = loadPool();
  if (!pool.length) return null;
  let h = 0;
  for (const ch of dayKey) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return pool[h % pool.length];
}

// 惰性生成：当天（按逻辑日）还没有系统任务时创建；由 GET /api/tasks 触发
function ensureDailyTask(cfg) {
  const key = time.currentLogicalKey(cfg.wakeTime);
  const tasks = store.listTasks();
  if (tasks.some((t) => t.source === 'system' && t.date === key)) return null;

  const pool = loadPool();
  let title = pickFor(key);
  if (!title) return null;
  // 池子够大时，避免和最近一次系统任务重复
  const lastSystem = tasks
    .filter((t) => t.source === 'system')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  if (lastSystem && title === lastSystem.title && pool.length > 1) {
    title = pool[(pool.indexOf(title) + 1) % pool.length];
  }
  return store.addTask({ title, date: key, source: 'system' });
}

const FALLBACK_ENCOURAGEMENT = '完成了就是赢！小小的行动也在给心情松绑，为自己点个赞 👏';

// 打卡完成 + AI 鼓励语（生成失败时用兜底文案，打卡永远成功）
async function completeTask(id, cfg) {
  const tasks = store.listTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  if (tasks[idx].status === 'done') return tasks[idx];

  const completedAt = new Date().toISOString();
  let encouragement = FALLBACK_ENCOURAGEMENT;
  try {
    const r = await chatStream({
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      messages: [
        { role: 'system', content: '你是温暖的鼓励者。用户刚完成了一个小任务。输出一到两句话（总共不超过 60 字），真诚、具体、不夸张、不喊口号。' },
        { role: 'user', content: `我刚完成了任务：「${tasks[idx].title}」` },
      ],
    });
    if (r.content && r.content.trim()) encouragement = r.content.trim();
  } catch (err) {
    console.warn('[tasks] 鼓励语生成失败，使用兜底文案：', err.message);
  }

  store.updateTask(id, { status: 'done', completedAt, encouragement });
  return store.listTasks().find((t) => t.id === id);
}

module.exports = { ensureDailyTask, completeTask, loadPool };
