/* Ferry Web UI — 无框架、无构建、离线可用。 */

const TOKEN = window.__FERRY_TOKEN__;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'dashboard',
  state: null,
  scan: null,
  selectedExport: new Set(),
  upload: null,
  pack: null,
  password: '',
  selectedConvs: new Set(),
  config: null,
};

/* ------------------------------------------------------------------ */
/* 基础                                                               */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-ferry-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${u[i]}`;
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function toast(message, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function spinner(text) {
  return `<span class="spinner"></span> ${esc(text)}`;
}

/* ------------------------------------------------------------------ */
/* 视图切换                                                           */
/* ------------------------------------------------------------------ */

const VIEWS = {
  dashboard: ['总览', '看看这台电脑上装了多少个 AI Agent，存了多少对话。'],
  export: ['导出', '把会话打包成一个文件，换电脑时带走。'],
  import: ['导入', '把归档写进目标 Agent 的原生存储，重启即可接着用。'],
  archive: ['归档', '自动备份与回滚。'],
  settings: ['设置', '运行环境与支持矩阵。'],
};

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  const [title, sub] = VIEWS[view];
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;
  $('#topbar-actions').innerHTML = '';
  if (view === 'archive') loadBackups();
  if (view === 'settings') loadSettings();
}

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) setView(btn.dataset.view);
});

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  try {
    state.state = await api('/api/state');
    state.config = state.state.config;
    $('#env-line').innerHTML = `${esc(state.state.platform)} · Node ${esc(state.state.node)}<br />${esc(state.state.home)}`;
    renderTargetSelect();
    await refreshScan();
  } catch (err) {
    toast(`启动失败：${err.message}`, 'err', 8000);
  }
}

async function refreshScan() {
  $('#agent-grid').innerHTML = `<div class="agent"><div class="row"><span class="spinner"></span><span class="vendor">正在扫描本机 Agent…</span></div></div>`;
  try {
    const scan = await api('/api/scan');
    state.scan = scan;
    renderDashboard();
    renderExportChecklist();
  } catch (err) {
    $('#agent-grid').innerHTML = `<div class="callout">扫描失败：${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* 总览                                                               */
/* ------------------------------------------------------------------ */

function renderDashboard() {
  const scan = state.scan;
  if (!scan) return;
  const installed = scan.results.filter((r) => r.count > 0);
  const total = scan.total;
  const bytes = scan.results.reduce((a, r) => a + (r.bytes || 0), 0);
  const last = scan.results.map((r) => r.last).filter(Boolean).sort().at(-1);

  const stats = [
    ['已安装 Agent', installed.length, `${scan.results.length} 个受支持`],
    ['可导出会话', total, '本机本地存储'],
    ['占用空间', fmtBytes(bytes), '原始文件'],
    ['最近活动', last ? fmtTime(last).slice(0, 10) : '—', last ? fmtTime(last).slice(11) : '暂无'],
  ];
  $('#stat-row').innerHTML = stats
    .map(
      ([label, num, hint], i) =>
        `<div class="stat ${i === 0 ? 'accent' : ''}"><div class="num">${esc(num)}</div><div class="lbl">${esc(label)} · ${esc(hint)}</div></div>`,
    )
    .join('');

  $('#agent-grid').innerHTML = scan.results
    .map((r) => {
      const on = r.count > 0;
      return `<div class="agent" data-agent="${esc(r.adapter)}" ${on ? 'role="button" tabindex="0"' : ''}>
        <div class="row">
          <span class="dot ${on ? 'on' : ''}"></span>
          <span class="name">${esc(r.name)}</span>
          ${r.region === 'cn' ? '<span class="badge cn">国内</span>' : ''}
          ${on ? '<span class="badge">点击导出</span>' : ''}
        </div>
        <div class="count">${r.error ? '<span style="font-size:12px;color:var(--red)">读取失败</span>' : `${r.count}<small>个会话</small>`}</div>
        <div class="meta"><span>${esc(r.vendor || '')}</span><span>${on ? fmtBytes(r.bytes) : '未检测到'}</span></div>
        <div class="meta"><span>${on ? '最近 ' + fmtTime(r.last) : esc(r.error || '')}</span><span></span></div>
      </div>`;
    })
    .join('');

  $('#scan-hint').innerHTML =
    total > 0
      ? `<b>下一步：</b>去 <a href="#" data-goto="export">导出</a> 勾选要带走的 Agent，生成一个 <code>.ferrypack</code> 文件。<br />
         换电脑后打开 Ferry → <a href="#" data-goto="import">导入</a>，选择目标 Agent，就能直接接着用。`
      : `本机没有检测到已安装的 Agent 会话。如果你要迁移的是 ChatGPT / Claude 这类云端对话，先在它们的设置里导出数据，再到 <a href="#" data-goto="import">导入</a> 页选择导出包。`;

  $$('.agent[role="button"]').forEach((el) => {
    const go = () => {
      const id = el.dataset.agent;
      state.selectedExport = new Set([id]);
      setView('export');
      renderExportChecklist();
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  });
  $$('[data-goto]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      setView(a.dataset.goto);
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 导出                                                               */
/* ------------------------------------------------------------------ */

function renderExportChecklist() {
  const scan = state.scan;
  if (!scan) return;
  const rows = scan.results
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((r) => {
      const on = state.selectedExport.has(r.adapter);
      const disabled = r.count === 0;
      return `<label class="check ${on ? 'checked' : ''}" data-check="${esc(r.adapter)}">
        <input type="checkbox" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''} data-agent="${esc(r.adapter)}" />
        <span class="t"><b>${esc(r.name)}</b><span>${esc(r.vendor || '')}${r.region === 'cn' ? ' · 国内' : ''}</span></span>
        <span class="n">${disabled ? '—' : r.count}</span>
      </label>`;
    });
  $('#export-agents').innerHTML = rows.join('');
  $$('#export-agents input[data-agent]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.agent;
      if (cb.checked) state.selectedExport.add(id);
      else state.selectedExport.delete(id);
      cb.closest('.check').classList.toggle('checked', cb.checked);
    });
  });
}

$('#btn-select-all').addEventListener('click', () => {
  state.selectedExport = new Set(state.scan.results.filter((r) => r.count > 0).map((r) => r.adapter));
  renderExportChecklist();
});
$('#btn-select-none').addEventListener('click', () => {
  state.selectedExport.clear();
  renderExportChecklist();
});

$('#export-encrypt').addEventListener('change', (e) => {
  $('#password-field').style.display = e.target.checked ? '' : 'none';
  if (e.target.checked) $('#export-password').focus();
});

$('#btn-export').addEventListener('click', async () => {
  const agents = [...state.selectedExport];
  if (!agents.length) {
    toast('先选择至少一个 Agent', 'err');
    return;
  }
  const encrypt = $('#export-encrypt').checked;
  const password = $('#export-password').value;
  if (encrypt && password.length < 8) {
    toast('密码至少 8 位', 'err');
    return;
  }
  const btn = $('#btn-export');
  btn.disabled = true;
  btn.innerHTML = spinner('正在打包…');
  $('#export-hint').textContent = '会话较多时需要一点时间，请勿关闭页面。';
  try {
    const res = await api('/api/export', {
      method: 'POST',
      body: {
        agents,
        since: $('#export-since').value || undefined,
        limit: Number($('#export-limit').value) || 0,
        label: $('#export-label').value || undefined,
        redact: $('#export-redact').checked,
        projects: $('#export-projects').checked,
        password: encrypt ? password : undefined,
      },
    });
    renderExportResult(res, encrypt);
    toast(`已导出 ${res.summary.conversations} 个会话`, 'ok');
  } catch (err) {
    toast(err.message, 'err', 7000);
  } finally {
    btn.disabled = false;
    btn.textContent = '打包导出';
    $('#export-hint').textContent = '';
  }
});

function renderExportResult(res, encrypted) {
  const panel = $('#export-result');
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <h2>导出完成</h2>
    <div class="file-info">
      <span style="font-size:20px">📦</span>
      <div style="flex:1">
        <div style="font-weight:600">${esc(res.file)}</div>
        <div style="color:var(--text-3);font-size:11.5px">${esc(res.summary.text)} · ${fmtBytes(res.bytes)}${encrypted ? ' · AES-256-GCM 加密' : ''}</div>
      </div>
      <a class="btn primary sm" href="/api/download?file=${encodeURIComponent(res.file)}" download>下载</a>
    </div>
    ${
      res.errors?.length
        ? `<p class="muted small" style="margin-top:12px">${res.errors.length} 个会话读取失败：${esc(
            res.errors.map((e) => `${e.adapter}: ${e.error}`).join('；'),
          )}</p>`
        : ''
    }
    <div class="conv-list" style="margin-top:12px;max-height:240px">
      ${res.conversations
        .map(
          (c) => `<div class="conv"><span class="ti">${esc(c.title)}</span><span class="me">${esc(c.source)} · ${c.messages} 条</span></div>`,
        )
        .join('')}
    </div>
    <div class="callout" style="margin-top:14px">
      把文件拷到新电脑，打开 Ferry → 导入，选择目标 Agent。<br />
      ${res.projects?.length ? `已包含 ${res.projects.length} 个项目；导入时可指定“恢复项目文件到”。<br />` : ''}
      ${res.projectExcluded ? `为安全和体积考虑，已排除 ${res.projectExcluded} 个凭据、依赖目录或链接。<br />` : ''}
      ${res.projectWarnings?.length ? `注意：${esc(res.projectWarnings.join('；'))}<br />` : ''}
      本机保存位置：<code>${esc(state.state.ferryHome)}\\exports</code>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 导入                                                               */
/* ------------------------------------------------------------------ */

const dz = $('#dropzone');
$('#btn-browse').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#file-input').click();
});
dz.addEventListener('click', () => $('#file-input').click());
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('drag');
});
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  const file = e.dataTransfer.files?.[0];
  if (file) uploadFile(file);
});
$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) uploadFile(file);
});

