const status = document.getElementById('status');
window.douyinWindow.onStatus((message) => {
  status.textContent = message;
});
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await window.douyinWindow.action(button.dataset.action);
      if (button.dataset.action === 'collect-browser')
        status.textContent = '独立采集浏览器已打开。请在其中登录并打开消息的收藏表情面板。';
    } catch {
      status.textContent = '操作失败，请关闭导入窗口后重试。';
    } finally {
      button.disabled = false;
    }
  });
});
