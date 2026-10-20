#!/usr/bin/env node
/**
 * Ferry CLI
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';

import { createEnv, backupsDir } from './core/env.js';
import {
  color,
  createLogger,
  exists,
  formatBytes,
  formatTime,
  parseArgs,
  plural,
  splitList,
  truncate,
  VERSION,
} from './core/util.js';
import { adapterSummary, allImporters, allStores, getStore, pickImporter, scanStores } from './core/registry.js';
import { collectForExport, compileMappings, importConversations, summarizeExport } from './core/migrate.js';
import { inspectPack, readPack, unpackTo, writePack, PACK_EXT, summarizeManifest } from './core/archive.js';
import { renderHandoff, renderMarkdown } from './core/ucm.js';
import { describeBackup, listBackups, rollback } from './core/backup.js';
import { isEncrypted, passwordStrength } from './core/crypto.js';
import { openDb } from './core/sqlite.js';
import { collectProjectSnapshots, planProjectRestore, restoreProjectSnapshots } from './core/projects.js';

const HELP = `
${color.bold('Ferry')} — 把 AI Agent 的对话历史从一台电脑摆渡到另一台 ${color.gray(`v${VERSION}`)}

${color.bold('用法')}
  ferry <命令> [选项]

${color.bold('命令')}
  scan                     扫描本机已安装的 Agent 与会话
  targets                  查看支持的 Agent 与"能否原生导入/续聊"
  export                   导出会话为 .ferrypack 归档
  import <文件...>         从 .ferrypack / ChatGPT / Claude 导出包导入
  list <归档>              查看归档里的会话清单
  show <归档> [会话]       查看会话内容（Markdown / 交接包）
  convert <文件> --to md   转换格式（markdown / handoff / json）
  unpack <归档> <目录>     把归档摊开成普通文件
  backups                  查看自动备份
  rollback <备份ID>        回滚一次导入
  doctor                   环境自检
  ui [--port 7099]         打开本地 Web 界面
  help / version

${color.bold('常用示例')}
  ${color.gray('# 1. 备份本机所有 Agent 会话（加密）')}
  ferry export --all -o backup.ferrypack --encrypt

  ${color.gray('# 2. 换电脑后，恢复到目标 Agent（自动备份、可回滚）')}
  ferry import backup.ferrypack --to claude-code --workspace D:\\work\\myproj

  ${color.gray('# 3. 先看看会写哪些文件')}
  ferry import backup.ferrypack --to codex --dry-run

  ${color.gray('# 4. 把 ChatGPT 官方导出迁移到 Codex')}
  ferry import conversations.zip --to codex

  ${color.gray('# 5. 云端 Agent 没有本地存储？把官方导出转成交接包，粘给任何模型继续')}
  ferry import conversations.zip --to handoff -o ./handoff

  ${color.gray('# 6. 已导入过的会话会自动跳过；确实要再写一份就加 --force')}
  ferry import backup.ferrypack --to codex --force

  ${color.gray('# 7. 只导出自己参与过的对话（跳过 Codex 审批 / 子 Agent 自动运行）')}
  ferry export --all --exclude-internal -o mine.ferrypack
  ferry export --all --projects -o bundle.ferrypack

${color.bold('导出选项')}
  --projects        导出会话引用的项目文件（默认排除 .git、依赖目录和凭据）

${color.bold('导入选项')}
  --to <agent>      目标 Agent（ferry targets 查看）
  --workspace <dir> 指定项目目录
  --map 旧=新       路径映射，可重复
  --dry-run         只预演，不写盘
  --force           忽略导入台账，强制重导
  --no-backup       跳过导入前的自动备份（不推荐）
  --restore-projects <目录>  把归档里的项目文件恢复到该目录，不覆盖已有文件

${color.bold('通用选项')}
  --json           机器可读输出
  --yes / -y       跳过确认
  --quiet          安静模式
  --no-color       关闭颜色

  ${color.gray('文档：docs/README.md（架构、格式、支持矩阵）')}
`;

export async function main(argv) {
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1), {
    repeat: ['agent', 'id', 'map', 'exclude'],
    booleans: ['json', 'yes', 'quiet', 'help', 'version', 'all', 'dry-run', 'force', 'encrypt', 'redact', 'open', 'verify', 'verbose', 'exclude-internal', 'projects'],
  });

  if (args.version || argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    output.write(`ferry ${VERSION} (node ${process.version})\n`);
    return;
  }
  if (args.help || argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    output.write(HELP);
    return;
  }

  const log = createLogger({
    json: Boolean(args.json),
    quiet: Boolean(args.quiet),
    level: args.verbose ? 'debug' : 'info',
  });
  const env = buildEnv(args);
  const rest = args._;
  const ctx = { env, log, args, rest };

  switch (cmd) {
    case 'scan':
      return cmdScan(ctx);
    case 'targets':
      return cmdTargets(ctx);
    case 'export':
    case 'backup':
      return cmdExport(ctx);
    case 'import':
    case 'restore':
      return cmdImport(ctx);
    case 'list':
      return cmdList(ctx);
    case 'show':
      return cmdShow(ctx);
    case 'convert':
      return cmdConvert(ctx);
    case 'unpack':
      return cmdUnpack(ctx);
    case 'backups':
      return cmdBackups(ctx);
    case 'rollback':
      return cmdRollback(ctx);
    case 'doctor':
      return cmdDoctor(ctx);
    case 'ui':
    case 'serve':
      return cmdUi(ctx);
    default:
      log.error(`未知命令：${cmd}`, {});
      output.write(`\n运行 ${color.bold('ferry help')} 查看用法。\n`);
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* scan                                                               */
/* ------------------------------------------------------------------ */

