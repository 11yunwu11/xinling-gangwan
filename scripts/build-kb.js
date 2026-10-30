// 手动构建知识库：npm run build:kb
// （启动时若卡片有变化也会自动构建；此脚本用于手动强制重建）

const config = require('../server/lib/config');
const kb = require('../server/lib/kb');

(async () => {
  const cfg = config.get();
  const r = await kb.ensureKb(cfg, { force: true });
  console.log(`知识库构建完成：${r.count} 张卡片（${r.reason}）`);
  if (!r.built && r.reason.includes('Key')) process.exit(1);
})().catch((err) => {
  console.error('构建失败：', err.message);
  process.exit(1);
});
