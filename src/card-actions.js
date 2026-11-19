// Shared actions are siblings of the image button, never nested clickable buttons.
window.makeStickerActions = function (
  item,
  { api, beforeAction = () => {}, onMoved = () => {}, onError = () => {}, onDone = () => {} },
) {
  const box = document.createElement('div');
  box.className = 'card-actions';
  for (const type of ['favorite', 'front']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = type === 'favorite' ? 'quick-favorite' : 'quick-front';
    button.draggable = false;
    button.textContent = type === 'favorite' ? (item.favorite ? '♥' : '♡') : '↑';
    const label = type === 'favorite' ? (item.favorite ? '取消收藏' : '收藏') : '移到第一位';
    button.title = label;
    button.setAttribute('aria-label', label + '：' + item.name);
    if (type === 'favorite') button.setAttribute('aria-pressed', !!item.favorite);
    button.onclick = async (event) => {
      event.stopPropagation();
      beforeAction();
      button.disabled = true;
      try {
        if (type === 'favorite') await api.update(item.id, { favorite: !item.favorite });
        else {
          await api.moveToFront(item.id);
          onMoved();
        }
        onDone(type === 'favorite' ? (item.favorite ? '已取消收藏' : '已收藏') : '已移到第一位');
      } catch (error) {
        onError(error);
      } finally {
        button.disabled = false;
      }
    };
    button.ondblclick = (event) => event.stopPropagation();
    button.oncontextmenu = (event) => event.stopPropagation();
    box.append(button);
  }
  return box;
};
// Moving is an ordering action, not a toggle or a permanent pinned state.
window.stickerOrderTime = (item, recent = false) =>
  Math.max(item.moveOrderAt || 0, (recent ? item.lastUsedAt : item.createdAt) || 0);
