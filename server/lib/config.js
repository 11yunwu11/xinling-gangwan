const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

let config = null;

function load() {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else {
    // 没有 config.json 时退回示例配置，保证服务能启动并在浏览器里弹出配置窗口
    config = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
    config._usingExample = true;
  }
  return config;
}

function get() {
  return config || load();
}

function isConfigured(cfg) {
  const key = cfg && cfg.llm && cfg.llm.apiKey;
  return !!key && !String(key).includes('填入');
}

// 保存配置（首启配置窗口 / 设置页共用）：
// - 以现有 config.json（无则示例配置）为底，合并传入字段
// - apiKey 留空 = 保留已保存的 Key
function save(partial = {}) {
  const base = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));

  const merged = { ...base };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || k === 'apiKey') continue;
    merged[k] = v;
  }
  merged.llm = { ...(base.llm || {}), ...(partial.llm || {}) };
  if (partial.apiKey !== undefined && String(partial.apiKey).trim()) {
    merged.llm.apiKey = String(partial.apiKey).trim();
  }
  // embedding 独立接口（可选块）；字段缺省 = 保留旧值，整体回落逻辑在 embedding.embedParams
  if (partial.embedding) merged.embedding = { ...(base.embedding || {}), ...partial.embedding };
  delete merged._usingExample;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  load();
  return get();
}

module.exports = { get, load, save, isConfigured, ROOT };
