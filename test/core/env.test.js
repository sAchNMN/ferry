import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectWslWindowsProfile } from '../../src/core/env.js';

const root = '/mnt/c/Users/test';

test('WSL：默认环境自动使用 Windows 用户目录', () => {
  const env = {
    WSL_INTEROP: '1',
    USERPROFILE: root,
    APPDATA: path.posix.join(root, 'src'),
    LOCALAPPDATA: path.posix.join(root, 'test'),
  };
  const detected = detectWslWindowsProfile({ platform: 'linux', env, exists: (p) => p === root || p === env.APPDATA || p === env.LOCALAPPDATA });

  assert.deepEqual(detected, {
    platform: 'win32',
    home: root,
    appData: path.posix.join(root, 'src'),
    localAppData: path.posix.join(root, 'test'),
  });
});


test('WSL：Windows 环境变量盘符转换为可访问的挂载路径', () => {
  const env = {
    WSL_DISTRO_NAME: 'Ubuntu',
    USERPROFILE: String.raw`C:\Users\李 明`,
    APPDATA: String.raw`C:\Users\李 明\AppData\Roaming`,
    LOCALAPPDATA: String.raw`C:\Users\李 明\AppData\Local`,
  };
  const home = '/mnt/c/Users/李 明';
  const expected = { platform: 'win32', home, appData: home + '/AppData/Roaming', localAppData: home + '/AppData/Local' };
  const detected = detectWslWindowsProfile({ platform: 'linux', env, exists: (p) => Object.values(expected).includes(p) });
  assert.deepEqual(detected, expected);
});
