/**
 * 适配器别名表（数据文件，不含逻辑）。
 *
 * 拆出原因：别名是全局命名空间，多平台并行开发时极易冲突。
 * 按 docs/contract/ownership.md，本文件只由集成负责人修改；
 * 平台分支需要新增别名时，在 PR 里附一行 diff 说明，不自行提交。
 *
 * 键 = 用户可能输入的简写，值 = 真实适配器 id。
 */
export const ALIASES = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  copilot: 'vscode-copilot',
  'github-copilot': 'vscode-copilot',
  vscode: 'vscode-copilot',
  roo: 'cline',
  kilo: 'cline',
  'roo-code': 'cline',
  'kilo-code': 'cline',
  qwen: 'qwen-code',
  gemini: 'gemini-cli',
  'iflow-cli': 'iflow',
  'open-code': 'opencode',
  aider: 'aider',
  block: 'goose',
  'trae-cn': 'trae',
  trae: 'trae',
  windsurf: 'vscode-chat',
  kiro: 'vscode-chat',
  vscodium: 'vscode-chat',
};
