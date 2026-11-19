let copyTimer;
const $ = (s) => document.querySelector(s),
  api = window.vault;
let state = { items: [], folders: [] },
  filter = 'all',
  selected = new Set(),
  selecting = false,
  current = null,
  toastTimer;
function toast(s) {
  $('#toast').textContent = s;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 4500);
}
async function action(fn) {
  try {
    return await fn();
  } catch (e) {
    toast('操作失败：' + e.message);
  }
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const size = (n) =>
  n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function render() {
  $('#total').textContent = state.items.length;
  $('#storage').textContent = size(state.items.reduce((a, i) => a + i.size, 0));
  const labels = {
    all: '全部表情',
    favorite: '我的常用',
    recent: '最近使用',
    animated: '动态表情',
  };
  $('#heading').textContent = labels[filter] || filter;
  document
    .querySelectorAll('[data-filter]')
    .forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  const sources = $('#sources');
  sources.replaceChildren();
  for (const s of [...new Set(state.items.map((i) => i.source))]) {
    const b = el('button', filter === s ? 'active' : '', '◦　' + s);
    b.onclick = () => {
      filter = s;
      render();
    };
    sources.append(b);
  }
  const q = $('#search').value.trim().toLowerCase();
  let items = state.items.filter(
    (i) =>
      (filter === 'all' ||
        (filter === 'recent'
          ? i.lastUsedAt
          : filter === 'favorite'
            ? i.favorite
            : filter === 'animated'
              ? i.animated
              : i.source === filter)) &&
      [i.name, i.source, i.ocrText || '', ...i.tags].join(' ').toLowerCase().includes(q),
  );
  const sort = $('#sort').value;
  items.sort(
    filter === 'recent' || sort === 'used'
      ? (a, b) => stickerOrderTime(b, true) - stickerOrderTime(a, true)
      : sort === 'name'
        ? (a, b) => a.name.localeCompare(b.name, 'zh')
        : sort === 'size'
          ? (a, b) => b.size - a.size
          : (a, b) => stickerOrderTime(b) - stickerOrderTime(a),
  );
  $('#count').textContent =
    `${items.length} 个表情 · ${items.filter((i) => i.animated).length} 个动图`;
  $('#bulk').hidden = !selecting;
  $('#selection-count').textContent = `已选 ${selected.size} 个`;
  $('#select-mode').textContent = selecting ? '正在多选' : '多选';
  const grid = $('#grid');
  grid.replaceChildren();
  for (const item of items) {
    const card = el('article', 'card' + (selected.has(item.id) ? ' selected' : ''));
    card.dataset.id = item.id;
    const surface = el('button', 'card-use');
    surface.type = 'button';
    surface.setAttribute('aria-label', item.name + (item.animated ? '，动图' : ''));
    surface.setAttribute('aria-pressed', selected.has(item.id));
    const thumb = el('div', 'thumb');
    const img = el('img');
    img.src = item.url;
    img.alt = item.name;
    img.loading = 'lazy';
    img.draggable = true;
    thumb.append(img);
    surface.append(thumb);
    const info = el('div', 'card-info');
    info.append(el('strong', '', item.name));
    const meta = el('small');
    meta.append(
      el('span', '', item.tags.length ? '# ' + item.tags[0] : item.source),
      el('span', '', size(item.size)),
    );
    info.append(meta);
    surface.append(info);
    if (item.animated) surface.append(el('span', 'badge', '▷ 动图'));
    surface.draggable = !selecting;
    surface.ondragstart = (e) => {
      e.preventDefault();
      clearTimeout(copyTimer);
      resetDrop();
      api.drag(item.id);
    };
    surface.title = '单击复制原文件 · 双击或右键管理';
    surface.onclick = (event) => {
      if (selecting) {
        selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id);
        render();
      } else {
        clearTimeout(copyTimer);
        if (event.detail > 1) return;
        const copy = () =>
          action(async () => {
            await api.copyOriginal(item.id);
            toast('已复制原文件，请在聊天窗口粘贴');
          });
        if (event.detail === 0) copy();
        else copyTimer = setTimeout(copy, 260);
      }
    };
    surface.ondblclick = () => {
      clearTimeout(copyTimer);
      if (!selecting) openDetail(item);
    };
    surface.oncontextmenu = (event) => {
      event.preventDefault();
      clearTimeout(copyTimer);
      if (!selecting) openDetail(item);
    };
    card.append(surface);
    if (!selecting)
      card.append(
        makeStickerActions(item, {
          api,
          beforeAction: () => clearTimeout(copyTimer),
          onMoved: () => {
            $('#sort').value = 'new';
            render();
            $('#grid').scrollIntoView({ block: 'start' });
          },
          onError: (error) => toast('操作失败：' + error.message),
          onDone: toast,
        }),
      );
    grid.append(card);
  }
  $('#empty').hidden = items.length > 0;
  if (!state.items.length) {
    $('#empty h2').textContent = '给你的表达，找个家';
    $('#empty p').innerHTML =
      '把 GIF、PNG、JPG 或 WebP 拖进来。<br>原始文件完整保存，动图依然会动。';
  } else {
    $('#empty h2').textContent = '没有匹配的表情';
    $('#empty p').textContent = '试试其他关键词、分类，或者导入新的表情。';
  }
  renderFolders();
  renderConnectors();
  renderPreferences();
}
function openDetail(item) {
  current = item.id;
  $('#ocr-detail').textContent =
    item.ocrStatus === 'done'
      ? item.ocrText
        ? 'OCR：' + item.ocrText
        : 'OCR 已完成，未识别到可靠文字。'
      : item.ocrStatus === 'error' || item.ocrStatus === 'interrupted'
        ? 'OCR 失败或被中断，已记录且不会自动重复执行。'
        : '等待后台 OCR 识别。';
  $('#detail-img').src = item.url;
  $('#detail-img').alt = item.name;
  $('#edit-name').value = item.name;
  $('#edit-tags').value = item.tags.join(', ');
  $('#metadata').textContent =
    `${item.ext.toUpperCase()} · ${item.animated ? '动态' : '静态'} · ${size(item.size)} · 来源：${item.source}`;
  $('#favorite').textContent = item.favorite ? '★ 已设为常用' : '♡ 设为常用';
  $('#detail').showModal();
}
function renderFolders() {
  const box = $('#folders');
  box.replaceChildren();
  if (!state.folders.length)
    box.append(el('p', 'hint', '还没有关联文件夹。选择存放表情的目录，即可自动收集。'));
  for (const f of state.folders) {
    const row = el('div', 'folder'),
      text = el('div');
    text.append(
      el('strong', '', f.source),
      el('p', '', f.path),
      el(
        'small',
        '',
        f.error
          ? '扫描失败：' + f.error
          : f.lastScan
            ? '最近扫描 ' + new Date(f.lastScan).toLocaleTimeString()
            : '等待扫描',
      ),
    );
    const b = el('button', '', '取消关联');
    b.onclick = () => action(() => api.removeFolder(f.path));
    row.append(text, b);
    box.append(row);
  }
}
async function doImport(paths) {
  $('#count').textContent = '正在导入原文件…';
  const r = await action(() => api.importFiles(paths));
  if (r)
    toast(
      `新增 ${r.added} 个 · 重复 ${r.duplicates} 个 · 跳过 ${r.skipped} 个${r.errors.length ? ' · 失败 ' + r.errors.length + ' 个' : ''}`,
    );
  render();
}
for (const b of document.querySelectorAll('.import')) b.onclick = () => doImport();
for (const b of document.querySelectorAll('[data-filter]'))
  b.onclick = () => {
    filter = b.dataset.filter;
    selected.clear();
    render();
  };
