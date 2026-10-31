// 共享的 md frontmatter 解析（skills/*.md 与 knowledge/*.md 同一格式）：
// --- 包裹的 key: value 行 + 正文。原 skills.js 与 kb.js 各有一份近似实现，收拢于此。

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

module.exports = { parseFrontmatter };
