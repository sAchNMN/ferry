import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { collectProjectSnapshots, planProjectRestore, restoreProjectSnapshots } from '../../src/core/projects.js';
import { readPack, writePack } from '../../src/core/archive.js';
import { createConversation, block } from '../../src/core/ucm.js';
import { freshDir } from '../helpers.js';

test('项目快照：打包、校验并恢复到新目录', async () => {
  const root = await freshDir('project-pack');
  await fsp.mkdir(path.join(root, '.git'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fsp.writeFile(path.join(root, 'README.md'), '# demo');
  await fsp.writeFile(path.join(root, '.env'), 'SECRET=do-not-pack');
  await fsp.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');

  const conv = createConversation({
    id: 'c-project',
    title: '项目会话',
    source: { adapter: 'codex', name: 'Codex' },
    workspace: { cwd: root },
    messages: [{ role: 'user', blocks: [block.text('继续项目')] }],
  });
  const collected = await collectProjectSnapshots([conv]);
  assert.equal(collected.projects.length, 1);
  assert.deepEqual(collected.projects[0].files.map((file) => file.path), ['README.md']);
  assert.equal(collected.excludedFiles, 3);
  assert.deepEqual(collected.report, {
    sessionCount: 1,
    sessionsWithWorkspace: 1,
    sessionsWithoutWorkspace: 0,
    workspaceCount: 1,
    projectsPacked: 1,
    projectFiles: 1,
    projectBytes: 6,
    excludedFiles: 3,
    failedProjects: 0,
  });

  const packFile = path.join(await freshDir('project-pack-file'), 'bundle.ferrypack');
  await writePack(packFile, { conversations: [conv], projects: collected.projects, meta: { projectReport: collected.report } });
  const pack = await readPack(packFile);
  assert.equal(pack.projects.length, 1);
  assert.equal(pack.projects[0].files[0].sha256, collected.projects[0].files[0].sha256);
  assert.deepEqual(pack.manifest.projectReport, collected.report);

  const destination = await freshDir('project-restore');
  const plan = await planProjectRestore(pack.projects, pack.conversations, destination);
  const restored = await restoreProjectSnapshots(plan);
  assert.equal(restored.length, 1);
  assert.equal(await fsp.readFile(path.join(restored[0].path, 'README.md'), 'utf8'), '# demo');
  await assert.rejects(() => planProjectRestore(pack.projects, pack.conversations, destination), /目标已存在/);
});

test('项目快照报告：统计缺少工作区和不可读目录', async () => {
  const missingPath = path.join(await freshDir('missing-project-parent'), 'not-found');
  const collected = await collectProjectSnapshots([
    createConversation({ workspace: { cwd: missingPath } }),
    createConversation({}),
  ]);

  assert.equal(collected.report.sessionCount, 2);
  assert.equal(collected.report.sessionsWithoutWorkspace, 1);
  assert.equal(collected.report.workspaceCount, 1);
  assert.equal(collected.report.projectsPacked, 0);
  assert.equal(collected.report.failedProjects, 1);
  assert.match(collected.warnings[0], /项目目录不可读取/);
});