$('#search').oninput = render;
$('#sort').onchange = render;
$('#select-mode').onclick = () => {
  selecting = !selecting;
  selected.clear();
  render();
};
$('#cancel-select').onclick = () => {
  selecting = false;
  selected.clear();
  render();
};
for (const b of document.querySelectorAll('.close')) b.onclick = () => b.closest('dialog').close();
for (const id of ['manage', 'connections', 'empty-folder'])
  $('#' + id).onclick = () => {
    fillTransferForm();
    $('#settings').showModal();
  };
$('#save').onclick = () =>
  action(async () => {
    await api.update(current, {
      name: $('#edit-name').value.trim() || '未命名',
      tags: $('#edit-tags')
        .value.split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
    });
    toast('名称和标签已保存');
    $('#detail').close();
  });
$('#favorite').onclick = () =>
  action(async () => {
    const i = state.items.find((i) => i.id === current);
    await api.update(current, { favorite: !i.favorite });
    $('#favorite').textContent = state.items.find((i) => i.id === current)?.favorite
      ? '★ 已设为常用'
      : '♡ 设为常用';
  });
$('#detail-img').ondragstart = (e) => {
  e.preventDefault();
  api.drag(current);
};
$('#reveal').onclick = () => action(() => api.reveal(current));
$('#copy-path').onclick = () =>
  action(async () => {
    await api.copyPath(current);
    toast('已复制原文件路径');
  });