async function cmdScan({ env, log, args }) {
  const res = await scanStores(env, { only: splitList(args.agent), log });
  if (args.json) {
    output.write(JSON.stringify({ env: envInfo(env), total: res.totalSessions, results: res.results.map(stripSessions), ms: res.ms }, null, 2) + '\n');
    return;
  }
  output.write(`\n${color.bold('本机 Agent 会话扫描')}  ${color.gray(`${env.platform} · ${env.home}`)}\n\n`);
  const rows = [];
  for (const r of res.results) {
    const last = r.sessions.map((s) => s.updatedAt).filter(Boolean).sort().at(-1);
    const bytes = r.sessions.reduce((a, s) => a + (s.bytes || 0), 0);
    rows.push([
      r.sessions.length ? color.green('●') : color.gray('○'),
      r.name,
      r.sessions.length ? color.bold(String(r.sessions.length)) : color.gray('0'),
      formatBytes(bytes),
      formatTime(last),
      r.error ? color.red(truncate(r.error, 40)) : color.gray(r.vendor || ''),
    ]);
  }
  output.write(formatTable(['', '组件', '会话', '体积', '最近活动', '厂商'], rows));
  output.write('\n');

  if (res.totalSessions) {
    log.success(`共 ${plural(res.totalSessions, '个会话')}，可导出`);
    output.write(`\n  下一步： ${color.bold('ferry export --all -o backup' + PACK_EXT)}\n`);
    const missing = allStores().filter((s) => !res.results.find((r) => r.adapter === s.id && r.installed));
    if (missing.length) {
      output.write(`\n  ${color.gray('未检测到：')} ${missing.map((m) => m.name).join('、')}\n`);
    }
  } else {
    output.write(`  ${color.yellow('本机没有检测到可导出的会话。')}\n`);
    output.write(`  可以先用官方导出功能导出云端会话，然后：${color.bold('ferry import conversations.zip')}\n`);
  }
  output.write('\n');
}

/* ------------------------------------------------------------------ */
/* targets                                                            */
/* ------------------------------------------------------------------ */

async function cmdTargets({ args }) {
  const list = adapterSummary();
  if (args.json) {
    output.write(JSON.stringify(list, null, 2) + '\n');
    return;
  }
  const rows = list.map((a) => [
    a.region === 'cn' ? '🇨🇳' : '🌍',
    a.name,
    a.vendor || '',
    cap(a.capabilities.export),
    cap(a.capabilities.import),
    cap(a.capabilities.resume),
    a.capabilities.tools ? '✓' : '—',
  ]);
  output.write(`\n${color.bold('支持的 Agent / 客户端')}\n\n`);
  output.write(formatTable(['', '名称', '厂商', '导出', '原生导入', '续聊', '工具调用'], rows));
  output.write(`\n  ${color.gray('原生导入 = 写入对方原生存储，重启后可直接接着用；否则可用交接包继续。')}\n`);
  output.write(`  ${color.gray('外部导出包：')} ${allImporters().map((i) => i.name).join('、')}\n\n`);
}

function cap(v) {
  return v ? color.green('✓') : color.gray('—');
}

/* ------------------------------------------------------------------ */
/* export                                                             */
/* ------------------------------------------------------------------ */

