// 回顾与分析（M5 / 约束 C12、计划书 F9）：
// - 统计全部由代码确定性计算（情绪标签 / 高频主题 / 按日聚合）
// - AI 周报：复用 skill_weekly_review（只归纳用户自己的记录 + 知识库参考，不诊断），存 data/reports.json

const store = require('./store');
const time = require('./time');
const skills = require('./skills');
const kb = require('./kb');
const rag = require('./rag');
const { diaryLine } = require('./diary');
const { embedOne, embedParams } = require('./embedding');

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
  return diaries.map(diaryLine).join('\n');
}

// C12：周报 = RAG 本周日记 + 知识库参考。按本周记录的摘要做知识库检索，附相关卡片
async function knowledgeContextFor(cfg, weekDiaries) {
  if (!weekDiaries.length) return '';
  try {
    const query = weekDiaries
      .map((d) => `${(d.summary && d.summary.emotions || []).join(' ')} ${(d.summary && d.summary.theme) || ''} ${d.text}`)
      .join('\n')
      .slice(0, 1000);
    const qvec = await embedOne(embedParams(cfg), query);
    const hits = rag.topK(kb.loadKb(), qvec, 2, (cfg.rag && cfg.rag.threshold) || 0.3);
    if (!hits.length) return '';
    return ['【心理学参考】（供你归纳时参考，化用而非照抄，不作诊断）', ...hits.map((k) => `- [${k.title}] ${k.text.slice(0, 260)}`)].join('\n');
  } catch (err) {
    console.warn('[review] 知识库检索跳过：', err.message);
    return '';
  }
}

async function generateWeeklyReport(cfg) {
  const weekDiaries = (() => {
    const keys = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      keys.push(time.currentLogicalKey(cfg.wakeTime, d));
    }
    return store.listDiaries().filter((d) => keys.includes(d.dateKey));
  })();

  const diaryContext = lastSevenDaysContext(cfg);
  const knowledgeContext = await knowledgeContextFor(cfg, weekDiaries);
  const context = [diaryContext, knowledgeContext].filter(Boolean).join('\n\n');

  const r = await skills.execSkill('skill_weekly_review', {
    cfg,
    userText: '请根据最近 7 天的日记，为我生成本周情绪回顾',
    contextOverride: context,
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