async function uploadFile(file) {
  $('#file-info').classList.remove('hidden');
  $('#file-info').innerHTML = spinner(`正在读取 ${file.name}…`);
  $('#pack-panel').classList.add('hidden');
  $('#import-target-panel').classList.add('hidden');
  $('#import-result').classList.add('hidden');
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'x-ferry-token': TOKEN },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    state.upload = data;
    state.password = '';
    $('#import-password-row').classList.add('hidden');
    $('#file-info').innerHTML = `<span>📄</span><div style="flex:1"><b>${esc(data.name)}</b><div style="color:var(--text-3);font-size:11.5px">${fmtBytes(
      data.size,
    )}</div></div><button class="btn ghost sm" id="btn-reupload">重选</button>`;
    $('#btn-reupload').addEventListener('click', () => $('#file-input').click());
    await inspectUpload();
  } catch (err) {
    $('#file-info').innerHTML = `<span style="color:var(--red)">✖</span> ${esc(err.message)}`;
  }
}

async function inspectUpload() {
  try {
    const pack = await api('/api/inspect', { method: 'POST', body: { token: state.upload.token, password: state.password || undefined } });
    state.pack = pack;
    state.selectedConvs = new Set(pack.conversations.map((c) => c.id));
    renderPack(pack);
  } catch (err) {
    if (err.status === 401 && err.data?.needsPassword) {
      $('#import-password-row').classList.remove('hidden');
      $('#import-password').focus();
      toast('该归档已加密，请输入密码', 'info');
      return;
    }
    toast(err.message, 'err', 7000);
  }
}