async function cmdExport({ env, log, args }) {
  const agents = splitList(args.agent);
  const asHandoff = args.to === 'handoff' || args.to === 'markdown' || args.to === 'md';
  if (!agents.length && !args.all) {
    // 默认导出全部，但先让用户看到范围
    args.all = true;
  }
  const outFile = asHandoff
    ? args.out || path.join(process.cwd(), 'ferry-handoff')
    : args.out || path.join(args.dir || process.cwd(), `ferry-${stamp()}-${agents.length ? agents.join('-') : 'all'}${PACK_EXT}`);
  if (!asHandoff && (await exists(outFile)) && !args.force) {
    throw err(`目标文件已存在：${outFile}`, '加 --force 覆盖，或换一个 -o 路径。');
  }

  const password = asHandoff ? null : await resolvePassword(args, { create: Boolean(args.encrypt) });
  if (password) {
    const st = passwordStrength(password);
    if (st.score < 2) log.warn(`密码强度：${st.label}，建议至少 12 位并混合大小写与符号。`);
  }

  log.step(`扫描会话…`);
  const collected = await collectForExport(env, {
    agents,
    ids: splitList(args.id),
    since: args.since,
    limit: args.limit ? Number(args.limit) : 0,
    last: args.last ? Number(args.last) : 0,
    redact: args.redact !== false,
    excludeInternal: Boolean(args['exclude-internal']),
    log,
    onProgress: (p) => progress(`读取 ${p.done}/${p.total}  ${truncate(p.title, 40)}`),
  });
  clearProgress();

  if (!collected.conversations.length) {
    const detail = collected.errors.length ? `\n  读取失败：\n${collected.errors.map((e) => `    · ${e.adapter}: ${e.error}`).join('\n')}` : '';
    throw err('没有找到可导出的会话', `先运行 ferry scan 看看检测结果。${detail}`);
  }

  if (asHandoff) {
    await fsp.mkdir(outFile, { recursive: true });
    let n = 0;
    for (const conv of collected.conversations) {
      const base = safeFileName(conv.title) || `session-${++n}`;
      const body = args.to === 'markdown' || args.to === 'md' ? renderMarkdown(conv) : renderHandoff(conv);
      await fsp.writeFile(path.join(outFile, `${base}.md`), body, 'utf8');
      n++;
    }
    log.success(`已生成 ${n} 份交接包 → ${outFile}`);
    output.write(`\n  把 .md 的内容粘贴到目标 AI 的对话框，即可接着原来的工作。\n`);
    output.write(`  ${color.gray('适合 ChatGPT / Claude / Gemini / DeepSeek / Kimi / 豆包 等没有本地会话存储的产品。')}\n\n`);
    return;
  }

  const projectSnapshot = args.projects ? await collectProjectSnapshots(collected.conversations) : { projects: [], warnings: [], excludedFiles: 0 };
  for (const warning of projectSnapshot.warnings) log.warn(warning);
  const res = await writePack(outFile, {
    conversations: collected.conversations,
    blobs: collected.blobs,
    projects: projectSnapshot.projects,
    password,
    meta: { label: args.label, notes: collected.errors.map((e) => `${e.adapter}: ${e.error}`) },
  });

  const sum = summarizeExport(collected.conversations, collected.blobs);
  if (args.json) {
    output.write(JSON.stringify({ file: res.file, ...res.manifest.stats, manifest: res.manifest }, null, 2) + '\n');
    return;
  }
  log.success(`已导出 ${sum.text}`);
  output.write(`\n  文件：${color.bold(outFile)}\n  体积：${formatBytes(res.bytes)}${password ? '  ' + color.yellow('（已加密）') : ''}\n`);
  if (collected.errors.length) {
    output.write(`\n  ${color.yellow('部分会话未能读取：')}\n`);
    for (const e of collected.errors.slice(0, 6)) output.write(`    · ${e.adapter}：${e.error}\n`);
  }
  output.write(`\n  下一步：把文件拷到另一台电脑，运行\n    ${color.bold(`ferry import "${path.basename(outFile)}" --to <目标Agent>`)}\n\n`);
}

/* ------------------------------------------------------------------ */
/* import                                                             */
/* ------------------------------------------------------------------ */

