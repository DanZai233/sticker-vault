(function (root) {
  const help = (id, platform, status = {}) => {
    const steps = [];
    if (['permission', 'error'].includes(status.status))
      steps.push('先查看下方错误原因；目录授权失败时重新选择数据目录，不需要重复安装应用。');
    if (id === 'wechat') {
      if (platform === 'darwin')
        steps.push(
          '首次读取前正常退出原微信；由读取助手打开副本后登录，并打开一次收藏表情面板。',
          '授权目录用于微信数据；若提示助手缓存权限，单独选择 export-wechat-emoji 缓存目录。',
        );
      else if (platform === 'win32')
        steps.push(
          '确认使用微信 4.x，并已登录电脑版微信、打开收藏表情面板。',
          '微信 → 设置 → 文件管理可查看真实数据位置；选择 xwechat_files 或账号目录，自定义盘符也支持。',
        );
      else steps.push('Linux 暂不支持微信自动读取；先从客户端保存原图，再使用“导入表情”。');
      steps.push('未缓存或不能还原的资源会跳过；不要用静态缩略图替代动图。');
    } else if (id === 'qq') {
      steps.push(
        '使用新版 QQ NT，登录后打开个人收藏表情面板，等待原件下载。',
        '可选择 QQ 数据目录、账号目录、personal_emoji 或 Ori；只读取 Ori 原件，不读取 Thumb 缩略图。',
      );
      steps.push(
        platform === 'win32'
          ? '自定义目录请在 QQ 设置里查找；实际“文档”可能被重定向到 OneDrive 或其他盘。'
          : '未找到默认位置时，用“授权目录”选择实际个人数据目录。',
      );
    } else if (id === 'douyin')
      steps.push(
        '先确认网络可以正常打开抖音官网；白屏时关闭收集窗口后重新打开。',
        '完成网页登录，进入私信里的收藏表情面板，向下滚动加载更多。',
        '仅收集当前加载的收藏响应；下载失败或没有动画原件会明确标记失败，不以静态图代替。',
      );
    return steps;
  };
  if (typeof module === 'object' && module.exports) module.exports = { connectorHelp: help };
  else root.connectorHelp = help;
})(typeof window === 'undefined' ? {} : window);
