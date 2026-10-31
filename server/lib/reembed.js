// 向量空间一致性守护：换 embedding 模型/baseUrl 后，旧向量与新向量不可混算（cosine 无意义）。
// 启动与配置保存时调用：比对 data/embed-meta.json 记录的生效参数，变化则
// 全量重嵌入日记与聊天小结 + 重建知识库（kb 的 cardsKey 亦含 embedding 参数，会自动跟随）。

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { embedOne, embedParams } = require('./embedding');
const { diaryEmbedText } = require('./diary');
const kb = require('./kb');

const META_FILE = () => path.join(store.DATA_DIR, 'embed-meta.json');

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

function currentIdentity(cfg) {
  const p = embedParams(cfg);
  // key 不参与身份判断（换 key 不换模型不改变量空间），baseUrl+model 才是向量空间的决定因素
  return { baseUrl: p.baseUrl || '', model: p.model || '' };
}

async function reembedDiaries(cfg, tag) {
  const diaries = store.listDiaries();
  let done = 0;
  for (const d of diaries) {
    try {
      const vec = await embedOne(embedParams(cfg), diaryEmbedText(d.text, d.summary));
      store.updateDiary(d.id, { embedding: vec });
      done++;
    } catch (err) {
      console.warn(`[${tag}] 单篇日记重嵌入失败（保留旧向量，下次重试）：${d.id}`, err.message);
    }
  }
  return done;
}

async function reembedDigests(cfg, tag) {
  const digests = store.readJsonFile('chat_digests.json', []);
  let done = 0;
  for (const d of digests) {
    try {
      const vec = await embedOne(embedParams(cfg), `[${d.dateKey} 聊天小结] ${d.text}`);
      d.embedding = vec;
      done++;
    } catch (err) {
      console.warn(`[${tag}] 聊天小结重嵌入失败（保留旧向量，下次重试）：${d.dateKey}`, err.message);
    }
  }
  if (done) store.writeJsonFile('chat_digests.json', digests);
  return done;
}

// 返回 { changed, diaries, digests, kb }；未配置时不动
async function syncStoredEmbeddings(cfg) {
  const p = embedParams(cfg);
  if (!p.apiKey || String(p.apiKey).includes('填入')) return { changed: false, skipped: '未配置' };

  const identity = currentIdentity(cfg);
  const meta = readMeta();
  if (meta && meta.baseUrl === identity.baseUrl && meta.model === identity.model) {
    return { changed: false };
  }

  const tag = 'reembed';
  console.log(`[${tag}] embedding 参数变化（${meta ? `${meta.model}` : '首次记录'} → ${identity.model}），全量重嵌入…`);
  const kbResult = await kb.ensureKb(cfg, { force: true }); // 先重建知识库（cardsKey 含参数，force 保险）
  const diaries = await reembedDiaries(cfg, tag);
  const digests = await reembedDigests(cfg, tag);

  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(META_FILE(), JSON.stringify({ ...identity, at: new Date().toISOString() }, null, 2), 'utf8');
  const summary = { changed: true, kb: kbResult.count, diaries, digests };
  console.log(`[${tag}] 完成：知识库 ${kbResult.count} 张、日记 ${diaries} 篇、小结 ${digests} 条`);
  return summary;
}

module.exports = { syncStoredEmbeddings };