async function exportItems(ids) {
  if (!ids.length) return toast('先选择表情');
  const n = await action(() => api.exportFiles(ids));
  if (n) toast(`已导出 ${n} 个原文件`);
}
$('#export-one').onclick = () => exportItems([current]);
$('#bulk-export').onclick = () => exportItems([...selected]);
$('#remove').onclick = () =>
  action(async () => {
    await api.remove([current]);
    if (!state.items.some((i) => i.id === current)) $('#detail').close();
  });
$('#bulk-remove').onclick = () =>
  action(async () => {
    if (!selected.size) return toast('先选择表情');
    await api.remove([...selected]);
    selected.clear();
    render();
  });
$('#add-folder').onclick = () =>
  action(async () => {
    const b = $('#add-folder');
    b.disabled = true;
    try {
      await api.addFolder($('#folder-source').value);
    } finally {
      b.disabled = false;
    }
  });
$('#scan').onclick = () =>
  action(async () => {
    const b = $('#scan');
    b.disabled = true;
    try {
      await api.scan();
      toast('扫描完成，请查看各文件夹状态');
    } finally {
      b.disabled = false;
    }
  });
let depth = 0;
function resetDrop() {
  depth = 0;
  $('#drop-overlay').hidden = true;
}
window.addEventListener('blur', resetDrop);
document.addEventListener('dragend', resetDrop);
document.addEventListener('pointerup', resetDrop);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') resetDrop();
});
api.onDragEnd(resetDrop);
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  depth++;
  $('#drop-overlay').hidden = false;
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
});
document.addEventListener('dragleave', () => {
  depth = Math.max(0, depth - 1);
  if (!depth) $('#drop-overlay').hidden = true;
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  resetDrop();
  const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
  if (paths.length) doImport(paths);
});
document.addEventListener('keydown', (e) => {
  if (
    e.key === '/' &&
    !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) &&
    !document.querySelector('dialog[open]')
  ) {
    e.preventDefault();
    $('#search').focus();
  }
});
api.onChange((s) => {
  state = s;
  selected = new Set([...selected].filter((id) => state.items.some((i) => i.id === id)));
  render();
});
api.onError(toast);
action(async () => {
  state = await api.state();
  render();
});

function renderConnectors() {
  const isMac = state.platform === 'darwin';
  $('.paste-access').hidden = !isMac;
  $('#settings .connection-note').textContent = isMac
    ? 'QQ 每 30 秒检查缓存；微信首次需要登录助手副本，之后每 5 分钟同步；抖音在收藏面板加载时收集。'
    : 'QQ 每 30 秒检查已缓存收藏；Windows 微信需保持 4.x 登录并打开表情面板，成功后每 5 分钟同步；抖音在收藏面板加载时收集。';
  const box = $('#connector-list');
  box.replaceChildren();
  const defs = [
    ['qq', 'QQ', '自动定位个人收藏缓存，仅导入 Ori 原件，跳过 Thumb 缩略图。', '读取 QQ 收藏'],
    [
      'wechat',
      '微信',
      isMac
        ? '首次请退出微信；助手会打开副本，登录后打开表情面板。原微信安装不改动。'
        : state.platform === 'win32'
          ? '请登录微信 4.x 并打开收藏表情面板。支持默认、自定义和重定向的文档数据目录。'
          : '当前系统不提供微信读取助手，可手动导入导出的表情文件。',
      '读取微信收藏',
    ],
    [
      'douyin',
      '抖音',
      '在独立窗口登录，打开私信收藏表情面板。只读取表情列表，不发送消息。',
      '打开抖音并收集',
    ],
  ];
  for (const [id, name, description, label] of defs) {
    const s = state.connectors?.[id] || {};
    const row = el('section', 'connector'),
      head = el('div', 'connector-head');
    head.append(
      el('strong', '', name),
      el(
        'span',
        'status ' + (s.status || ''),
        {
          ready: '已连接',
          syncing: '读取中',
          waiting: '等待操作',
          error: '读取失败',
          partial: '部分完成',
          permission: '需要授权',
          disabled: '已停用',
          unsupported: '暂不支持',
        }[s.status] || '未连接',
      ),
    );
    row.append(head, el('p', '', description));
    if (s.message) row.append(el('p', 'connector-message', s.message));
    const actions = el('div', 'connector-actions');
    if (isMac && id === 'wechat' && s.needsCacheGrant) {
      const cache = el('button', 'primary', '授权助手缓存');
      cache.onclick = () => action(() => api.authorizeWechatCache());
      actions.append(cache);
    }
    let account;
    if (id === 'wechat' && s.accounts?.length > 1) {
      account = el('select');
      account.setAttribute('aria-label', '微信账号');
      for (const a of s.accounts) {
        const op = el('option', '', a);
        op.value = a;
        account.append(op);
      }
      account.value = s.account || s.accounts[0];
      actions.append(account);
    }
    if (id !== 'douyin') {
      const grant = el(
        'button',
        s.status === 'permission' ? 'primary' : '',
        isMac ? '授权目录' : '选择数据目录',
      );
      grant.disabled = s.status === 'syncing';
      grant.onclick = () => action(() => api.authorizeConnector(id));
      actions.append(grant);
    }
    const b = el('button', 'primary', s.status === 'syncing' ? '正在读取…' : label);
    b.disabled =
      s.status === 'syncing' || (id === 'wechat' && !['darwin', 'win32'].includes(state.platform));
    b.onclick = () => action(() => api.syncConnector(id, account?.value || s.account));
    actions.append(b);
    if (s.enabled) {
      const stop = el('button', '', '停用');
      stop.disabled = s.status === 'syncing';
      stop.onclick = () => action(() => api.disableConnector(id));
      actions.append(stop);
    }
    row.append(actions);
    box.append(row);
  }
}

