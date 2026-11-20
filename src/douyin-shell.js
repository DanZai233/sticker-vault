const status = document.getElementById('status');
window.douyinWindow.onStatus((message) => {
  status.textContent = message;
});
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await window.douyinWindow.action(button.dataset.action);
    } catch {
      status.textContent = '操作失败，请关闭导入窗口后重试。';
    } finally {
      button.disabled = false;
    }
  });
});
