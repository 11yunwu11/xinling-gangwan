// Embedding 适配（OpenAI 兼容 /embeddings）

// 生效的 embedding 接口参数：config.json 里可选配独立的 embedding 块
// { baseUrl, apiKey, model }；哪个字段没配就回落到对话模型（llm 块）的同名字段，
// model 再回落到旧的顶层 embeddingModel —— 完全向后兼容。
function embedParams(cfg) {
  const e = (cfg && cfg.embedding) || {};
  return {
    baseUrl: e.baseUrl || (cfg.llm && cfg.llm.baseUrl),
    apiKey: e.apiKey || (cfg.llm && cfg.llm.apiKey),
    model: e.model || cfg.embeddingModel,
  };
}

async function embed({ baseUrl, apiKey, model, input }) {
  const url = baseUrl.replace(/\/+$/, '') + '/embeddings';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Embedding 接口返回 ${res.status}：${text.slice(0, 300)}`);
  }
  const json = await res.json();
  // OpenAI 兼容格式：{ data: [{ embedding: [...] }, ...] }（按 index 排序）
  const data = (json.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return data.map((d) => d.embedding);
}

async function embedOne(opts, text) {
  const [vec] = await embed({ ...opts, input: [text] });
  return vec;
}

module.exports = { embed, embedOne, embedParams };
