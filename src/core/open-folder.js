import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

/**
 * 直接启动系统文件管理器，不经过浏览器下载或 shell。
 *
 * 这里有两个 Windows 上的坑，都是“点了打开所在文件夹却毫无反应”的成因：
 *
 * 1. 不能给 explorer.exe 传 windowsHide。libuv 会把它翻译成 STARTF_USESHOWWINDOW + SW_HIDE，
 *    explorer 是 GUI 程序，于是把文件夹窗口创建成不可见。控制台启动器（cmd/PowerShell）才需要这个开关。
 * 2. 不能把“进程起来了”或“等超时”当成成功。explorer 转发失败会立刻退出（如 0xC0000142），
 *    而壳层兜底可能挂住不动；只有明确的成功退出码才算打开成功，否则前端会显示一个假的绿色提示。
 *
 * Windows 的兜底方式参考 sindresorhus/open：用 PowerShell Start-Process 走 ShellExecute，
 * 命令经 Base64(UTF-16LE) 传入以避免引号注入，参数用单引号包裹并把引号字符翻倍。
 */
const EXPLORER_TIMEOUT_MS = 1500; // explorer 成功转发后通常 100ms 内退出
const POWERSHELL_TIMEOUT_MS = 3000; // PowerShell 冷启动约 300~600ms

const POWERSHELL = `${process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

/** 注意：PowerShell 把 U+2018/U+2019/U+201A/U+201B 也当作单引号定界符，必须一起翻倍。 */
function psQuote(value) {
  return `'${String(value).replaceAll(/['‘’‚‛]/g, (match) => match + match)}'`;
}

function psEncodedCommand(directory) {
  // Start-Process 没有 -LiteralPath，路径按位置参数绑定到 -FilePath；单引号已消除变量/通配符以外的展开。
  const command = `$ProgressPreference = 'SilentlyContinue'; Start-Process ${psQuote(directory)}`;
  return Buffer.from(command, 'utf16le').toString('base64');
}

function launch(command, args, options, { spawnProcess, timeoutMs, killOnTimeout }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, options);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    child.once('error', (err) => settle(reject, err));
    child.once('exit', (code, signal) => settle(resolve, { code, signal }));
    // 定时器保持引用，确保即使子进程被 unref 也能让 Promise 收束。
    timer = setTimeout(() => {
      if (killOnTimeout) {
        try { child.kill(); } catch { /* 已退出 */ }
      }
      settle(resolve, { code: null, timedOut: true });
    }, timeoutMs);
    if (typeof child.unref === 'function') child.unref();
  });
}

function describe({ timedOut, signal, code }) {
  if (timedOut) return '启动后没有退出，可能被系统拦截';
  if (signal) return `被信号 ${signal} 终止`;
  return `退出码 ${code}`;
}

function failureMessage(directory, reason) {
  return `无法打开文件夹 ${directory}（${reason}）。`
    + '如果 Ferry 以管理员身份运行，请改用普通权限启动；也可以手动在资源管理器中打开该路径。';
}

/**
 * Windows：先直接拉起 explorer.exe，失败再交给 PowerShell 的 Start-Process（ShellExecute）。
 * explorer 的退出码 1 是成功常态；它若一直存活，说明系统还没有 shell、这次由它充当 shell，
 * 窗口已经出现，按成功处理。PowerShell 则必须明确返回 0。
 */
async function openOnWindows(directory, { spawnProcess, timeoutMs, fallbackTimeoutMs }) {
  const attempts = [
    {
      command: 'explorer.exe',
      args: [directory],
      options: { detached: true, stdio: 'ignore' },
      timeoutMs,
      accepted: ({ timedOut, code }) => timedOut || code === 0 || code === 1,
      killOnTimeout: false,
    },
    {
      command: POWERSHELL,
      args: [...POWERSHELL_ARGS, psEncodedCommand(directory)],
      // stdio 忽略即可；不给 PowerShell 传 windowsHide，保持与 open 一致，避免 SW_HIDE 有任何外溢的机会。
      options: { stdio: 'ignore' },
      timeoutMs: fallbackTimeoutMs,
      accepted: ({ code }) => code === 0,
      killOnTimeout: true,
    },
  ];

  let reason = '未知错误';
  for (const attempt of attempts) {
    try {
      const result = await launch(attempt.command, attempt.args, attempt.options, {
        spawnProcess,
        timeoutMs: attempt.timeoutMs,
        killOnTimeout: attempt.killOnTimeout,
      });
      if (attempt.accepted(result)) return;
      reason = describe(result);
    } catch (err) {
      reason = err.message;
    }
  }
  throw new Error(failureMessage(directory, reason));
}

/** macOS / Linux：open、xdg-open 成功时退出码为 0；handler 自己常驻也算成功。 */
async function openWith(command, directory, { spawnProcess, timeoutMs }) {
  const result = await launch(command, [directory], { detached: true, stdio: 'ignore' }, {
    spawnProcess,
    timeoutMs,
    killOnTimeout: false,
  });
  if (result.timedOut || result.code === 0) return;
  throw new Error(failureMessage(directory, describe(result)));
}

export function openFolder(directory, {
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = EXPLORER_TIMEOUT_MS,
  fallbackTimeoutMs = POWERSHELL_TIMEOUT_MS,
} = {}) {
  if (platform === 'win32') return openOnWindows(directory, { spawnProcess, timeoutMs, fallbackTimeoutMs });
  return openWith(platform === 'darwin' ? 'open' : 'xdg-open', directory, { spawnProcess, timeoutMs });
}