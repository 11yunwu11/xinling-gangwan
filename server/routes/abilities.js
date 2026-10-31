// 能力面板（MA3）：内置工具 + 技能（含内置/自定义标记）+ MCP 工具

const express = require('express');
const skills = require('../lib/skills');
const mcp = require('../lib/mcp');

module.exports = () => {
  const router = express.Router();

  router.get('/abilities', (req, res) => {
    res.json({
      skills: skills.callableSkills().map((s) => ({
        tool: `skill_${s.name}`,
        name: s.name,
        description: s.description,
        builtin: !!s.builtin,
      })),
      mcpTools: mcp.listMcpToolsForUi(),
      builtin: ['add_task', 'get_time_info', 'crisis_support'],
    });
  });

  return router;
};
