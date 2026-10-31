// 知识库构建（MA2 / 约束 C10）：
// knowledge/*.md（frontmatter: title/tags）→ 调 Embedding API → data/kb.json
// 构建脚本与启动时自动构建共用这里。

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { parseFrontmatter } = require('./frontmatter');
const { embed, embedParams } = require('./embedding');

const KB_DIR = path.join(__dirname, '..', '..', 'knowledge');
// 用户自建卡片存 data/knowledge/（同一格式）；内置目录 knowledge/ 受保护，API 只能增删用户目录
const USER_KB_DIR = () => path.join(store.DATA_DIR, 'knowledge');

function readCardsFrom(dir, builtin) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        id: f.replace(/\.md$/, ''),
        title: meta.title || f.replace(/\.md$/, ''),
        tags: (meta.tags || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        text: body,
        builtin,
      };
    });
}

function readCards() {
  return [...readCardsFrom(KB_DIR, true), ...readCardsFrom(USER_KB_DIR(), false)];
}

// 新增自定义卡片（写 data/knowledge/<id>.md）；title/text 必须已通过路由层校验。
// 可传 id（导入还原用）；不传则用时间戳生成，带随机后缀防同毫秒碰撞
function writeCard({ title, tags = [], text, id }) {
  fs.mkdirSync(USER_KB_DIR(), { recursive: true });
  const finalId =
    id && /^[\w-]+$/.test(id) && !fs.existsSync(path.join(USER_KB_DIR(), `${id}.md`))
      ? id
      : `u${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  const md = `---\ntitle: ${title}\ntags: ${tags.join(',')}\n---\n\n${text}\n`;
  fs.writeFileSync(path.join(USER_KB_DIR(), `${finalId}.md`), md, 'utf8');
  return { id: finalId, title, tags, text, builtin: false };
}

// 删除自定义卡片；内置目录永不触碰。返回 false = 不是可删的自定义卡片
function deleteCard(id) {
  if (!/^[\w-]+$/.test(id)) return false;
  const file = path.join(USER_KB_DIR(), `${id}.md`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

// 导入（覆盖模式）用：清空用户卡片目录（内置目录不受影响）
function clearCustomCards() {
  const dir = USER_KB_DIR();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// 有变化（卡片增删改）或 kb.json 缺失时重建；否则复用
async function ensureKb(cfg, { force = false } = {}) {
  const cards = readCards();
  if (!cards.length) return { built: false, count: 0, reason: 'knowledge/ 目录没有卡片' };

  const params = embedParams(cfg);
  // 指纹含 embedding 参数（baseUrl+model）：换模型 → 指纹变 → 自动重建，避免新旧向量空间混算
  const cardsKey = JSON.stringify({
    emb: { baseUrl: params.baseUrl || '', model: params.model || '' },
    cards: cards.map((c) => [c.id, c.title, c.text, c.builtin ? 1 : 0]),
  });
  const existing = store.readKb();
  if (!force && existing && existing._cardsKey === cardsKey) {
    return { built: false, count: existing.entries.length, reason: '已是最新' };
  }

  if (!params.apiKey || params.apiKey.includes('填入')) {
    return { built: false, count: existing ? existing.entries.length : 0, reason: '未配置 API Key，暂用旧知识库' };
  }

  const vectors = await embed({
    ...params,
    input: cards.map((c) => `${c.title}\n${c.text}`),
  });

  const entries = cards.map((c, i) => ({ ...c, embedding: vectors[i] }));
  store.writeKb({ _cardsKey: cardsKey, entries });
  return { built: true, count: entries.length };
}

function loadKb() {
  const kb = store.readKb();
  return kb ? kb.entries : [];
}

module.exports = { ensureKb, loadKb, readCards, writeCard, deleteCard, clearCustomCards };