$('#btn-unlock').addEventListener('click', async () => {
  state.password = $('#import-password').value;
  if (!state.password) return toast('请输入密码', 'err');
  await inspectUpload();
});

function renderPack(pack) {
  const m = pack.manifest;
  $('#pack-panel').classList.remove('hidden');
  $('#pack-count').textContent = `${pack.conversations.length} 个会话 · ${m.stats?.messages || 0} 条消息${pack.projects?.length ? ` · ${pack.projects.length} 个项目` : ''} · ${fmtBytes(m.stats?.archiveBytes || 0)}`;
  $('#conv-list').innerHTML = pack.conversations
    .map(
      (c) => `<div class="conv" data-id="${esc(c.id)}">
        <input type="checkbox" checked data-cid="${esc(c.id)}" />
        <span class="ti" title="${esc(c.title)}">${esc(c.title)}</span>
        <span class="me">${esc(c.source)}${c.workspace ? ' · ' + esc(shortPath(c.workspace)) : ''}</span>
        <button class="peek" data-preview="${esc(c.id)}">预览</button>
      </div>`,
    )
    .join('');
  $$('#conv-list input[data-cid]').forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedConvs.add(cb.dataset.cid);
      else state.selectedConvs.delete(cb.dataset.cid);
    }),
  );
  $$('#conv-list .peek').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const res = await api('/api/preview', {
          method: 'POST',
          body: { token: state.upload.token, id: b.dataset.preview, password: state.password || undefined },
        });
        showModal(res.title, res.markdown);
      } catch (err) {
        toast(err.message, 'err');
      }
    }),
  );
  $('#import-target-panel').classList.remove('hidden');
}

