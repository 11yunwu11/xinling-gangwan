// data/ 目录 JSON 文件读写（约束 C17）。
// 对话按逻辑日分文件；日记/任务单文件；kb 为构建产物。数据只落在用户自己电脑上。

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------- 任务 ---------- */
const tasksFile = () => path.join(DATA_DIR, 'tasks.json');

function listTasks() {
  return readJson(tasksFile(), []);
}

function addTask({ title, date, source = 'agent' }) {
  const tasks = listTasks();
  const task = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    date,
    source,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  writeJson(tasksFile(), tasks);
  return task;
}

function updateTask(id, patch) {
  const tasks = listTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  tasks[idx] = { ...tasks[idx], ...patch };
  writeJson(tasksFile(), tasks);
  return tasks[idx];
}

/* ---------- 对话（按逻辑日分文件） ---------- */
const chatFile = (logicalKey) => path.join(DATA_DIR, 'chats', `${logicalKey}.json`);

function readChat(logicalKey) {
  return readJson(chatFile(logicalKey), []);
}

function appendChat(logicalKey, msg) {
  const arr = readChat(logicalKey);
  arr.push({ ...msg, at: new Date().toISOString() });
  writeJson(chatFile(logicalKey), arr);
}

function writeChat(logicalKey, messages) {
  writeJson(chatFile(logicalKey), messages);
}

// 原地修改某条消息（重新 roll 的版本替换/切换用）。index 为该逻辑日文件内的下标。
function updateChatMessage(logicalKey, index, patch) {
  const arr = readChat(logicalKey);
  if (!Number.isInteger(index) || index < 0 || index >= arr.length) return null;
  arr[index] = { ...arr[index], ...patch };
  writeJson(chatFile(logicalKey), arr);
  return arr[index];
}

/* ---------- 日记（MA2 记忆库语料） ---------- */
const diariesFile = () => path.join(DATA_DIR, 'diaries.json');

function listDiaries() {
  return readJson(diariesFile(), []);
}

function addDiary({ dateKey, text, summary, embedding }) {
  const diaries = listDiaries();
  const diary = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    dateKey,
    text,
    summary: summary || null,
    embedding: embedding || null, // 向量化失败先存 null，启动时回填
    createdAt: new Date().toISOString(),
  };
  diaries.push(diary);
  writeJson(diariesFile(), diaries);
  return diary;
}

function updateDiary(id, patch) {
  const diaries = listDiaries();
  const idx = diaries.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  diaries[idx] = { ...diaries[idx], ...patch };
  writeJson(diariesFile(), diaries);
  return diaries[idx];
}

function setDiaries(list) {
  writeJson(diariesFile(), list);
}

function deleteDiary(id) {
  const diaries = listDiaries();
  const next = diaries.filter((d) => d.id !== id);
  if (next.length === diaries.length) return false;
  setDiaries(next);
  return true;
}

/* ---------- 通用文件 / 全量读写（导出导入、定时任务状态） ---------- */

function readJsonFile(relName, fallback) {
  return readJson(path.join(DATA_DIR, relName), fallback);
}

function writeJsonFile(relName, data) {
  writeJson(path.join(DATA_DIR, relName), data);
}

function setTasks(list) {
  writeJson(tasksFile(), list);
}

const CHATS_DIR = () => path.join(DATA_DIR, 'chats');

function readAllChats() {
  const dir = CHATS_DIR();
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) out[f.replace(/\.json$/, '')] = readJson(path.join(dir, f), []);
  }
  return out;
}

function writeAllChats(map) {
  ensureDir(CHATS_DIR());
  for (const [key, msgs] of Object.entries(map)) {
    writeJson(path.join(CHATS_DIR(), `${key}.json`), msgs);
  }
}

/* ---------- 知识库（构建产物） ---------- */
const kbFile = () => path.join(DATA_DIR, 'kb.json');

function readKb() {
  return readJson(kbFile(), null);
}

function writeKb(entries) {
  writeJson(kbFile(), entries);
}

module.exports = {
  listTasks,
  addTask,
  updateTask,
  setTasks,
  readChat,
  writeChat,
  updateChatMessage,
  appendChat,
  readAllChats,
  writeAllChats,
  readJsonFile,
  writeJsonFile,
  listDiaries,
  addDiary,
  updateDiary,
  deleteDiary,
  setDiaries,
  readKb,
  writeKb,
  DATA_DIR,
};