$('#copy-original').onclick = () =>
  action(async () => {
    await api.copyOriginal(current);
    toast('已复制原文件，请在聊天窗口粘贴');
  });
$('#authorize-paste').onclick = () =>
  action(async () => {
    const r = await api.authorizePaste();
    toast(
      r.trusted ? '自动粘贴已启用' : '请在系统设置的辅助功能中允许表情仓，授权后即可自动粘贴。',
    );
  });

let preferenceBusy = false;
function renderPreferences() {
  const summary = state.ocr;
  $('#ocr-enabled').checked = summary?.enabled ?? true;
  $('#ocr-enabled').disabled = preferenceBusy || !summary;
  const phase = summary?.error
    ? summary.error
    : summary?.running
      ? summary.phase === 'loading'
        ? '正在准备本地识别引擎…'
        : '正在后台识别一张图片…'
      : summary?.enabled
        ? '每次一张，间隔约 2 秒；不会重复识别已处理图片。'
        : '已暂停；当前图片若正在识别，会处理完后暂停。';
  $('#ocr-status').textContent = summary
    ? `已完成 ${summary.done} / ${summary.total} · 待处理 ${summary.pending} · 失败或中断 ${summary.failed}。${phase}`
    : '正在读取识别队列…';
  $('#ocr-resume').hidden = !summary?.error;
  $('#ocr-resume').disabled = preferenceBusy;
  const startup = state.startup || {};
  $('#startup-enabled').checked = !!startup.requested || !!startup.enabled;
  $('#startup-enabled').disabled = preferenceBusy || !startup.supported;
  $('#startup-description').textContent = startup.message || '正在读取系统启动设置…';
  $('#startup-settings').hidden = !startup.requiresApproval && !startup.blocked;
  $('#startup-update').hidden = !startup.needsUpdate;
  renderTransferSettings();
}
async function setPreference(kind, enabled) {
  preferenceBusy = true;
  renderPreferences();
  try {
    if (kind === 'ocr') state.ocr = await api.setOcrEnabled(enabled);
    else state.startup = await api.setStartupEnabled(enabled);
  } catch (e) {
    toast('设置未生效：' + e.message);
  } finally {
    preferenceBusy = false;
    renderPreferences();
  }
}
$('#ocr-enabled').onchange = (event) => setPreference('ocr', event.target.checked);
$('#ocr-resume').onclick = () => setPreference('ocr', true);
$('#startup-enabled').onchange = (event) => setPreference('startup', event.target.checked);
$('#startup-update').onclick = () => setPreference('startup', true);
$('#startup-settings').onclick = () => action(() => api.openStartupSettings());
api.onOcrUpdate((update) => {
  state.ocr = update.summary;
  if (update.item) {
    const index = state.items.findIndex((i) => i.id === update.item.id);
    if (index >= 0) state.items[index] = update.item;
    const meta = document.querySelector(`.card[data-id="${update.item.id}"] .card-info small span`);
    if (meta)
      meta.textContent = update.item.tags.length ? '# ' + update.item.tags[0] : update.item.source;
    if ($('#search').value.trim()) render();
  }
  renderPreferences();
});