$('#btn-conv-all').addEventListener('click', () => {
  state.selectedConvs = new Set(state.pack.conversations.map((c) => c.id));
  $$('#conv-list input[data-cid]').forEach((cb) => (cb.checked = true));
});
$('#btn-conv-none').addEventListener('click', () => {
  state.selectedConvs.clear();
  $$('#conv-list input[data-cid]').forEach((cb) => (cb.checked = false));
});

function shortPath(p) {
  const s = String(p);
  return s.length > 34 ? '…' + s.slice(-33) : s;
}

function renderTargetSelect() {
  const importable = state.state.targets.filter((t) => t.capabilities.import);
  $('#import-target').innerHTML = importable
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.region === 'cn' ? '（国内）' : ''}</option>`)
    .join('');
}

$('#btn-import').addEventListener('click', async () => {
  if (!state.pack) return;
  const target = $('#import-target').value;
  const dryRun = $('#import-dry').checked;
  const ids = [...state.selectedConvs];
  if (!ids.length) return toast('至少选择一个会话', 'err');
  const btn = $('#btn-import');
  btn.disabled = true;
  btn.innerHTML = spinner(dryRun ? '正在预演…' : '正在写入…');
  try {
    const res = await api('/api/import', {
      method: 'POST',
      body: {
        token: state.upload.token,
        password: state.password || undefined,
        target,
        ids,
        workspace: $('#import-workspace').value.trim() || undefined,
        restoreProjects: $('#import-projects').value.trim() || undefined,
        map: $('#import-map')
          .value.split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        dryRun,
        backup: true,
      },
    });
    renderImportResult(res, dryRun);
    toast(dryRun ? '预演完成，未改动任何文件' : `已写入 ${res.results.filter((r) => !r.error).length} 个会话`, 'ok');
  } catch (err) {
    toast(err.message, 'err', 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始导入';
  }
});

function renderImportResult(res, dryRun) {
  const panel = $('#import-result');
  panel.classList.remove('hidden');
  const ok = res.results.filter((r) => !r.error).length;
  const bad = res.results.filter((r) => r.error);
  panel.innerHTML = `
    <h2>${dryRun ? '预演结果' : '导入完成'} <span class="pill">${ok} 成功${bad.length ? ` / ${bad.length} 失败` : ''}</span></h2>
    ${res.results
      .map(
        (r) => `<div class="result-item">
          <span class="st" style="color:${r.error ? 'var(--red)' : 'var(--green)'}">${r.error ? '✖' : '✔'}</span>
          <div class="bd">
            <div class="tt">${esc(r.title)}</div>
            <div class="n">${esc(r.error || r.workspace || '')}</div>
            ${(r.notes || []).map((n) => `<div class="n">· ${esc(n)}</div>`).join('')}
            ${r.resume ? `<pre class="cmd">cd "${esc(r.resume.cwd)}"&#10;${esc(r.resume.command)}</pre>` : ''}
          </div>
        </div>`,
      )
      .join('')}
    ${res.backup && !dryRun ? `<p class="muted small" style="margin-top:12px">已自动备份：<code>${esc(res.backup)}</code>，可在「归档」页回滚。</p>` : ''}
    ${res.projects?.length ? `<div class="callout" style="margin-top:12px">${dryRun ? '将恢复' : '已恢复'} ${res.projects.length} 个项目目录：${res.projects.map((p) => `<code>${esc(p.path)}</code>`).join('、')}</div>` : ''}
    ${!dryRun ? `<div class="callout" style="margin-top:12px">${esc(res.resumeHint || '重启目标应用后，在历史列表里即可看到并继续。')}</div>` : ''}`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ */
/* 归档 / 备份                                                        */
/* ------------------------------------------------------------------ */

async function loadBackups() {
  const box = $('#backup-list');
  box.innerHTML = spinner('读取备份…');
  try {
    const res = await api('/api/backups');
    if (!res.items.length) {
      box.innerHTML = `<p class="muted">还没有备份。导入时会自动创建。位置：<code>${esc(res.dir)}</code></p>`;
      return;
    }
    box.innerHTML = `<table class="matrix"><thead><tr><th>时间</th><th>目标</th><th>文件</th><th>大小</th><th></th></tr></thead><tbody>
      ${res.items
        .map(
          (b) => `<tr><td>${fmtTime(b.createdAt)}</td><td>${esc(b.target || '—')}</td><td>${b.files}</td><td>${fmtBytes(
            b.bytes,
          )}</td><td><button class="btn ghost sm" data-rollback="${esc(b.id)}">回滚</button></td></tr>`,
        )
        .join('')}
    </tbody></table>`;
    $$('[data-rollback]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm(`确认回滚备份 ${btn.dataset.rollback}？`)) return;
        try {
          const r = await api('/api/rollback', { method: 'POST', body: { id: btn.dataset.rollback } });
          toast(`已回滚 ${r.id}`, 'ok');
          loadBackups();
        } catch (err) {
          toast(err.message, 'err');
        }
      }),
    );
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  const s = state.state;
  $('#settings-env').innerHTML = [
    ['版本', `Ferry ${s.version}`],
    ['平台', `${s.platform} · Node ${s.node}`],
    ['用户目录', s.home],
    ['Ferry 目录', s.ferryHome],
    ['界面', location.origin],
  ]
    .map(([k, v]) => `<div class="kv-row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`)
    .join('');

  $('#target-matrix').innerHTML = `<table class="matrix"><thead><tr>
      <th>Agent</th><th>厂商</th><th>导出</th><th>原生导入</th><th>续聊</th><th>工具调用</th><th>附件</th>
    </tr></thead><tbody>
      ${s.targets
        .map(
          (t) => `<tr>
        <td>${esc(t.name)}${t.region === 'cn' ? ' <span class="badge cn">国内</span>' : ''}</td>
        <td class="muted">${esc(t.vendor || '')}</td>
        <td class="${t.capabilities.export ? 'yes' : 'no'}">${t.capabilities.export ? '✓' : '—'}</td>
        <td class="${t.capabilities.import ? 'yes' : 'no'}">${t.capabilities.import ? '✓' : '—'}</td>
        <td class="${t.capabilities.resume ? 'yes' : 'no'}">${t.capabilities.resume ? '✓' : '—'}</td>
        <td class="${t.capabilities.tools ? 'yes' : 'no'}">${t.capabilities.tools ? '✓' : '—'}</td>
        <td class="${t.capabilities.attachments ? 'yes' : 'no'}">${t.capabilities.attachments ? '✓' : '—'}</td>
      </tr>`,
        )
        .join('')}
    </tbody></table>`;
}

/* ------------------------------------------------------------------ */
/* 模态框 / Markdown                                                  */
/* ------------------------------------------------------------------ */

function showModal(title, markdown) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = mdToHtml(markdown);
  $('#modal').classList.remove('hidden');
}
$('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) $('#modal').classList.add('hidden');
});

function mdToHtml(src) {
  const fence = [];
  let text = String(src || '').replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    fence.push(`<pre><code>${esc(code)}</code></pre>`);
    return `\u0000FENCE${fence.length - 1}\u0000`;
  });
  text = esc(text);
  const lines = text.split(/\r?\n/);
  const out = [];
  let list = null;
  const flush = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\u0000FENCE\d+\u0000$/.test(line.trim())) {
      flush();
      out.push(fence[Number(line.trim().match(/\d+/)[0])]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(h[1].length, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flush();
      out.push('<hr />');
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul) {
      if (!list || list.tag !== 'ul') {
        flush();
        list = { tag: 'ul', items: [] };
      }
      list.items.push(inline(ul[1]));
      continue;
    }
    if (ol) {
      if (!list || list.tag !== 'ol') {
        flush();
        list = { tag: 'ol', items: [] };
      }
      list.items.push(inline(ol[1]));
      continue;
    }
    const q = /^&gt;\s?(.*)$/.exec(line);
    if (q) {
      flush();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }
    flush();
    out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('\n');
}

function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<em>[图片 $1]</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/* ------------------------------------------------------------------ */

$('#btn-rescan').addEventListener('click', refreshScan);
boot();
