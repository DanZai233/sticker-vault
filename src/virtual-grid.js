// A keyed, bounded set of live cards. Original animation URLs are used only on visible rows.
window.VirtualStickerGrid = class {
  constructor(
    container,
    { scroller = window, minWidth = 145, columns, rowHeight = 246, gap = 17, create, patch },
  ) {
    Object.assign(this, {
      container,
      scroller,
      minWidth,
      fixedColumns: columns,
      rowHeight,
      gap,
      create,
      patch,
    });
    this.items = [];
    this.nodes = new Map();
    this.stage = document.createElement('div');
    this.stage.className = 'virtual-stage';
    container.replaceChildren(this.stage);
    this.stage.style.position = 'relative';
    container.classList.add('virtual-grid');
    this.schedule = () => {
      if (!this.frame)
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.draw();
        });
    };
    scroller.addEventListener('scroll', this.schedule, { passive: true });
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(container);
    window.addEventListener('resize', this.schedule);
    this.stage.addEventListener('keydown', (event) => this.keydown(event));
  }
  metrics() {
    const width = this.container.clientWidth || 1,
      columns =
        this.fixedColumns ||
        Math.max(1, Math.floor((width + this.gap) / (this.minWidth + this.gap))),
      pitch = this.rowHeight + this.gap;
    const top =
        this.scroller === window ? this.container.getBoundingClientRect().top + window.scrollY : 0,
      scroll = this.scroller === window ? window.scrollY : this.scroller.scrollTop,
      height = this.scroller === window ? window.innerHeight : this.scroller.clientHeight;
    return { width, columns, pitch, top, scroll, height };
  }
  scrollTo(value) {
    if (this.scroller === window) window.scrollTo({ top: Math.max(0, value), behavior: 'instant' });
    else this.scroller.scrollTop = Math.max(0, value);
  }
  update(items, { reset = false } = {}) {
    const old = this.metrics(),
      relative = old.scroll - old.top,
      index = Math.max(0, Math.floor(relative / old.pitch)) * old.columns;
    const candidates =
      relative > 0
        ? this.items.slice(index, index + old.columns * 2).map((item, n) => ({
            id: item.id,
            offset: Math.floor((index + n) / old.columns) * old.pitch - relative,
          }))
        : [];
    this.items = items;
    this.index = new Map(items.map((item, i) => [item.id, i]));
    this.stage.style.height =
      Math.max(0, Math.ceil(items.length / old.columns) * old.pitch - this.gap) + 'px';
    if (reset) this.scrollTo(this.scroller === window ? Math.min(old.scroll, old.top) : 0);
    else {
      const anchor = candidates.find((item) => this.index.has(item.id));
      if (anchor)
        this.scrollTo(
          old.top + Math.floor(this.index.get(anchor.id) / old.columns) * old.pitch - anchor.offset,
        );
    }
    this.draw();
  }
  draw() {
    const m = this.metrics(),
      relative = m.scroll - m.top,
      rows = Math.ceil(this.items.length / m.columns),
      firstRow = Math.max(0, Math.floor(relative / m.pitch) - 2),
      lastRow = Math.min(rows, Math.ceil((relative + m.height) / m.pitch) + 2),
      start = Math.min(this.items.length, firstRow * m.columns),
      end = Math.max(start, Math.min(this.items.length, lastRow * m.columns));
    this.stage.style.height = Math.max(0, rows * m.pitch - this.gap) + 'px';
    const wanted = new Set();
    for (let index = start; index < end; index++) wanted.add(this.items[index].id);
    const focused = document.activeElement?.closest('[data-id]');
    if (focused && this.stage.contains(focused) && this.index?.has(focused.dataset.id))
      wanted.add(focused.dataset.id);
    for (const [id, node] of this.nodes)
      if (!wanted.has(id)) {
        node.querySelectorAll('img').forEach((image) => image.removeAttribute('src'));
        node.remove();
        this.nodes.delete(id);
      }
    const width = (m.width - (m.columns - 1) * this.gap) / m.columns;
    for (const id of wanted) {
      const index = this.index.get(id),
        item = this.items[index];
      let node = this.nodes.get(id);
      if (!node) {
        node = this.create(item);
        this.nodes.set(id, node);
        this.stage.append(node);
      }
      this.patch(node, item);
      const row = Math.floor(index / m.columns),
        top = row * m.pitch;
      Object.assign(node.style, {
        position: 'absolute',
        top: top + 'px',
        left: (index % m.columns) * (width + this.gap) + 'px',
        width: width + 'px',
        height: this.rowHeight + 'px',
      });
      node.setAttribute('aria-posinset', index + 1);
      node.setAttribute('aria-setsize', this.items.length);
      const visible = top + this.rowHeight > relative && top < relative + m.height;
      for (const image of node.querySelectorAll('img[data-original-src]')) {
        const source = image.dataset.originalSrc;
        if (visible) {
          if (image.getAttribute('src') !== source) image.setAttribute('src', source);
        } else image.removeAttribute('src');
      }
    }
    // Keep DOM order meaningful for tab navigation without disconnecting unchanged nodes.
    const ordered = [...this.nodes.values()].sort(
      (a, b) => this.index.get(a.dataset.id) - this.index.get(b.dataset.id),
    );
    let cursor = this.stage.firstElementChild;
    for (const node of ordered) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      else
        this.stage.moveBefore
          ? this.stage.moveBefore(node, cursor)
          : this.stage.insertBefore(node, cursor);
    }
    this.range = { start, end, total: this.items.length };
  }
  reveal(index) {
    if (!this.items.length) return;
    index = Math.max(0, Math.min(index, this.items.length - 1));
    const m = this.metrics(),
      top = m.top + Math.floor(index / m.columns) * m.pitch;
    if (top < m.scroll) this.scrollTo(top);
    else if (top + this.rowHeight > m.scroll + m.height)
      this.scrollTo(top + this.rowHeight - m.height);
    this.draw();
    this.nodes
      .get(this.items[index].id)
      ?.querySelector('.card-use,.item-use,button')
      ?.focus({ preventScroll: true });
  }
  keydown(event) {
    if (!event.target.matches('.card-use,.item-use')) return;
    const tile = event.target.closest('[data-id]'),
      index = this.index.get(tile?.dataset.id);
    if (index === undefined) return;
    const columns = this.metrics().columns,
      changes = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    let target;
    if (event.key in changes) target = index + changes[event.key];
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = this.items.length - 1;
    else return;
    event.preventDefault();
    this.reveal(target);
  }
};