let transferUiBusy = false;
function fillTransferForm() {
  const dav = state.transferState?.dav;
  if (!dav) return;
  $('#dav-url').value = dav.url || '';
  $('#dav-username').value = dav.username || '';
  $('#dav-password').value = '';
}
function renderTransferSettings() {
  const value = state.transferState || {},
    dav = value.dav || {},
    task = value.transfer || {};
  const busy = transferUiBusy || task.busy;
  for (const id of [
    'backup-export',
    'backup-import',
    'dav-save',
    'dav-test',
    'dav-sync',
    'dav-forget',
    'dav-url',
    'dav-username',
    'dav-password',
  ])
    $('#' + id).disabled = !!busy;
  $('#transfer-cancel').hidden = !(task.busy && ['sync', 'test'].includes(task.kind));
  $('#dav-password').placeholder = dav.hasPassword
    ? '已保存密码；留空沿用'
    : '尚未保存密码（匿名访问可留空）';
  $('#dav-credential-status').textContent = dav.message || '';
  $('#dav-forget').hidden = !dav.hasPassword;
  $('#dav-last-sync').textContent = dav.lastSyncAt
    ? '上次成功同步：' + new Date(dav.lastSyncAt).toLocaleString()
    : '尚未成功同步；不会自动同步。';
  const labels = {
    preparing: '正在准备…',
    connecting: '正在连接 WebDAV…',
    checking: '正在验证远端防覆盖能力…',
    downloading: '正在取回远端备份…',
    validating: '正在校验备份原件…',
    exporting: '正在准备完整备份…',
    uploading: '正在上传合并后的备份…',
    conflict: '远端已更新，重新合并后再试…',
  };
  $('#transfer-status').textContent = task.busy
    ? (labels[task.phase] || '正在处理…') +
      (task.byteTotal
        ? ` ${size(task.bytes || 0)} / ${size(task.byteTotal)}`
        : task.total
          ? ` ${task.done || 0} / ${task.total}`
          : '')
    : task.message || '仅手动同步，不自动上传或下载。';
  const hints = value.migrationHints || {},
    lines = [];
  for (const f of hints.folders || []) lines.push(`文件夹：${f.source || '本地导入'} · ${f.path}`);
  for (const c of hints.connections || [])
    if (c.enabled) lines.push(`平台：${c.provider} · ${c.base || '重新登录或授权目录'}`);
  if (hints.startupRequested) lines.push('原设备曾开启登录自启；请在本机自行选择是否开启。');
  if (hints.webdav?.url && !dav.url)
    lines.push('WebDAV：' + hints.webdav.url + '（需重新填写密码）');
  $('#migration-hints').hidden = !lines.length;
  $('#migration-description').textContent = lines.join('\n');
}
async function transferAction(fn) {
  transferUiBusy = true;
  renderTransferSettings();
  try {
    const result = await fn();
    if (result?.message) toast(result.message);
    return result;
  } catch (error) {
    toast('操作未完成：' + error.message);
  } finally {
    transferUiBusy = false;
    renderTransferSettings();
  }
}
async function saveDavForm() {
  const dav = await api.saveWebDav({
    url: $('#dav-url').value,
    username: $('#dav-username').value,
    password: $('#dav-password').value,
  });
  state.transferState ??= {};
  state.transferState.dav = dav;
  $('#dav-password').value = '';
  return dav;
}
$('#backup-export').onclick = () => transferAction(() => api.exportBackup());
$('#backup-import').onclick = () =>
  transferAction(async () => {
    const result = await api.importBackup();
    if (result && !result.canceled) {
      state.transferState = await api.transferState();
      fillTransferForm();
    }
    return result;
  });
$('#dav-save').onclick = () =>
  transferAction(async () => {
    await saveDavForm();
    return { message: '连接已保存，不会自动同步。' };
  });
$('#dav-test').onclick = () =>
  transferAction(async () => {
    await saveDavForm();
    return api.testWebDav();
  });
$('#dav-sync').onclick = () =>
  transferAction(async () => {
    await saveDavForm();
    return api.syncWebDav();
  });
$('#dav-forget').onclick = () =>
  transferAction(async () => {
    state.transferState.dav = await api.forgetWebDavPassword();
    $('#dav-password').value = '';
    return { message: '已忘记密码。' };
  });
$('#transfer-cancel').onclick = () => api.cancelTransfer();
api.onTransferUpdate((update) => {
  state.transferState = update;
  renderTransferSettings();
});
