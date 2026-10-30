import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// 演示用 MCP 服务器（MA3 课程演示）：提供两个无参工具，验证 MCP 连通与工具调用。
// 通过 stdio 传输运行：node mcp-demo/server.mjs

const QUOTES = [
  '你不需要今天就想通所有事，只需要先照顾好现在的自己。',
  '情绪没有对错，它只是来报信的客人。',
  '慢慢来，比较快。',
  '你已经比昨天多撑了一天，这本身就了不起。',
  '允许自己有一段时间只是"撑着"，那也是努力。',
];

const ACTIONS = [
  '开窗深呼吸三次，感受一下空气的温度。',
  '给自己倒一杯温水，慢慢喝完。',
  '站起来伸展 30 秒，转转肩膀。',
  '看窗外远处 20 秒，让眼睛休息一下。',
  '把手机屏幕朝下放 5 分钟。',
];

const server = new McpServer({ name: 'xinling-demo', version: '0.1.0' });

server.registerTool('get_daily_quote', {
  description: '随机返回一句治愈系短句，可用于给用户一点点温柔的能量',
}, async () => ({
  content: [{ type: 'text', text: QUOTES[Math.floor(Math.random() * QUOTES.length)] }],
}));

server.registerTool('get_micro_action', {
  description: '随机返回一个一分钟就能完成的微行动建议（行为激活）',
}, async () => ({
  content: [{ type: 'text', text: ACTIONS[Math.floor(Math.random() * ACTIONS.length)] }],
}));

await server.connect(new StdioServerTransport());
console.error('[demo-mcp] 演示 MCP 服务器已就绪（stdio）');
