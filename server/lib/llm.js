// OpenAI 兼容适配层（约束 C9）：
// - baseUrl 可配置，不写死任何供应商
// - 流式（SSE）调用；边流边把文本增量回调给上层
// - 解析流中的 tool_calls 增量并聚合为完整工具调用

async function chatStream({ baseUrl, apiKey, model, messages, tools, onDelta }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model, messages, stream: true };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status}：${text.slice(0, 400)}`);
  }

  let content = '';
  let finishReason = null;
  const toolAcc = new Map(); // index -> { id, name, args }

  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // 忽略无法解析的行（如供应商的心跳注释）
      }

      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta || {};
      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const acc = toolAcc.get(i) || { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function) {
            if (tc.function.name) acc.name = tc.function.name; // 名称一次性到达
            if (tc.function.arguments) acc.args += tc.function.arguments; // 参数分片到达
          }
          toolAcc.set(i, acc);
        }
      }
    }
  }

  const toolCalls = [...toolAcc.values()]
    .filter((tc) => tc.name)
    .map((tc) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.name,
      args: tc.args || '{}',
    }));

  return { content, toolCalls, finishReason };
}

module.exports = { chatStream };
