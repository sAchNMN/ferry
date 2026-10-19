import claudeCode from './claude-code.js';
import codex from './codex.js';
import vscodeCopilot from './vscode-copilot.js';
import cursor from './cursor.js';
import cline from './cline-family.js';
import continueStore from './continue.js';
import { geminiCli, qwenCode, iflowCli } from './gemini-family.js';
import { trae, vscodeChat } from './vscode-chat.js';
import { goose, opencode, aider } from './misc-stores.js';
import { chatgptExport, claudeExport, genericJson, markdownImporter } from './web-exports.js';

/** 本机会话仓库 */
export const stores = [
  claudeCode,
  codex,
  cursor,
  vscodeCopilot,
  cline,
  continueStore,
  geminiCli,
  qwenCode,
  iflowCli,
  trae,
  vscodeChat,
  goose,
  opencode,
  aider,
];

/** 外部导出文件格式 */
export const importers = [chatgptExport, claudeExport, genericJson, markdownImporter];

export default { stores, importers };