async function cmdImport({ env, log, args }) {
  const inputs = args._.length ? args._ : [];
  if (!inputs.length) throw err('请指定要导入的文件', '例如：ferry import backup.ferrypack --to claude-code');
  const password = await resolvePassword(args, { create: false });
  const target = args.to || args.target;
  const handoff = target === 'handoff' || target === 'markdown';

  const load = [];
  for (const file of inputs) {
    if (!(await exists(file))) throw err(`文件不存在：${file}`);
    if (/\.ferrypack$/i.test(file)) {
      log.step(`解包 ${path.basename(file)}…`);
      const pack = await readPack(file, { password: password ?? process.env.FERRY_PASSWORD });
      if (pack.warnings.length) pack.warnings.forEach((w) => log.warn(w));
      load.push({ file, pack });
    } else {
      log.step(`识别导出格式 ${path.basename(file)}…`);
      const buf = await fsp.readFile(file);
      const importer = pickImporter(buf, file);
      if (!importer) {
        throw err(`无法识别文件格式：${path.basename(file)}`, '支持 .ferrypack、ChatGPT/Claude 导出的 .zip/.json、Markdown。');
      }
      const convs = await importer.read(buf, file);
      load.push({ file, pack: { conversations: convs, blobs: new Map(), manifest: { conversations: convs }, warnings: [] }, importer });
      log.info(`识别为 ${importer.name}，共 ${plural(convs.length, '个会话')}`);
    }
  }

  const conversations = load.flatMap((l) => l.pack.conversations);
  const blobs = new Map();
  for (const l of load) for (const [k, v] of l.pack.blobs || []) blobs.set(k, v);
  const projects = load.flatMap((l) => l.pack.projects || []);
  let projectPlan = null;
  if (args['restore-projects']) {
    if (!projects.length) throw err('归档里没有项目文件', '导出时请加 --projects。');
    projectPlan = await planProjectRestore(projects, conversations, args['restore-projects']);
  }

  if (args.list) {
    printConversationList(conversations);
    return;
  }
  if (!target && !projectPlan) {
    printConversationList(conversations);
    output.write(`\n  ${color.yellow('未指定 --to 目标。')} 选择：${allStores()
      .filter((s) => s.capabilities.import)
      .map((s) => s.id)
      .join(', ')}，或 ${color.bold('--to handoff')} 生成交接包。\n\n`);
    process.exitCode = 1;
    return;
  }

  const projectMappings = projectPlan?.mappings || [];
  const userMappings = compileMappings(splitList(args.map));
  const mappings = [...projectMappings, ...userMappings];
  if (projectPlan) {
    output.write(`\n  ${color.bold('项目恢复计划')}\n`);
    output.write(`    目标目录  ${args['restore-projects']}\n`);
    output.write(`    项目      ${projectPlan.projects.length} 个\n`);
    output.write(`    文件      ${projectPlan.projects.reduce((sum, p) => sum + (p.files?.length || 0), 0)} 个\n`);
  }

  if (!target) {
    if (projectPlan) {
      if (args['dry-run']) {
        log.step('模拟恢复项目文件（不会改动任何文件）');
      } else if (!args.yes) {
        const ok = await confirm('确认恢复项目文件？(y/N) ');
        if (!ok) {
          log.warn('已取消');
          return;
        }
      }
      if (!args['dry-run']) {
        const restored = await restoreProjectSnapshots(projectPlan);
        log.success(`已恢复 ${restored.length} 个项目目录 → ${args['restore-projects']}`);
      }
    }
    return;
  }

  if (handoff) {
    const dir = args.out || path.join(process.cwd(), 'ferry-handoff');
    await fsp.mkdir(dir, { recursive: true });
    let n = 0;
    for (const conv of conversations) {
      const name = safeFileName(conv.title) || `session-${++n}`;
      await fsp.writeFile(path.join(dir, `${name}.md`), renderHandoff(conv), 'utf8');
      n++;
    }
    log.success(`已生成 ${n} 份交接包 → ${dir}`);
    output.write(`\n  把对应 .md 的内容粘贴到目标 AI 的对话框，即可继续原来的工作。\n\n`);
    return;
  }

  const store = getStore(target);
  if (!store) throw err(`未知目标：${target}`, `可用目标：${allStores().map((s) => s.id).join(', ')}`);
  if (!store.capabilities.import) {
    throw err(`${store.name} 暂不支持原生导入`, `可以改用 --to handoff 生成交接包，或先导入到支持的目标。`);
  }

  output.write(`\n  ${color.bold('导入计划')}\n`);
  output.write(`    来源    ${load.map((l) => path.basename(l.file)).join(', ')}\n`);
  output.write(`    会话    ${plural(conversations.length, '个')}\n`);
  output.write(`    目标    ${store.name}（${target}）\n`);
  if (args.workspace) output.write(`    项目    ${args.workspace}\n`);
  if (args.map) output.write(`    映射    ${splitList(args.map).join(' ; ')}\n`);
  output.write('\n');

  if (args['dry-run']) {
    log.step('模拟写入（不会改动任何文件）');
  } else if (!args.yes) {
    const ok = await confirm(projectPlan ? '确认恢复项目文件并写入目标 Agent？(y/N) ' : '确认写入目标 Agent 的本地存储？(y/N) ');
    if (!ok) {
      log.warn('已取消');
      return;
    }
  }

  if (projectPlan && !args['dry-run']) {
    const restored = await restoreProjectSnapshots(projectPlan);
    log.success(`已恢复 ${restored.length} 个项目目录 → ${args['restore-projects']}`);
  }

  const res = await importConversations(env, conversations, {
    target,
    workspace: args.workspace,
    map: mappings,
    into: args.into,
    dryRun: Boolean(args['dry-run']),
    force: Boolean(args.force),
    backup: !args['no-backup'],
    blobs,
    log,
    onProgress: (p) => progress(`写入 ${p.done}/${p.total}  ${truncate(p.title, 40)}`),
  });
  clearProgress();

  const okCount = res.results.filter((r) => !r.error && !r.skipped).length;
  const skipped = res.results.filter((r) => r.skipped);
  const fail = res.results.filter((r) => r.error);
  const totalWrites = res.results.reduce((a, r) => a + r.writes.length, 0);

  if (args.json) {
    output.write(JSON.stringify({ target, backup: res.backup?.id || null, results: res.results }, null, 2) + '\n');
    return;
  }

  output.write(`\n  ${color.bold('导入结果')}\n`);
  for (const r of res.results) {
    const mark = r.error ? color.red('✖') : r.skipped ? color.gray('↷') : color.green('✔');
    output.write(`  ${mark} ${truncate(r.title, 44)} ${color.gray(`→ ${r.workspace || ''}`)}\n`);
    if (r.error) output.write(`      ${color.red(r.error)}\n`);
    for (const note of r.notes || []) output.write(`      ${color.gray(note)}\n`);
  }

  output.write('\n');
  if (okCount) log.success(`${plural(okCount, '个会话')}已写入，共 ${totalWrites} 个文件${args['dry-run'] ? color.yellow('（模拟）') : ''}`);
  if (skipped.length) log.info(`${skipped.length} 个会话此前已导入，已跳过（--force 可强制重导）`);
  if (fail.length) log.warn(`${fail.length} 个会话失败`);

  const resumeCmds = [];
  const seenCmds = new Set();
  for (const r of res.results) {
    if (!r.resume || seenCmds.has(r.resume.command)) continue;
    seenCmds.add(r.resume.command);
    resumeCmds.push(r.resume);
  }
  if (resumeCmds.length && !args['dry-run']) {
    output.write(`\n  ${color.bold('怎么接着用')}\n`);
    for (const r of resumeCmds) {
      output.write(`    cd "${r.cwd}"\n`);
      // GUI 类目标没有命令可敲（resume 只给 sessionId），不要打一行 "undefined"
      if (r.command) output.write(`    ${r.command}\n`);
    }
    const hint = store.resumeHint?.(null, resumeCmds[0]);
    if (hint) output.write(`    ${color.gray(hint)}\n`);
  }
  if (res.backup?.id && !args['dry-run']) {
    output.write(`\n  ${color.gray(`已自动备份，回滚：ferry rollback ${res.backup.id}`)}\n`);
  }
  output.write('\n');
  if (fail.length) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* list / show / convert / unpack                                     */
/* ------------------------------------------------------------------ */

async function cmdList({ args, rest, log }) {
  const file = rest[0];
  if (!file) throw err('请指定归档文件', 'ferry list backup.ferrypack');
  const manifest = await inspectManifest(file, args);
  if (args.json) {
    output.write(JSON.stringify(manifest, null, 2) + '\n');
    return;
  }
  output.write(`\n${color.bold(path.basename(file))}\n${summarizeManifest(manifest)}\n\n`);
  const rows = (manifest.conversations || []).map((c) => [
    truncate(c.title, 46),
    c.adapter,
    String(c.messages),
    formatBytes(c.bytes),
    formatTime(c.updatedAt),
  ]);
  output.write(formatTable(['标题', '来源', '消息', '大小', '更新时间'], rows, { max: 200 }));
  output.write('\n');
  await dumpManifest(manifest, args);
}

async function cmdShow({ args, rest }) {
  const file = rest[0];
  if (!file) throw err('请指定归档文件', 'ferry show backup.ferrypack [会话关键字]');
  const pack = await readPack(file, { password: (await resolvePassword(args, {})) ?? process.env.FERRY_PASSWORD });
  const q = rest[1];
  let conv = pack.conversations.find((c) => c.id === q) || pack.conversations.find((c) => c.title.includes(q || '')) || pack.conversations[0];
  if (!conv) throw err('归档里没有会话');
  const md = args.handoff ? renderHandoff(conv) : renderMarkdown(conv, { includeTools: args.tools !== false });
  if (args.out) {
    await fsp.writeFile(args.out, md, 'utf8');
    output.write(`已写入 ${args.out}\n`);
  } else {
    output.write(md);
  }
}

async function cmdConvert({ args, rest }) {
  const file = rest[0];
  if (!file) throw err('请指定输入文件');
  const to = args.to || 'markdown';
  if (!(await exists(file))) throw err(`文件不存在：${file}`);
  const buf = await fsp.readFile(file);
  const importer = pickImporter(buf, file);
  if (!importer) throw err('无法识别输入格式');
  const convs = await importer.read(buf, file);
  const outDir = args.out || path.join(process.cwd(), 'ferry-converted');
  await fsp.mkdir(outDir, { recursive: true });
  let n = 0;
  for (const conv of convs) {
    const name = safeFileName(conv.title) || `session-${++n}`;
    const content =
      to === 'json' ? JSON.stringify(conv, null, 2) : to === 'handoff' ? renderHandoff(conv) : renderMarkdown(conv);
    const ext = to === 'json' ? '.json' : '.md';
    await fsp.writeFile(path.join(outDir, `${name}${ext}`), content, 'utf8');
    n++;
  }
  output.write(`\n已转换 ${n} 个会话 → ${outDir}（格式：${to}）\n\n`);
}

async function cmdUnpack({ rest }) {
  const [file, dir] = rest;
  if (!file || !dir) throw err('用法：ferry unpack <归档> <目录>');
  const res = await unpackTo(file, dir, { password: process.env.FERRY_PASSWORD });
  output.write(`已解包 ${res.conversations} 个会话、${res.blobs} 个附件 → ${res.dir}\n`);
}

/* ------------------------------------------------------------------ */
/* backups                                                            */
/* ------------------------------------------------------------------ */

async function cmdBackups({ env, args }) {
  const list = await listBackups(env);
  if (args.json) {
    output.write(JSON.stringify(list, null, 2) + '\n');
    return;
  }
  if (!list.length) {
    output.write(`\n  暂无备份（位置：${backupsDir(env)}）\n\n`);
    return;
  }
  output.write(`\n${color.bold('自动备份')}  ${color.gray(backupsDir(env))}\n\n`);
  for (const b of list) output.write(`  ${describeBackup(b)}\n    ${color.gray(b.note || '')}\n`);
  output.write(`\n  回滚：ferry rollback <ID>\n\n`);
}

async function cmdRollback({ env, rest, log }) {
  const id = rest[0];
  if (!id) throw err('请指定备份 ID', 'ferry backups 查看可用 ID');
  const res = await rollback(env, id);
  const restored = res.results.filter((r) => r.action === 'restored').length;
  const removed = res.results.filter((r) => r.action === 'removed').length;
  const failed = res.results.filter((r) => r.action === 'failed');

  if (!failed.length) {
    const forgot = res.forgotten ? `，并从导入台账移除 ${res.forgotten} 条` : '';
    log.success(`已回滚 ${res.manifest.id}：恢复 ${restored} 个文件，删除 ${removed} 个新建文件${forgot}`);
    return;
  }

  // 有失败时不能先打一行绿色成功：用户会以为已经回滚干净，实际停在半路。
  log.error(`回滚未完成 ${res.manifest.id}：${failed.length} 个文件失败（已恢复 ${restored} 个，删除 ${removed} 个）`);
  for (const f of failed.slice(0, 5)) output.write(`  · ${f.path}：${f.error}\n`);
  if (failed.length > 5) output.write(`  · 其余 ${failed.length - 5} 个略\n`);
  output.write(`\n  ${color.gray('常见原因：目标应用还在运行，文件被占用。完全退出应用后重试。')}\n\n`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* doctor                                                             */
/* ------------------------------------------------------------------ */

async function cmdDoctor({ env, args, log }) {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint });

  const [major, minor] = process.versions.node.split('.').map(Number);
  add('Node.js 版本', major > 22 || (major === 22 && minor >= 5), process.version, '需要 >= 22.5（内置 node:sqlite）');

  try {
    await openDb(':memory:', { readOnly: false });
    add('内置 SQLite', true, 'node:sqlite 可用');
  } catch (e) {
    add('内置 SQLite', false, e.message, '升级 Node.js');
  }

  try {
    await fsp.mkdir(env.ferryHome, { recursive: true });
    const probe = path.join(env.ferryHome, `.probe-${Date.now()}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe);
    add('配置目录可写', true, env.ferryHome);
  } catch (e) {
    add('配置目录可写', false, e.message, '检查目录权限');
  }

  const scan = await scanStores(env);
  add('适配器扫描', true, `${scan.results.filter((r) => r.installed).length} 个已安装 / ${allStores().length} 个支持`, '');
  for (const r of scan.results) {
    add(`  ${r.name}`, !r.error, r.error ? r.error : `${r.sessions.length} 个会话`, '');
  }

  // 自检：归档写入 → 读出
  try {
    const tmp = path.join(env.ferryHome, `.selftest-${Date.now()}${PACK_EXT}`);
    const { conversations } = await collectForExport(env, { limit: 1, redact: false });
    if (conversations.length) {
      await writePack(tmp, { conversations, blobs: new Map(), password: 'selftest-123456' });
      const p = await readPack(tmp, { password: 'selftest-123456' });
      await fsp.rm(tmp, { force: true });
      add('归档加密往返', p.conversations.length === 1, `${p.conversations.length} 个会话`);
    } else {
      add('归档加密往返', true, '跳过（本机无会话）');
    }
  } catch (e) {
    add('归档加密往返', false, e.message);
  }

  if (args.json) {
    output.write(JSON.stringify({ env: envInfo(env), checks }, null, 2) + '\n');
    return;
  }
  output.write(`\n${color.bold('Ferry 环境自检')}  ${color.gray(`${env.platform} · node ${process.version}`)}\n\n`);
  for (const c of checks) {
    output.write(`  ${c.ok ? color.green('✔') : color.red('✖')} ${c.name.padEnd(26)} ${color.gray(truncate(c.detail || '', 60))}\n`);
    if (!c.ok && c.hint) output.write(`      ${color.yellow(c.hint)}\n`);
  }
  const bad = checks.filter((c) => !c.ok);
  output.write('\n');
  if (bad.length) log.warn(`${bad.length} 项异常`);
  else log.success('一切正常');
  output.write('\n');
}

/* ------------------------------------------------------------------ */
/* ui                                                                 */
/* ------------------------------------------------------------------ */

async function cmdUi({ env, args, log }) {
  const { startServer } = await import('./server.js');
  const port = Number(args.port || 7099);
  const server = await startServer({ env, port, log });
  const url = `http://127.0.0.1:${server.port}/`;
  log.success(`Ferry 界面已启动：${color.bold(url)}`);
  output.write(`  ${color.gray('按 Ctrl+C 退出。数据不会离开本机。')}\n\n`);
  if (args.open) openBrowser(url);
  await new Promise(() => {});
}

/* ------------------------------------------------------------------ */
/* 辅助                                                               */
/* ------------------------------------------------------------------ */

function err(message, hint) {
  const e = new Error(message);
  e.ferry = true;
  e.hint = hint;
  return e;
}

async function resolvePassword(args, { create = false } = {}) {
  if (args.password === false) return null;
  if (typeof args.password === 'string') return args.password;

  const need = create || Boolean(args.encrypt) || (await isEncryptedInput(args));
  if (create || need) {
    if (process.env.FERRY_PASSWORD) return process.env.FERRY_PASSWORD;
    if (process.stdin.isTTY) {
      const pw = await promptHidden(create ? '设置归档密码：' : '归档密码：');
      if (create) {
        const again = await promptHidden('再输入一次：');
        if (pw !== again) throw err('两次输入的密码不一致');
        if (!pw) throw err('密码不能为空');
      }
      return pw;
    }
    if (create) throw err('非交互环境需要 --password 或 FERRY_PASSWORD 来设置加密密码');
    return undefined; // 让 readPack 报缺失密码
  }
  return null;
}

/**
 * 只有真正的加密归档才需要密码。
 *
 * 以前这里只看扩展名，于是**任何** `.ferrypack` 都会弹出「归档密码：」，
 * 明文归档的用户会以为文件坏了或者密码丢了。加密容器的魔数是 `FERRYENC1`。
 */
async function isEncryptedInput(args) {
  for (const file of args._) {
    if (!/\.ferrypack$/i.test(file)) continue;
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const head = Buffer.alloc(16);
      const { bytesRead } = await handle.read(head, 0, 16, 0);
      if (bytesRead > 9 && isEncrypted(head.subarray(0, bytesRead))) return true;
    } catch {
      /* 文件不存在/不可读交给后面的读取步骤报错，这里不抢先失败 */
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  return false;
}

async function promptHidden(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw err('当前环境无法交互输入密码', '请使用 --password 或 FERRY_PASSWORD');
  output.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let pw = '';
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(pw);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          output.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') pw = [...pw].slice(0, -1).join('');
        else pw += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    stdin.on('data', onData);
    stdin.on('error', (e) => {
      cleanup();
      reject(e);
    });
  });
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const a = await rl.question(question);
    return /^y(es)?$/i.test(a.trim());
  } finally {
    rl.close();
  }
}

let progressWidth = 0;
function progress(text) {
  if (!process.stderr.isTTY) return;
  const line = `  ${text}`;
  process.stderr.write('\r' + ' '.repeat(progressWidth) + '\r' + line);
  progressWidth = line.length;
}
function clearProgress() {
  if (!process.stderr.isTTY || !progressWidth) return;
  process.stderr.write('\r' + ' '.repeat(progressWidth) + '\r');
  progressWidth = 0;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeFileName(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function envInfo(env) {
  return {
    platform: env.platform,
    home: env.home,
    appData: env.appData,
    localAppData: env.localAppData,
    cwd: env.cwd,
    ferryHome: env.ferryHome,
  };
}

/**
 * 支持 --home / --platform：直接读取另一块硬盘上的用户目录
 * （例如把旧电脑的磁盘挂载过来，用 Ferry 在新机器上离线迁移）。
 */
function buildEnv(args) {
  const base = createEnv();
  if (!args.home) {
    return args['ferry-home'] ? createEnv({ ferryHome: path.resolve(args['ferry-home']) }) : base;
  }
  const home = path.resolve(args.home);
  const platform = args.platform && ['win32', 'darwin', 'linux'].includes(args.platform) ? args.platform : process.platform;
  const key = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  const appData =
    key === 'win'
      ? path.join(home, 'AppData', 'Roaming')
      : key === 'mac'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config');
  const localAppData =
    key === 'win'
      ? path.join(home, 'AppData', 'Local')
      : key === 'mac'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.local', 'share');
  return createEnv({
    home,
    platform,
    appData,
    localAppData,
    xdgConfig: appData,
    xdgData: localAppData,
    ferryHome: args['ferry-home'] ? path.resolve(args['ferry-home']) : path.join(home, '.ferry'),
    cwd: args.cwd ? path.resolve(args.cwd) : base.cwd,
  });
}

function stripSessions(r) {
  return { ...r, sessions: r.sessions.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, messages: s.messages, bytes: s.bytes })) };
}

