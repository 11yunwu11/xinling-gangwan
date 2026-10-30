// 定时调度（M4 / 约束 C6）：node-cron 按用户起床时间执行
// - 每天起床时间：预生成晨间安抚
// - 每逢周一的起床时间：额外生成 AI 本周回顾
// - 修改起床时间（配置窗口保存）后自动重新排程

const cron = require('node-cron');
const comfort = require('./comfort');
const review = require('./review');
const chatdigest = require('./chatdigest');

let jobs = [];

function stopAll() {
  for (const j of jobs) j.stop();
  jobs = [];
}

function initScheduler(cfg) {
  stopAll();
  const [h, m] = String(cfg.wakeTime || '07:00').split(':').map(Number);
  const expr = `${m || 0} ${h || 0} * * *`;

  const job = cron.schedule(expr, () => {
    comfort.ensureComfort(cfg).catch((err) => console.warn('[scheduler] 安抚生成失败：', err.message));
    chatdigest
      .digestPending(cfg)
      .then((rs) => rs.length && console.log(`[scheduler] 已沉淀 ${rs.length} 天的聊天记忆`))
      .catch((err) => console.warn('[scheduler] 聊天沉淀失败：', err.message));
    if (new Date().getDay() === 1) {
      review
        .generateWeeklyReport(cfg)
        .then((r) => console.log(`[scheduler] 本周回顾已生成（${r.rangeStart} ~ ${r.rangeEnd}）`))
        .catch((err) => console.warn('[scheduler] 周报生成失败：', err.message));
    }
  });

  jobs.push(job);
  console.log(`[scheduler] 已排程：每天 ${cfg.wakeTime} 生成晨间安抚；周一额外生成本周回顾`);
  return expr;
}

module.exports = { initScheduler, stopAll };
