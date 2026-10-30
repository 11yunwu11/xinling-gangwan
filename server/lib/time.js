// 逻辑日换算（约束 C6）：
// 逻辑日 = 起床时间(wakeTime) 至次日起床时间。
// 凌晨（起床时间之前）写入的内容归属"前一逻辑日"，夜班工作者设 16:00 也同样成立。

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(d) {
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 计算包含 now 的逻辑日 [start, end)
function bounds(now, wakeTime) {
  const [h, m] = String(wakeTime || '07:00').split(':').map(Number);
  const start = new Date(now);
  start.setHours(h || 0, m || 0, 0, 0);
  if (now.getTime() < start.getTime()) {
    start.setDate(start.getDate() - 1); // 还没到今天的起床时间 → 属于从昨天开始的逻辑日
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function currentLogicalKey(wakeTime, now = new Date()) {
  return fmtDate(bounds(now, wakeTime).start);
}

function getTimeInfo(wakeTime, now = new Date()) {
  const cur = bounds(now, wakeTime);
  const prevStart = new Date(cur.start);
  prevStart.setDate(prevStart.getDate() - 1);
  const prevEnd = new Date(cur.end);
  prevEnd.setDate(prevEnd.getDate() - 1);

  const pack = (s, e) => ({ start: fmtDateTime(s), end: fmtDateTime(e), key: fmtDate(s) });

  return {
    now: `${fmtDateTime(now)}:${pad(now.getSeconds())}`,
    date: fmtDate(now),
    weekday: WEEKDAYS[now.getDay()],
    wakeTime: wakeTime || '07:00',
    currentLogicalDay: pack(cur.start, cur.end),
    previousLogicalDay: pack(prevStart, prevEnd),
  };
}

module.exports = { getTimeInfo, currentLogicalKey };
