// 前端逻辑：标签页切换、对话流（SSE 消费）、日记、任务清单、能力面板

const $ = (sel) => document.querySelector(sel);

/* ---------- 标签页 ---------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'tasks') loadTasks();
    if (btn.dataset.tab === 'diary') loadDiaries();
    if (btn.dataset.tab === 'abilities') loadAbilities();
    if (btn.dataset.tab === 'review') loadReview();
  });
});

/* ---------- 白天/黑夜模式 ---------- */
// localStorage 记住选择；没选过则跟随系统；系统主题变化时（没手动选过）实时跟随
const THEME_KEY = 'xlgw-theme';

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $('#btn-theme');
  btn.querySelector('.ico').textContent = t === 'dark' ? '☀' : '☾';
  btn.querySelector('span:last-child').textContent = t === 'dark' ? '日间' : '夜间';
  btn.title = t === 'dark' ? '切换到白天模式' : '切换到黑夜模式';
}

function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' || t === 'light' ? t : null;
  } catch {
    return null;
  }
}

applyTheme(savedTheme() || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

const themeMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
if (themeMq && themeMq.addEventListener) {
  themeMq.addEventListener('change', (e) => {
    if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light');
  });
}

$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 存不进就只用这一次 */
  }
  applyTheme(next);
});

/* ---------- 对话 ---------- */
const chatLog = $('#chat-log');
const statusLine = $('#status-line');
const input = $('#chat-input');

let viewingKey = null; // null = 正在"今天"
let currentKey = null; // 当前逻辑日 key（服务端换算），版本切换接口要用

function clearChatDom() {
  chatLog.innerHTML = '';
}

function renderChatMessages(messages) {
  removeRegenButton();
  clearChatDom();
  const visible = messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.role === 'user' || m.role === 'assistant');
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.innerHTML = '<p>这里是你的树洞。</p><p>今天过得怎么样？想说什么都可以。</p>';
    chatLog.appendChild(empty);
    return;
  }
  for (const { m, index } of visible) {
    const bubble = addBubble(m.role, m.content);
    if (m.role === 'assistant' && (m.variants || []).length > 1) {
      addVariantNav(bubble, index, m.variantIndex || 0, m.variants.length);
    }
  }
  // 只有"今天"可以重新 roll；历史回看保持只读
  if (!viewingKey) showRegenButton(visible[visible.length - 1].m.role === 'assistant' ? 'regen' : 'retry');
}

function setViewing(key) {
  viewingKey = key;
  const viewing = $('#chat-viewing');
  const back = $('#chat-back-today');
  if (key) {
    viewing.textContent = `正在查看 ${key} 的对话（只读）`;
    viewing.classList.remove('hidden');
    back.classList.remove('hidden');
    $('#chat-form').classList.add('hidden');
  } else {
    viewing.classList.add('hidden');
    back.classList.add('hidden');
    $('#chat-form').classList.remove('hidden');
  }
}

async function loadCurrentChat() {
  try {
    const c = await (await fetch('/api/chats/current')).json();
    currentKey = c.key;
    setViewing(null);
    renderChatMessages(c.messages || []);
  } catch {
    /* 静默 */
  }
}

async function loadHistoryDay(key) {
  try {
    const c = await (await fetch(`/api/chats/${key}`)).json();
    setViewing(key);
    renderChatMessages(c.messages || []);
    $('#chat-history-panel').classList.add('hidden');
  } catch {
    /* 静默 */
  }
}

async function toggleHistoryPanel() {
  const panel = $('#chat-history-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  try {
    const days = await (await fetch('/api/chats')).json();
    panel.innerHTML = '';
    if (!days.length) {
      panel.innerHTML = '<p class="hint">还没有历史对话。</p>';
    }
    for (const d of days) {
      const btn = document.createElement('button');
      btn.className = 'history-day';
      btn.textContent = `${d.key}（${d.count} 条）` + (viewingKey === d.key ? ' · 当前' : '');
      btn.addEventListener('click', () => loadHistoryDay(d.key));
      panel.appendChild(btn);
    }
    panel.classList.remove('hidden');
  } catch {
    panel.innerHTML = '<p class="hint">加载失败。</p>';
    panel.classList.remove('hidden');
  }
}

