import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { decodeFileUri, encodeFileUri } from '../../src/core/file-url.js';
import { resolveWorkspaceDir } from '../../src/adapters/vscode-copilot.js';
import { freshDir, write } from '../helpers.js';

test('file URI: Windows drive paths and reserved URL characters round-trip', () => {
  const filePath = 'C:\\Users\\Ada Lovelace\\Project #1';
  const uri = encodeFileUri(filePath, 'win32');

  assert.equal(uri, 'file:///C:/Users/Ada%20Lovelace/Project%20%231');
  assert.equal(decodeFileUri(uri, 'win32'), filePath);
});

test('file URI: UNC paths preserve the server name', () => {
  const filePath = '\\\\server\\share\\Project';
  const uri = encodeFileUri(filePath, 'win32');

  assert.equal(uri, 'file://server/share/Project');
  assert.equal(decodeFileUri(uri, 'win32'), filePath);
});

test('file URI: legacy Cursor drive URIs remain readable', () => {
  assert.equal(decodeFileUri('file://C:/Users/Ada/Project', 'win32'), 'C:\\Users\\Ada\\Project');
});

test('VS Code workspace: UNC URI matches existing workspace storage', async () => {
  const home = await freshDir('unc-workspace');
  const userDir = path.join(home, 'Code', 'User');
  const workspaceDir = path.join(userDir, 'workspaceStorage', 'existing');
  await write(path.join(workspaceDir, 'workspace.json'), { folder: 'file://server/share/project' });

  const resolved = await resolveWorkspaceDir(userDir, '\\\\server\\share\\project', {
    create: false,
    platform: 'win32',
  });

  assert.equal(resolved.created, false);
  assert.equal(resolved.dir, workspaceDir);
});


test('file URI: literal percent escapes remain part of the directory name', () => {
  const filePath = String.raw`C:\Work\100%20done\项目 #1`;
  const uri = encodeFileUri(filePath, 'win32');
  assert.equal(decodeFileUri(uri, 'win32'), filePath);
  assert.ok(uri.includes('100%2520done'));
});

test('file URI: POSIX backslashes are preserved as filename characters', () => {
  const filePath = String.raw`/home/ada/project\notes`;
  assert.equal(decodeFileUri(encodeFileUri(filePath, 'linux'), 'linux'), filePath);
});

test('VS Code workspace: newly created UNC workspace can be found again', async () => {
  const userDir = path.join(await freshDir('unc-workspace-create'), 'User');
  const cwd = String.raw`\\server\share\项目 #100%`;
  const created = await resolveWorkspaceDir(userDir, cwd, { platform: 'win32' });
  const found = await resolveWorkspaceDir(userDir, cwd, { create: false, platform: 'win32' });
  assert.equal(found.created, false);
  assert.equal(found.dir, created.dir);
});


test('file URI: Unicode UNC hostnames round-trip without changing the server', () => {
  const filePath = '\\\\服务器\\共享\\项目';
  assert.equal(decodeFileUri(encodeFileUri(filePath, 'win32'), 'win32'), filePath);
});

test('VS Code workspace: dot segments and Windows namespace prefixes match existing storage', async () => {
  const userDir = path.join(await freshDir('workspace-canonical-match'), 'User');
  const existing = path.join(userDir, 'workspaceStorage', 'original');
  await write(path.join(existing, 'workspace.json'), { folder: 'file:///C:/work/project' });
  for (const cwd of ['C:\\work\\other\\..\\project', '\\\\?\\C:\\work\\project']) {
    const found = await resolveWorkspaceDir(userDir, cwd, { create: false, platform: 'win32' });
    assert.equal(found.created, false, cwd);
    assert.equal(found.dir, existing, cwd);
  }
});
