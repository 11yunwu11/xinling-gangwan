// MCP 客户端（MA3 / 约束 C13、F8）：
// - 服务端作为 MCP 客户端，支持 stdio 与 Streamable HTTP 双传输
// - 连接 config.mcpServers 中配置的服务器，把其工具注册进 agent 工具注册表
// - 工具名编码为 mcp_<服务名slug>_<工具名>；任一服务器失败不影响整体启动

const MCP_SDK = '@modelcontextprotocol/sdk';
const TOOL_TIMEOUT_MS = 15000; // F8 错误隔离：MCP 工具/列表调用挂起时按超时失败，不卡死对话流

const clients = []; // { serverName, client, tools: Map<encodedName, {client, remoteName, description}> }

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
}

// 给任意 MCP 调用套超时
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${TOOL_TIMEOUT_MS / 1000}s）——MCP 服务器无响应`)), TOOL_TIMEOUT_MS)
    ),
  ]);
}

function encodeToolName(serverName, toolName) {
  return `mcp_${slug(serverName)}_${toolName}`.slice(0, 64);
}

async function connectOne(entry) {
  const { Client } = await import(`${MCP_SDK}/client/index.js`);

  let transport;
  if (entry.transport === 'http') {
    const { StreamableHTTPClientTransport } = await import(`${MCP_SDK}/client/streamableHttp.js`);
    transport = new StreamableHTTPClientTransport(new URL(entry.url));
  } else {
    // 默认 stdio
    const { StdioClientTransport } = await import(`${MCP_SDK}/client/stdio.js`);
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args || [],
      cwd: entry.cwd,
    });
  }

  const client = new Client({ name: 'xinling-gangwan', version: '0.1.0' });
  await withTimeout(client.connect(transport), `连接「${entry.name}」`);

  const { tools } = await withTimeout(client.listTools(), `获取「${entry.name}」工具列表`);
  const toolMap = new Map();
  for (const t of tools) {
    const encoded = encodeToolName(entry.name, t.name);
    toolMap.set(encoded, {
      client,
      remoteName: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    });
  }
  clients.push({ serverName: entry.name, client, toolMap });
  return { serverName: entry.name, tools: [...toolMap.keys()] };
}

async function initMcpServers(cfg) {
  const servers = cfg.mcpServers || [];
  const results = [];
  for (const entry of servers) {
    try {
      const r = await connectOne(entry);
      console.log(`[mcp] 已连接「${r.serverName}」，注册工具：${r.tools.join(', ')}`);
      results.push({ ok: true, ...r });
    } catch (err) {
      console.warn(`[mcp] 「${entry.name}」连接失败（不影响其他功能）：`, err.message);
      results.push({ ok: false, serverName: entry.name, error: err.message });
    }
  }
  return results;
}

// 配置变更后重载：断开全部现有连接再按新配置重连
async function reinitMcpServers(cfg) {
  for (const { client } of clients) {
    try {
      await client.close();
    } catch {
      /* 关闭失败无妨，马上整体重建 */
    }
  }
  clients.length = 0;
  return initMcpServers(cfg);
}

function listMcpToolDefs() {
  const defs = [];
  for (const { toolMap } of clients) {
    for (const [encoded, info] of toolMap) {
      defs.push({
        type: 'function',
        function: {
          name: encoded,
          description: `[MCP] ${info.description}`,
          parameters: info.inputSchema && info.inputSchema.type ? info.inputSchema : { type: 'object', properties: {} },
        },
      });
    }
  }
  return defs;
}

function listMcpToolsForUi() {
  return clients.flatMap(({ serverName, toolMap }) =>
    [...toolMap.entries()].map(([encoded, info]) => ({
      server: serverName,
      tool: encoded,
      description: info.description,
    }))
  );
}

async function execMcpTool(encodedName, argsJson) {
  for (const { toolMap } of clients) {
    const info = toolMap.get(encodedName);
    if (!info) continue;
    let args = {};
    try {
      args = JSON.parse(argsJson || '{}');
    } catch {
      /* 按空参数调用 */
    }
    const result = await withTimeout(
      info.client.callTool({ name: info.remoteName, arguments: args }),
      `MCP 工具 ${encodedName}`
    );
    const text = (result.content || [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n');
    return { ok: !result.isError, result: text };
  }
  return { ok: false, error: `未知 MCP 工具：${encodedName}` };
}

module.exports = { initMcpServers, reinitMcpServers, listMcpToolDefs, listMcpToolsForUi, execMcpTool };