$('#chat-history-btn').addEventListener('click', toggleHistoryPanel);
$('#chat-back-today').addEventListener('click', () => {
  $('#chat-history-panel').classList.add('hidden');
  loadCurrentChat();
});

function addBubble(role, text) {
  const empty = chatLog.querySelector('.chat-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

/* ---------- 多版本切换（重新 roll 的版本之间来回看） ---------- */
// 在回应气泡下方挂 ‹ 2/3 › 切换器；今日与历史回看都可用，切换结果写回本地记录
function addVariantNav(bubble, msgIndex, variantIndex, total) {
  const nav = document.createElement('div');
  nav.className = 'variant-nav';
  const prev = document.createElement('button');
  prev.textContent = '‹';
  prev.title = '上一个版本';
  const counter = document.createElement('span');
  counter.textContent = `${variantIndex + 1}/${total}`;
  const next = document.createElement('button');
  next.textContent = '›';
  next.title = '下一个版本';
  nav.append(prev, counter, next);

  const flip = async (dir) => {
    const key = viewingKey || currentKey;
    if (!key) return;
    prev.disabled = next.disabled = true;
    let r = null;
    try {
      r = await (await fetch(`/api/chats/${key}/message/${msgIndex}/variant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir }),
      })).json();
    } catch {
      /* 静默 */
    }
    if (r && !r.error) {
      bubble.textContent = r.content;
      counter.textContent = `${r.variantIndex + 1}/${r.variantTotal}`;
    }
    prev.disabled = next.disabled = false;
  };
  prev.addEventListener('click', () => flip('prev'));
  next.addEventListener('click', () => flip('next'));
  chatLog.appendChild(nav);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ---------- 重新生成（重新 roll） ---------- */
// 最后一消息是 AI → "重新生成"替换它；是你的消息（比如上次生成失败）→ "生成回应"补上
let regenBtn = null;

function removeRegenButton() {
  if (regenBtn) {
    regenBtn.remove();
    regenBtn = null;
  }
}

function showRegenButton(mode) {
  removeRegenButton();
  if (viewingKey) return; // 历史回看保持只读
  regenBtn = document.createElement('button');
  regenBtn.className = 'regen-btn';
  regenBtn.textContent = mode === 'retry' ? '↻ 生成回应' : '↻ 重新生成';
  regenBtn.title = mode === 'retry'
    ? '对这条消息重新生成一次回应'
    : '换个说法再回应一次（旧版本会保留，可用 ‹ › 切换）';
  regenBtn.addEventListener('click', regenerate);
  chatLog.appendChild(regenBtn);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// 重新生成前清场：丢掉最后一条用户消息之后的旧回应、工具提示和按钮
function clearAfterLastUser() {
  const nodes = [...chatLog.children];
  let cut = -1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].classList.contains('bubble') && nodes[i].classList.contains('user')) {
      cut = i;
      break;
    }
  }
  for (let i = nodes.length - 1; i > cut; i--) nodes[i].remove();
}

function setStatus(text) {
  if (!text) {
    statusLine.classList.add('hidden');
    statusLine.textContent = '';
  } else {
    statusLine.classList.remove('hidden');
    statusLine.textContent = text;
  }
}

function showCrisisCard(hotlines) {
  const card = $('#crisis-card');
  const lines = (hotlines || [])
    .map((h) => `<span class="hotline">${h.name}：<a href="tel:${h.phone}">${h.phone}</a></span>`)
    .join('　');
  card.innerHTML =
    `${lines ? `<div>${lines}</div>` : ''}` +
    `<div>如果你此刻有伤害自己的念头，请立刻联系以上援助热线，或身边信任的人。</div>` +
    `<div class="tender">你不是一个人在扛。这张卡片会一直在。</div>`;
  card.classList.remove('hidden');
}

let streaming = null; // 当前正在生成的气泡

const TOOL_NOTES = {
  add_task: '📌 已把任务记进清单',
  get_time_info: '🕐 看了一眼时间',
  crisis_support: '🫂 准备好好陪你聊聊',
  skill_knowledge_qa: '📚 翻了翻知识库',
  skill_weekly_review: '📝 在写本周回顾',
  skill_morning_comfort: '🌅 在准备早安',
  skill_task_planning: '🗺️ 在规划任务分解',
};

function handleEvent(ev) {
  switch (ev.type) {
    case 'status':
      setStatus(ev.text);
      break;
    case 'delta':
      if (!streaming) streaming = addBubble('assistant', '');
      streaming.textContent += ev.text;
      chatLog.scrollTop = chatLog.scrollHeight;
      break;
    case 'tool': {
      const note = document.createElement('div');
      note.className = 'tool-note';
      note.textContent = TOOL_NOTES[ev.name] || `🔧 调用了 ${ev.name}`;
      chatLog.appendChild(note);
      chatLog.scrollTop = chatLog.scrollHeight;
      break;
    }
    case 'crisis':
      showCrisisCard(ev.hotlines);
      break;
    case 'done':
      setStatus('');
      // roll 出了第 2 个及以上版本 → 立刻在气泡下挂切换器，不用刷新
      if (streaming && (ev.variantTotal || 1) > 1) {
        addVariantNav(streaming, ev.messageIndex, ev.variantIndex, ev.variantTotal);
      }
      showRegenButton('regen');
      break;
    case 'error': {
      if (!streaming) streaming = addBubble('assistant', '');
      const lead = streaming.textContent ? '\n\n' : '';
      streaming.textContent += `${lead}⚠️ ${ev.message}`;
      setStatus('');
      showRegenButton('retry');
      break;
    }
  }
}

let chatBusy = false; // 有生成在跑时，重新生成不再重复发起

async function runGeneration(payload) {
  streaming = null;
  chatBusy = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      handleEvent({ type: 'error', message: err.error || `请求失败（${res.status}）` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const part = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!part.startsWith('data:')) continue;
        try {
          handleEvent(JSON.parse(part.slice(5)));
        } catch {
          /* 忽略坏帧 */
        }
      }
    }
  } catch (err) {
    handleEvent({ type: 'error', message: err.message || '网络错误' });
  } finally {
    streaming = null;
    chatBusy = false;
    setStatus('');
  }
}

async function sendMessage(text) {
  addBubble('user', text);
  removeRegenButton();
  setStatus('树洞在听…');
  await runGeneration({ text });
}

async function regenerate() {
  if (chatBusy) return;
  clearAfterLastUser();
  setStatus('重新生成…');
  await runGeneration({ regenerate: true });
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  sendMessage(text);
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
});

// Enter 发送（Shift+Enter 换行；中文输入法选词回车不误发）
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

/* ---------- 日记 ---------- */
const diaryStatus = $('#diary-status');

function setDiaryStatus(text) {
  diaryStatus.classList.toggle('hidden', !text);
  diaryStatus.textContent = text || '';
}

async function loadDiaries() {
  const list = $('#diary-list');
  const empty = $('#diary-empty');
  try {
    const diaries = await (await fetch('/api/diaries')).json();
    list.innerHTML = '';
    empty.classList.toggle('hidden', diaries.length > 0);
    for (const d of diaries) {
      const li = document.createElement('li');
      li.className = 'diary-item';
      const chips = (d.summary && d.summary.emotions || []).map((e) => `<span class="chip">${e}</span>`).join('');
      const events = (d.summary && d.summary.keyEvents || []).map((e) => `<li>${e}</li>`).join('');
      li.innerHTML =
        `<div class="diary-head"><span class="diary-date"></span>${chips}` +
        `<button class="diary-del" title="删除这篇日记">删除</button></div>` +
        `<div class="diary-text"></div>` +
        (events ? `<div class="diary-events">关键事件：<ul>${events}</ul></div>` : '');
      li.querySelector('.diary-date').textContent = d.dateKey || (d.createdAt || '').slice(0, 10);
      li.querySelector('.diary-text').textContent = d.text;
      li.querySelector('.diary-del').addEventListener('click', async () => {
        if (!confirm('确定删除这篇日记吗？\n删除后它会同时从树洞的记忆库中移除，不可恢复。')) return;
        try {
          const r = await (await fetch(`/api/diaries/${d.id}`, { method: 'DELETE' })).json();
          if (r.error) {
            alert(`删除失败：${r.error}`);
            return;
          }
          loadDiaries();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
      list.appendChild(li);
    }
  } catch {
    empty.textContent = '日记加载失败，稍后再试。';
    empty.classList.remove('hidden');
  }
}

$('#diary-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#diary-input').value.trim();
  if (!text) return;
  setDiaryStatus('AI 正在总结这篇日记…');
  try {
    const d = await (await fetch('/api/diary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })).json();
    if (d.error) {
      setDiaryStatus(`保存失败：${d.error}`);
      return;
    }
    $('#diary-input').value = '';
    setDiaryStatus(`已保存并总结（${(d.summary && d.summary.emotions || []).join('、') || '无标签'}），它现在是树洞的记忆了。`);
    loadDiaries();
  } catch (err) {
    setDiaryStatus(`保存失败：${err.message}`);
  }
});

/* ---------- 任务清单 ---------- */
const SOURCE_LABEL = { agent: '树洞记的', system: '今日任务' };

async function completeTask(id, li) {
  const btn = li.querySelector('.complete-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const t = await (await fetch(`/api/tasks/${id}/complete`, { method: 'POST' })).json();
    if (t.error) throw new Error(t.error);
    loadTasks();
  } catch {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '打卡完成';
    }
  }
}

async function loadTasks() {
  const list = $('#task-list');
  const empty = $('#task-empty');
  try {
    const tasks = await (await fetch('/api/tasks')).json();
    list.innerHTML = '';
    empty.classList.toggle('hidden', tasks.length > 0);
    for (const t of tasks) {
      const li = document.createElement('li');
      li.className = 'task-item';
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = SOURCE_LABEL[t.source] || t.source;
      meta.appendChild(badge);
      meta.appendChild(document.createTextNode(`日期 ${t.date}`));

      const title = document.createElement('div');
      title.className = 'task-title';

      if (t.status === 'done') {
        li.classList.add('done');
        title.textContent = `✅ ${t.title}`;
        li.appendChild(title);
        li.appendChild(meta);
        if (t.encouragement) {
          const enc = document.createElement('div');
          enc.className = 'encouragement';
          enc.textContent = t.encouragement;
          li.appendChild(enc);
        }
      } else {
        title.textContent = t.title;
        li.appendChild(title);
        li.appendChild(meta);
        const btn = document.createElement('button');
        btn.className = 'complete-btn';
        btn.textContent = '打卡完成';
        btn.addEventListener('click', () => completeTask(t.id, li));
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  } catch {
    empty.textContent = '任务加载失败，稍后再试。';
    empty.classList.remove('hidden');
  }
}

/* ---------- 能力面板 ---------- */
async function loadAbilities() {
  try {
    const ab = await (await fetch('/api/abilities')).json();

    const builtin = $('#builtin-list');
    builtin.innerHTML = '';
    const BUILTIN_DESC = {
      add_task: '把用户想做的任务写入任务清单',
      get_time_info: '获取当前时间与逻辑日窗口（服务端时钟）',
      crisis_support: '危机检测命中后自动调用，给出关怀与求助资源',
    };
    for (const name of ab.builtin) {
      const li = document.createElement('li');
      li.className = 'ability-item';
      li.innerHTML = `<b></b><span></span>`;
      li.querySelector('b').textContent = name;
      li.querySelector('span').textContent = BUILTIN_DESC[name] || '';
      builtin.appendChild(li);
    }

    const skills = $('#skill-list');
    skills.innerHTML = '';
    for (const s of ab.skills) {
      const li = document.createElement('li');
      li.className = 'ability-item';
      li.innerHTML = `<b></b><span class="${s.builtin ? 'tag-builtin' : 'tag-custom'}">${s.builtin ? '内置' : '自定义'}</span><span class="ability-desc"></span>`;
      li.querySelector('b').textContent = s.name;
      li.querySelector('.ability-desc').textContent = s.description;
      if (!s.builtin) {
        const del = document.createElement('button');
        del.className = 'item-del';
        del.textContent = '删除';
        del.title = '删除这个自定义技能';
        del.addEventListener('click', () => deleteCustomSkill(s.name, li));
        li.appendChild(del);
      }
      skills.appendChild(li);
    }

    const mcp = $('#mcp-list');
    mcp.innerHTML = '';
    $('#mcp-empty').classList.toggle('hidden', ab.mcpTools.length > 0);
    for (const t of ab.mcpTools) {
      const li = document.createElement('li');
      li.className = 'ability-item';
      li.innerHTML = `<b></b><span></span>`;
      li.querySelector('b').textContent = `${t.tool}`;
      li.querySelector('span').textContent = `来自 MCP 服务器「${t.server}」｜${t.description}`;
      mcp.appendChild(li);
    }

    /* 知识库可视化 */
    try {
      const kb = await (await fetch('/api/kb')).json();
      $('#kb-status').textContent = kb.built && kb.count
        ? `已构建 ${kb.count} 张卡片并全部向量化入库；RAG 检索时按语义取最相关的几张。点击卡片可展开全文。`
        : '尚未构建。';
      $('#kb-empty').classList.toggle('hidden', !!(kb.built && kb.count));
      const list = $('#kb-list');
      list.innerHTML = '';
      for (const c of kb.cards) {
        const li = document.createElement('li');
        li.className = 'kb-card';
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const title = document.createElement('b');
        title.textContent = c.title;
        const badge = document.createElement('span');
        badge.className = c.builtin ? 'tag-builtin' : 'tag-custom';
        badge.textContent = c.builtin ? '内置' : '自定义';
        const tags = document.createElement('span');
        tags.className = 'kb-tags';
        tags.textContent = (c.tags || []).join(' · ');
        summary.appendChild(title);
        summary.appendChild(badge);
        if (tags.textContent) summary.appendChild(tags);
        if (!c.builtin) {
          const del = document.createElement('button');
          del.className = 'item-del';
          del.textContent = '删除';
          del.title = '删除这张自定义卡片';
          del.addEventListener('click', (e) => {
            e.preventDefault(); // 别触发 details 折叠
            e.stopPropagation();
            deleteCustomCard(c.id, li);
          });
          summary.appendChild(del);
        }
        const body = document.createElement('p');
        body.className = 'kb-text';
        body.textContent = c.text;
        details.appendChild(summary);
        details.appendChild(body);
        li.appendChild(details);
        list.appendChild(li);
      }
    } catch {
      $('#kb-status').textContent = '知识库加载失败。';
    }
  } catch {
    /* 静默 */
  }
}

/* ---------- 自定义知识/技能的增删（内置内容受保护，服务端也会拒绝） ---------- */

async function deleteCustomSkill(name, li) {
  if (!confirm(`确定删除自定义技能「${name}」吗？`)) return;
  const btn = li.querySelector('.item-del');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const r = await (await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })).json();
    if (r.error) throw new Error(r.error);
    loadAbilities();
  } catch (err) {
    alert(`删除失败：${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '删除';
    }
  }
}

async function deleteCustomCard(id, li) {
  if (!confirm('确定删除这张自定义卡片吗？知识库会自动重新构建。')) return;
  const btn = li.querySelector('.item-del');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const r = await (await fetch(`/api/kb/cards/${encodeURIComponent(id)}`, { method: 'DELETE' })).json();
    if (r.error) throw new Error(r.error);
    loadAbilities();
  } catch (err) {
    alert(`删除失败：${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '删除';
    }
  }
}

function bindAddForm(url, formSel, buildPayload, okMsg, resetBtnText) {
  const form = $(formSel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = form.querySelector('.form-msg');
    const btn = form.querySelector('button[type="submit"]');
    msg.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const r = await (await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })).json();
      if (r.error) {
        msg.textContent = r.error;
        msg.classList.remove('hidden');
        return;
      }
      msg.textContent = okMsg(r);
      msg.classList.remove('hidden');
      form.reset();
      loadAbilities();
    } catch (err) {
      msg.textContent = `保存失败：${err.message}`;
      msg.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = resetBtnText;
    }
  });
}

bindAddForm(
  '/api/kb/cards',
  '#kb-add-form',
  () => ({ title: $('#kb-title').value.trim(), tags: $('#kb-tags').value.trim(), text: $('#kb-text').value.trim() }),
  (r) => `已保存并向量化入库（知识库现有 ${(r.rebuilt && r.rebuilt.count) || '?'} 张卡片）`,
  '保存卡片'
);

bindAddForm(
  '/api/skills',
  '#skill-add-form',
  () => ({
    name: $('#sk-name').value.trim(),
    description: $('#sk-desc').value.trim(),
    context: $('#sk-context').value,
    body: $('#sk-body').value.trim(),
  }),
  () => '已保存，树洞现在就能调用这个新技能了',
  '保存技能'
);

/* ---------- 配置窗口（首启 / ⚙ 设置） ---------- */
const overlay = $('#setup-overlay');

async function openSetup(editMode) {
  let pub = {};
  try {
    pub = await (await fetch('/api/config/public')).json();
  } catch {
    /* 用默认值 */
  }
  $('#cfg-model').value = pub.model || 'glm-5.3-flash';
  $('#cfg-baseurl').value = pub.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
  $('#cfg-embedding').value = pub.embeddingModel || 'embedding-3';
  $('#cfg-wake').value = pub.wakeTime || '07:00';
  $('#cfg-emb-baseurl').value = pub.embeddingBaseUrl || '';
  $('#cfg-emb-key').value = '';
  $('#cfg-emb-key').placeholder = pub.embeddingSeparate
    ? '留空则保留已保存的 Key'
    : '留空则与对话模型用同一个 Key';
  $('#cfg-key').value = '';
  $('#cfg-key').placeholder = editMode && pub.configured
    ? '留空则保留已保存的 Key'
    : '粘贴你的 GLM API Key';
  $('#setup-title').textContent = editMode && pub.configured ? '设置' : '欢迎使用心灵港湾 🌊';
  $('#cfg-error').classList.add('hidden');
  overlay.classList.remove('hidden');
  $('#cfg-key').focus();
}

$('#btn-settings').addEventListener('click', () => openSetup(true));

$('#cfg-save').addEventListener('click', async () => {
  const payload = {
    model: $('#cfg-model').value.trim(),
    baseUrl: $('#cfg-baseurl').value.trim(),
    embeddingModel: $('#cfg-embedding').value.trim(),
    wakeTime: $('#cfg-wake').value.trim(),
  };
  const key = $('#cfg-key').value.trim();
  if (key) payload.apiKey = key;
  payload.embedding = {
    baseUrl: $('#cfg-emb-baseurl').value.trim(),
    model: $('#cfg-embedding').value.trim(),
  };
  const embKey = $('#cfg-emb-key').value.trim();
  if (embKey) payload.embedding.apiKey = embKey;

  try {
    const r = await (await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
    if (r.error) {
      $('#cfg-error').textContent = r.error;
      $('#cfg-error').classList.remove('hidden');
      return;
    }
    overlay.classList.add('hidden');
    setStatus('配置已保存 ✓（知识库正在后台构建，马上就好）');
    loadAbilities();
  } catch (err) {
    $('#cfg-error').textContent = err.message || '保存失败';
    $('#cfg-error').classList.remove('hidden');
  }
});

// 启动时：载入今日对话；未配置则自动弹出配置窗口；已配置则拉取晨间安抚
(async function initSetup() {
  loadCurrentChat();
  try {
    const h = await (await fetch('/api/health')).json();
    if (h.needsSetup) {
      openSetup(false);
      return;
    }
    initComfort();
  } catch {
    /* 服务未就绪时静默 */
  }
})();

/* ---------- 晨间安抚（M4） ---------- */
async function initComfort() {
  try {
    const c = await (await fetch('/api/comfort')).json();
    if (!c.available || !c.text || c.read) return;
    $('#comfort-text').textContent = c.text;
    $('#comfort-card').classList.remove('hidden');
  } catch {
    /* 静默 */
  }
}

$('#comfort-ok').addEventListener('click', async () => {
  try {
    await fetch('/api/comfort/read', { method: 'POST' });
  } catch {
    /* 标记失败也不影响收起 */
  }
  $('#comfort-card').classList.add('hidden');
});

/* ---------- 回顾与分析（M5 / F9） ---------- */
const EMOTION_COLOR_RULES = [
  [/开心|高兴|兴奋|幸福|喜悦|满足/, '#8bc34a'],
  [/平静|放松|安心|舒适|平和/, '#64b5f6'],
  [/焦虑|紧张|担忧|害怕|不安/, '#ffb74d'],
  [/低落|难过|伤心|沮丧|失落|空虚|郁闷/, '#9575cd'],
  [/愤怒|生气|烦躁|恼火/, '#e57373'],
  [/疲惫|累|倦|无力/, '#a1887f'],
];

function emotionColor(name) {
  if (!name) return 'var(--border-soft)';
  for (const [re, color] of EMOTION_COLOR_RULES) {
    if (re.test(name)) return color;
  }
  return 'var(--muted)';
}

function fmtDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadReview() {
  let stats;
  try {
    stats = await (await fetch('/api/stats')).json();
  } catch {
    return;
  }
  const days = stats.days || {};
  const today = new Date();

  /* 月历（本月） */
  const cal = $('#calendar');
  cal.innerHTML = '';
  const y = today.getFullYear();
  const m = today.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  ['日', '一', '二', '三', '四', '五', '六'].forEach((w) => {
    const head = document.createElement('div');
    head.className = 'cal-head';
    head.textContent = w;
    cal.appendChild(head);
  });
  for (let i = 0; i < firstWeekday; i++) cal.appendChild(document.createElement('div'));
  for (let day = 1; day <= daysInMonth; day++) {
    const key = fmtDateKey(new Date(y, m, day));
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.textContent = day;
    const info = days[key];
    if (info) {
      cell.style.background = emotionColor(info.topEmotion);
      cell.title = `${key}｜${info.count} 篇${info.topEmotion ? `｜${info.topEmotion}` : ''}`;
      cell.classList.add('recorded');
    }
    if (key === stats.todayKey) cell.classList.add('today');
    cal.appendChild(cell);
  }

  /* 最近 30 天情绪带 */
  const strip = $('#emotion-strip');
  strip.innerHTML = '';
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = fmtDateKey(d);
    const info = days[key];
    const cell = document.createElement('div');
    cell.className = 'strip-cell';
    cell.style.background = info ? emotionColor(info.topEmotion) : 'var(--track)';
    cell.title = `${key}｜${info ? `${info.count} 篇${info.topEmotion ? '｜' + info.topEmotion : ''}` : '无记录'}`;
    strip.appendChild(cell);
  }

  /* 热力图（最近 17 周，周一为每列开头） */
  const heat = $('#heatmap');
  heat.innerHTML = '';
  const weekday = today.getDay(); // 0=周日
  for (let row = 0; row < 7; row++) {
    for (let col = 16; col >= 0; col--) {
      const d = new Date(today);
      d.setDate(d.getDate() - (col * 7 + weekday - row));
      if (d > today) {
        heat.appendChild(document.createElement('div'));
        continue;
      }
      const key = fmtDateKey(d);
      const info = days[key];
      const cell = document.createElement('div');
      cell.className = 'heat-cell';
      if (info) {
        const level = info.count >= 2 ? 3 : 1;
        cell.style.background = info.topEmotion
          ? emotionColor(info.topEmotion)
          : 'var(--accent-soft)';
        cell.style.opacity = info.count >= 2 ? 1 : 0.45 + level * 0.15;
        cell.title = `${key}｜${info.count} 篇`;
      } else {
        cell.title = `${key}｜无记录`;
      }
      heat.appendChild(cell);
    }
  }

  /* 统计条 */
  const renderBars = (el, items, color) => {
    el.innerHTML = '';
    const max = Math.max(1, ...items.map((i) => i.count));
    for (const it of items.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const label = document.createElement('span');
      label.className = 'bar-label';
      label.textContent = it.name;
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = Math.round((it.count / max) * 100) + '%';
      fill.style.background = color;
      const num = document.createElement('span');
      num.className = 'bar-num';
      num.textContent = it.count;
      track.appendChild(fill);
      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(num);
      el.appendChild(row);
    }
    if (!items.length) el.innerHTML = '<p class="hint">暂无数据，先去写几篇日记吧。</p>';
  };
  renderBars($('#tag-bars'), stats.tags || [], 'var(--accent)');
  renderBars($('#theme-bars'), stats.themes || [], '#c2a24b');

  /* 周报卡片 */
  loadReport();
}

async function loadReport() {
  const card = $('#report-card');
  try {
    const r = await (await fetch('/api/report')).json();
    if (r && r.text) {
      card.textContent = `${r.rangeStart} ~ ${r.rangeEnd}\n\n${r.text}`;
    } else {
      card.textContent = '还没有周报。每周一早上会自动生成，也可以现在手动生成。';
    }
  } catch {
    card.textContent = '周报加载失败。';
  }
}

$('#report-gen').addEventListener('click', async () => {
  const btn = $('#report-gen');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const r = await (await fetch('/api/report', { method: 'POST' })).json();
    if (r.error) {
      $('#report-card').textContent = `生成失败：${r.error}`;
    } else {
      $('#report-card').textContent = `${r.rangeStart} ~ ${r.rangeEnd}\n\n${r.text}`;
    }
  } catch (err) {
    $('#report-card').textContent = `生成失败：${err.message}`;
  }
  btn.disabled = false;
  btn.textContent = '生成最新周报';
});

/* ---------- 导出 / 导入（M5 / F6） ---------- */
$('#btn-export').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/export');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `xinling-gangwan-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    $('#backup-status').textContent = '已导出 ✓';
  } catch (err) {
    $('#backup-status').textContent = `导出失败：${err.message}`;
  }
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const mode = $('#import-mode').value;
  try {
    const data = JSON.parse(await file.text());
    const r = await (await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, mode }),
    })).json();
    if (r.error) {
      $('#backup-status').textContent = `导入失败：${r.error}`;
      return;
    }
    $('#backup-status').textContent =
      `导入完成（${mode === 'overwrite' ? '覆盖' : '合并'}）：日记 ${r.counts.diaries} 篇、任务 ${r.counts.tasks} 条、对话 ${r.counts.chats} 天、周报 ${r.counts.reports} 份`;
    loadTasks();
  } catch (err) {
    $('#backup-status').textContent = `导入失败：${err.message}`;
  } finally {
    e.target.value = '';
  }
});
