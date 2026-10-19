/**
 * 运行环境：把各平台的目录约定收敛成一份 env 对象。
 * 所有适配器只从这里取路径，方便测试时指向 fixtures。
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from './util.js';
import { ensureDir, readJson, writeJson } from './util.js';

export const APP_DIRS = {
  // VS Code 系（Electron）应用的 userData 目录名
  code: { win: 'Code', mac: 'Code', linux: 'Code' },
  codeInsiders: { win: 'Code - Insiders', mac: 'Code - Insiders', linux: 'Code - Insiders' },
  cursor: { win: 'Cursor', mac: 'Cursor', linux: 'Cursor' },
  cursorNightly: { win: 'Cursor Nightly', mac: 'Cursor Nightly', linux: 'Cursor Nightly' },
  windsurf: { win: 'Windsurf', mac: 'Windsurf', linux: 'Windsurf' },
  trae: { win: 'Trae', mac: 'Trae', linux: 'Trae' },
  traeCn: { win: 'Trae CN', mac: 'Trae CN', linux: 'Trae CN' },
  kiro: { win: 'Kiro', mac: 'Kiro', linux: 'Kiro' },
  lingma: { win: 'Lingma', mac: 'Lingma', linux: 'Lingma' },
  vscodium: { win: 'VSCodium', mac: 'VSCodium', linux: 'VSCodium' },
  claude: { win: 'Claude', mac: 'Claude', linux: 'Claude' },
  chatgpt: { win: 'ChatGPT', mac: 'ChatGPT', linux: 'ChatGPT' },
  cherry: { win: 'CherryStudio', mac: 'CherryStudio', linux: 'CherryStudio' },
  chatbox: { win: 'xyz.chatboxapp.app', mac: 'xyz.chatboxapp.app', linux: 'xyz.chatboxapp.app' },
};

export function platformKey(p = process.platform) {
  if (p === 'win32') return 'win';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

export function createEnv(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const key = platformKey(platform);
  const home = overrides.home || os.homedir();
  const appData =
    overrides.appData ||
    (key === 'win' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : key === 'mac' ? path.join(home, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const localAppData =
    overrides.localAppData ||
    (key === 'win' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : key === 'mac' ? path.join(home, 'Library', 'Application Support') : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'));
  const xdgConfig = overrides.xdgConfig || (key === 'win' ? appData : process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const xdgData = overrides.xdgData || (key === 'win' ? localAppData : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'));
  const cwd = overrides.cwd || process.cwd();

  const env = {
    platform,
    key,
    home,
    appData,
    localAppData,
    xdgConfig,
    xdgData,
    cwd,
    isWin: key === 'win',
    isMac: key === 'mac',
    now: overrides.now || (() => new Date()),
    /** 用例注入的"存在的目录"集合，测试时避免真扫盘 */
    exists: overrides.exists || existsSync,
    appDir(name) {
      const names = APP_DIRS[name];
      return path.join(appData, names ? names[key] : name);
    },
    /** VS Code 系的 user 目录 */
    codeUser(name = 'code') {
      return path.join(env.appDir(name), 'User');
    },
    globalStorage(name = 'code') {
      return path.join(env.codeUser(name), 'globalStorage');
    },
    workspaceStorage(name = 'code') {
      return path.join(env.codeUser(name), 'workspaceStorage');
    },
    ferryHome: overrides.ferryHome || path.join(home, '.ferry'),
  };
  return env;
}

/** 所有 VS Code 系宿主的候选（按存在性过滤）。 */
export function ideHosts(env) {
  const hosts = [
    { id: 'vscode', label: 'VS Code', dir: 'code' },
    { id: 'vscode-insiders', label: 'VS Code Insiders', dir: 'codeInsiders' },
    { id: 'cursor', label: 'Cursor', dir: 'cursor' },
    { id: 'windsurf', label: 'Windsurf', dir: 'windsurf' },
    { id: 'trae', label: 'Trae', dir: 'trae' },
    { id: 'trae-cn', label: 'Trae CN', dir: 'traeCn' },
    { id: 'kiro', label: 'Kiro', dir: 'kiro' },
    { id: 'lingma', label: '通义灵码', dir: 'lingma' },
    { id: 'vscodium', label: 'VSCodium', dir: 'vscodium' },
  ];
  return hosts
    .map((h) => ({ ...h, userDir: env.codeUser(h.dir), globalStorage: env.globalStorage(h.dir) }))
    .filter((h) => env.exists(h.userDir));
}

/* ------------------------------------------------------------------ */
/* Ferry 自己的配置                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  version: 1,
  defaultExportDir: '',
  lastTarget: '',
  pathMappings: [],
  disabledAdapters: [],
  telemetry: false,
};

export async function loadConfig(env) {
  const file = path.join(env.ferryHome, 'config.json');
  const data = await readJson(file, null);
  return { ...DEFAULT_CONFIG, ...(data || {}) };
}

export async function saveConfig(env, patch) {
  await ensureDir(env.ferryHome);
  const cur = await loadConfig(env);
  const next = { ...cur, ...patch, version: 1 };
  await writeJson(path.join(env.ferryHome, 'config.json'), next);
  return next;
}

export function backupsDir(env) {
  return path.join(env.ferryHome, 'backups');
}

export function defaultExportDir(env) {
  return path.join(env.home, 'Documents', 'Ferry') ;
}
