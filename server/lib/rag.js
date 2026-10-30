// RAG 双池检索（计划书 F3 / 约束 C10）：
// 语料池一：日记库（记忆）；语料池二：知识卡片库。
// 余弦相似度 + 相似度门槛，各取 topK，分源标注后由 agent 拼进提示词。

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function topK(pool, queryVec, k, threshold) {
  if (!queryVec) return [];
  return pool
    .filter((item) => item.embedding && item.embedding.length)
    .map((item) => ({ item, score: cosine(queryVec, item.embedding) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => ({ ...x.item, score: Number(x.score.toFixed(4)) }));
}

// 双池检索：返回 { memories, knowledge } 两组已过滤结果
// 注意：参数解构为 topK: k，避免遮蔽同名的 topK 函数（此前因此导致检索静默失败）
function retrieveBoth({ diaries, kb, queryVec, topK: k = 3, threshold = 0.3 }) {
  const memoryPool = diaries.map((d) => ({
    id: d.id,
    dateKey: d.dateKey,
    embedding: d.embedding,
    text: d.text,
    summary: d.summary,
  }));
  return {
    memories: topK(memoryPool, queryVec, k, threshold),
    knowledge: topK(kb || [], queryVec, k, threshold),
  };
}

// 把检索结果格式化为提示词段落（分源标注）
function formatForPrompt(result) {
  const parts = [];
  if (result.memories.length) {
    const lines = result.memories
      .map((m) => `- [${m.dateKey}] ${m.summary ? `${(m.summary.emotions || []).join('/')}｜` : ''}${m.text.slice(0, 200)}`)
      .join('\n');
    parts.push(`【TA 过去的记录】（相似度检索命中，可自然引用，不要机械罗列）\n${lines}`);
  }
  if (result.knowledge.length) {
    const lines = result.knowledge
      .map((k) => `- [${k.title}] ${k.text.slice(0, 260)}`)
      .join('\n');
    parts.push(`【心理学参考】（供你参考的专业知识，化用而非照抄，不作诊断）\n${lines}`);
  }
  return parts.join('\n\n');
}

module.exports = { cosine, topK, retrieveBoth, formatForPrompt };
