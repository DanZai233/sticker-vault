const api = window.vault;
let state = { items: [] },
  filter = 'recent';
const $ = (s) => document.querySelector(s);
let matchingItems = [],
  shown = 0;
const more = document.createElement('button');
more.id = 'load-more';
more.onclick = () => appendPage();
const observer = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) appendPage();
  },
  { root: $('#items'), rootMargin: '100px' },
);
observer.observe(more);
function render() {
  const q = $('#search').value.trim().toLowerCase();
  let items = state.items.filter(
    (i) =>
      (filter === 'all' || (filter === 'recent' ? i.lastUsedAt : i.favorite)) &&
      [i.name, i.ocrText || '', ...i.tags].join(' ').toLowerCase().includes(q),
  );
  items.sort(
    filter === 'recent'
      ? (a, b) => stickerOrderTime(b, true) - stickerOrderTime(a, true)
      : (a, b) => stickerOrderTime(b) - stickerOrderTime(a),
  );
  const box = $('#items');
  box.replaceChildren();
  box.scrollTop = 0;
  matchingItems = items;
  shown = 0;
  appendPage();
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent =
      filter === 'recent'
        ? '用过的表情会出现在这里。先切换到「全部」，点击或拖出一个表情。'
        : '暂无匹配表情';
    box.append(p);
  }
}
function appendPage() {
  const box = $('#items');
  more.remove();
  const page = matchingItems.slice(shown, shown + 120);
  for (const i of page) {
    const tile = document.createElement('div');
    tile.className = 'item';
    tile.title = i.name;
    tile.dataset.id = i.id;
    const b = document.createElement('button');
    b.className = 'item-use';
    b.title = i.name;
    b.setAttribute('aria-label', i.name);
    b.draggable = true;
    const img = document.createElement('img');
    img.src = i.url;
    img.alt = i.name;
    img.draggable = true;
    img.loading = 'lazy';
    b.append(img);
    if (i.animated) {
      const badge = document.createElement('small');
      badge.textContent = '动图';
      b.append(badge);
    }
    b.ondragstart = (e) => {
      e.preventDefault();
      api.drag(i.id);
    };
    b.onclick = async () => {
      try {
        const r = await api.insert(i.id);
        $('#hint').textContent = r.pasted
          ? '已粘贴原文件'
          : r.copied
            ? '已复制原文件，请在聊天窗口按 ⌘V / Ctrl+V'
            : '复制失败，请改用拖拽';
      } catch (e) {
        $('#hint').textContent = '操作失败：' + e.message;
      }
    };
    tile.append(
      b,
      makeStickerActions(i, {
        api,
        onMoved: render,
        onError: (error) => {
          $('#hint').textContent = '操作失败：' + error.message;
        },
        onDone: (message) => {
          $('#hint').textContent = message;
        },
      }),
    );
    box.append(tile);
  }
  shown += page.length;
  $('#count').textContent = `共 ${matchingItems.length} 个 · 已显示 ${shown} 个`;
  if (shown < matchingItems.length) {
    more.textContent = `继续加载（还有 ${matchingItems.length - shown} 个）`;
    box.append(more);
  }
}
$('#search').oninput = render;
for (const b of document.querySelectorAll('nav button'))
  b.onclick = () => {
    filter = b.dataset.filter;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  };
$('#open-main').onclick = () => api.openMain();
api.onChange((s) => {
  state = s;
  $('#hint').textContent =
    s.platform === 'darwin'
      ? '点击复制原文件；授权后可自动粘贴'
      : '点击复制原文件，然后回到聊天窗口按 Ctrl+V';
  render();
});
api.onError((s) => ($('#hint').textContent = s));
api.state().then((s) => {
  state = s;
  $('#hint').textContent =
    s.platform === 'darwin'
      ? '点击复制原文件；授权后可自动粘贴'
      : '点击复制原文件，然后回到聊天窗口按 Ctrl+V';
  render();
});

api.onOcrUpdate((update) => {
  if (update.item) {
    const index = state.items.findIndex((i) => i.id === update.item.id);
    if (index >= 0) state.items[index] = update.item;
    if ($('#search').value.trim()) render();
  }
});
