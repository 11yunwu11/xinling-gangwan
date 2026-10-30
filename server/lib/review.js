// 回顾与分析（M5 / 约束 C12、计划书 F9）：
// - 统计全部由代码确定性计算（情绪标签 / 高频主题 / 按日聚合）
// - AI 周报：复用 skill_weekly_review（只归纳用户自己的记录，不诊断），存 data/reports.json

const store = require('./store');
const time = require('./time');
const skills = require('./skills');

function computeStats() {
  const diaries = store.listDiaries();
  const tagCount = {};
  const themeCount = {};
  const days = {};

  for (const d of diaries) {
    const s = d.summary || {};
    const day = days[d.dateKey] || (days[d.dateKey] = { count: 0, topEmotion: null });
    day.count += 1;
    for (const e of s.emotions || []) tagCount[e] = (tagCount[e] || 0) + 1;
    if (s.theme) themeCount[s.theme] = (themeCount[s.theme] || 0) + 1;
    const top = (s.emotions || [])[0];
    if (top) day.topEmotion = top;
  }

  const toSorted = (obj) =>
    Object.entries(obj).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    total: diaries.length,
    tags: toSorted(tagCount),
    themes: toSorted(themeCount),
    days,
  };
}

function readReports() {
  return store.readJsonFile('reports.json', []);
}

// 最近 7 个逻辑日（含今天）的日记上下文
function lastSevenDaysContext(cfg) {
  const keys = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(time.currentLogicalKey(cfg.wakeTime, d));
  }
  const diaries = store.listDiaries().filter((d) => keys.includes(d.dateKey));
  if (!diaries.length) return '（最近 7 天没有日记记录）';
  return diaries
    .map((d) => {
      const s = d.summary || {};
      const tags = (s.emotions || []).join('/');
      const events = (s.keyEvents || []).join('；');
      return `- [${d.dateKey}]${tags ? ` 情绪:${tags}｜` : ''}${events ? ` 事件:${events}｜` : ''}${d.text.slice(0, 160)}`;
    })
    .join('\n');
}

async function generateWeeklyReport(cfg) {
  const r = await skills.execSkill('skill_weekly_review', {
    cfg,
    userText: '请根据最近 7 天的日记，为我生成本周情绪回顾',
    contextOverride: lastSevenDaysContext(cfg),
  });
  if (!r.ok || !r.result) throw new Error('周报生成失败');

  const endKey = time.currentLogicalKey(cfg.wakeTime);
  const startD = new Date();
  startD.setDate(startD.getDate() - 6);
  const report = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    rangeStart: time.currentLogicalKey(cfg.wakeTime, startD),
    rangeEnd: endKey,
    text: r.result.trim(),
    generatedAt: new Date().toISOString(),
  };
  const reports = readReports();
  reports.push(report);
  store.writeJsonFile('reports.json', reports);
  return report;
}

function latestReport() {
  const reports = readReports();
  return reports.length ? reports[reports.length - 1] : null;
}

module.exports = { computeStats, generateWeeklyReport, latestReport };
