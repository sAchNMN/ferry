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

  const packFile = path.join(await freshDir('project-pack-file'), 'bundle.ferrypack');
  await writePack(packFile, { conversations: [conv], projects: collected.projects });
  const pack = await readPack(packFile);
  assert.equal(pack.projects.length, 1);
  assert.equal(pack.projects[0].files[0].sha256, collected.projects[0].files[0].sha256);

  const destination = await freshDir('project-restore');
  const plan = await planProjectRestore(pack.projects, pack.conversations, destination);
  const restored = await restoreProjectSnapshots(plan);
  assert.equal(restored.length, 1);
  assert.equal(await fsp.readFile(path.join(restored[0].path, 'README.md'), 'utf8'), '# demo');
  await assert.rejects(() => planProjectRestore(pack.projects, pack.conversations, destination), /目标已存在/);
});
