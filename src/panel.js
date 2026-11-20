const api = window.vault;
let state = { items: [] },
  filter = 'recent',
  lastSignature = '';
const $ = (selector) => document.querySelector(selector);
function createTile(initial) {
  const tile = document.createElement('div');
  tile.className = 'item';
  tile.dataset.id = initial.id;
  const item = (tile._item = { ...initial }),
    button = document.createElement('button');
  button.className = 'item-use';
  button.draggable = true;
  const image = document.createElement('img');
  image.draggable = true;
  button.append(image);
  button.ondragstart = (event) => {
    event.preventDefault();
    api.drag(item.id);
  };
  button.onclick = async () => {
    try {
      const result = await api.insert(item.id);
      $('#hint').textContent = result.pasted
        ? '已粘贴原文件'
        : result.copied
          ? '已复制原文件，请在聊天窗口按 ⌘V / Ctrl+V'
          : '复制失败，请改用拖拽';
    } catch (error) {
      $('#hint').textContent = '操作失败：' + error.message;
    }
  };
  tile.append(
    button,
    makeStickerActions(item, {
      api,
      onMoved: () => {
        render({ reset: true });
        panelGrid.reveal(0);
      },
      onError: (error) => {
        $('#hint').textContent = '操作失败：' + error.message;
      },
      onDone: (message) => {
        $('#hint').textContent = message;
      },
    }),
  );
  return tile;
}
function patchTile(tile, value) {
  const item = Object.assign(tile._item, value),
    button = tile.querySelector('.item-use'),
    image = tile.querySelector('img');
  tile.title = button.title = item.name;
  button.setAttribute('aria-label', item.name);
  image.alt = item.name;
  image.dataset.originalSrc = item.url;
  if (item.animated && !tile.querySelector('small')) {
    const badge = document.createElement('small');
    badge.textContent = '动图';
    button.append(badge);
  }
  tile.querySelector('.card-actions').refresh(item);
}
const panelGrid = new VirtualStickerGrid($('#items'), {
  scroller: $('#items'),
  columns: 4,
  rowHeight: 84,
  gap: 8,
  create: createTile,
  patch: patchTile,
});
function render({ reset = false } = {}) {
  const query = $('#search').value.trim().toLowerCase();
  const items = state.items.filter(
    (item) =>
      (filter === 'all' || (filter === 'recent' ? item.lastUsedAt : item.favorite)) &&
      [item.name, item.ocrText || '', ...item.tags].join(' ').toLowerCase().includes(query),
  );
  items.sort(
    filter === 'recent'
      ? (a, b) => stickerOrderTime(b, true) - stickerOrderTime(a, true)
      : (a, b) => stickerOrderTime(b) - stickerOrderTime(a),
  );
  const signature = filter + '|' + query;
  panelGrid.update(items, { reset: reset || signature !== lastSignature });
  lastSignature = signature;
  $('#count').textContent = `共 ${items.length} 个 · 滚动浏览全部`;
  $('#empty').hidden = !!items.length;
  $('#empty').textContent =
    filter === 'recent' ? '用过的表情会出现在这里。切换到「全部」选择表情。' : '暂无匹配表情';
}
$('#search').oninput = render;
for (const button of document.querySelectorAll('nav button'))
  button.onclick = () => {
    filter = button.dataset.filter;
    document
      .querySelectorAll('nav button')
      .forEach((other) => other.classList.toggle('active', other === button));
    render({ reset: true });
  };
$('#open-main').onclick = () => api.openMain();
api.onChange((value) => {
  state = value;
  render();
});
api.onError((message) => {
  $('#hint').textContent = message;
});
api.state().then((value) => {
  state = value;
  $('#hint').textContent =
    value.platform === 'darwin'
      ? '点击复制原文件；授权后可自动粘贴'
      : '点击复制原文件，然后回到聊天窗口按 Ctrl+V';
  render();
});
api.onOcrUpdate((update) => {
  if (update.item) {
    const index = state.items.findIndex((item) => item.id === update.item.id);
    if (index >= 0) state.items[index] = update.item;
    const tile = panelGrid.nodes.get(update.item.id);
    if (tile) patchTile(tile, update.item);
    if ($('#search').value.trim()) render();
  }
});

api.onItemUpdate((update) => {
  const index = state.items.findIndex((item) => item.id === update.item.id);
  if (index < 0) return;
  state.items[index] = update.item;
  if (update.move) {
    state.items.splice(index, 1);
    state.items.unshift(update.item);
  }
  render();
});