function printConversationList(conversations) {
  const rows = conversations.map((c) => [
    truncate(c.title, 50),
    c.source.name,
    String(c.stats.messages),
    formatTime(c.updatedAt),
  ]);
  output.write('\n');
  output.write(formatTable(['标题', '来源', '消息', '时间'], rows, { max: 100 }));
  output.write('\n');
}

async function inspectManifest(file, args) {
  const { manifest } = await inspectPack(file, { password: (await resolvePassword(args, {})) ?? process.env.FERRY_PASSWORD });
  return manifest;
}

async function dumpManifest(manifest, args) {
  if (args['save-manifest']) {
    await fsp.writeFile(args['save-manifest'], JSON.stringify(manifest, null, 2), 'utf8');
    output.write(`manifest 已保存：${args['save-manifest']}\n`);
  }
}

/** 终端表格（CJK 宽度感知）。 */
function formatTable(headers, rows, opts = {}) {
  const max = opts.max || 500;
  const all = [headers, ...rows.slice(0, max)];
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...all.map((r) => displayWidth(String(r[i] ?? '')))));
  const line = (cells) =>
    cells
      .map((c, i) => String(c ?? '') + ' '.repeat(Math.max(0, widths[i] - displayWidth(String(c ?? '')))))
      .join('  ')
      .replace(/\s+$/, '');
  const out = [];
  out.push('  ' + line(headers));
  out.push('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of all.slice(1)) out.push('  ' + line(r));
  if (rows.length > max) out.push(`  ${color.gray(`… 另有 ${rows.length - max} 条`)}`);
  return out.join('\n') + '\n';
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 用户可手动打开 */
  }
}
