# 表情仓 · StickerVault

把分散在聊天软件里的表情收进本地素材库，保留动图原件，通过拖拽、复制或菜单栏快捷面板再次使用。

> 当前为 0.3.1 版本。安装包跨平台构建与聊天软件的兼容性是两回事：Mac 的 QQ 个人收藏已实测；微信首次登录和抖音网页收藏仍有平台、账号和网络限制，详见支持表。

## 下载与安装

- 正式版本：仓库右侧 **Releases**，选择与你的系统和 CPU 对应的安装包。
- 开发版本：**Actions → Build desktop installers → 成功的运行 → Artifacts**，登录 GitHub 后下载平台构建产物，解压外层 artifact ZIP 后安装里面的文件。Artifacts 保存 14 天。

| 系统    | CPU                   | 文件                                             |
| ------- | --------------------- | ------------------------------------------------ |
| macOS   | Apple Silicon / Intel | `mac-arm64` / `mac-x64` 的 `.dmg` 或 `.zip`      |
| Windows | Intel/AMD / ARM64     | `win-x64` / `win-arm64` 的 `.exe`，NSIS 安装向导 |
| Linux   | x64 / ARM64           | 对应架构的 `.AppImage` 或 `.deb`                 |

安装包没有开发者证书签名或 macOS 公证，操作系统可能提示无法验证开发者。项目没有自动升级功能。Linux AppImage 可能需要发行版的 FUSE 兼容库，也可以安装 `.deb`。

## 第一次使用

1. 启动应用，点 **导入表情** 选择图片；也可以把文件或文件夹拖进窗口。
2. 在 **收集设置** 中连接 QQ、微信、抖音，或关联本地收集文件夹。
3. 单击表情自动复制原文件；双击或右键打开详情，可修改名称、标签、常用状态及导出。
4. 在主窗口搜索名称、标签或来源；**最近使用** 展示点击复制、插入或尝试拖出的表情，也可按最近使用排序。
5. 拖动表情卡片或详情中的原图到聊天窗口；若接收软件不支持拖拽，使用 **复制原文件** 后粘贴，或导出后选择文件发送。

### 菜单栏 / 系统托盘快捷面板

点击菜单栏的表情图标，或按 `⌘ / Ctrl + Shift + E`，打开搜索与表情缩略图浮层。可切换最近使用、常用、全部，点击使用或直接拖出。

- **macOS**：在收集设置点 **启用 macOS 光标粘贴**，根据系统提示授予辅助功能权限。打开面板前记住当前应用，选择表情后恢复该应用并发送 `⌘V`。不自动按回车发送消息。
- 未授予辅助功能权限：依然复制完整原文件，回到聊天窗口自行按 `⌘V`。
- **Windows / Linux**：目前提供原文件复制及拖出；选择表情后回到聊天软件按 `Ctrl+V`。尚未实现自动恢复光标并粘贴。
- 关闭主窗口后应用继续留在托盘并收集。右键托盘 → **退出表情仓** 才会退出。

目标聊天软件决定粘贴结果是动画、文件附件还是原生表情。粘贴到当前应用不等于能写入任意控件，接收方必须支持图片文件粘贴；自动粘贴不是直接发送。

## 自动导入支持情况

| 来源       | 接入方式                                        | 范围与限制                                                                                                                         |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| QQ         | 自动发现 `personal_emoji/Ori`，每 30 秒增量检查 | Mac 已实测个人收藏原件；跳过 Thumb 缩略图。未缓存的收藏需先在 QQ 收藏面板打开；Windows/Linux 路径适配为实验性                      |
| 微信       | macOS 随附 wxemoticon 0.3.0 助手                | 首次退出原微信，在助手打开的微信副本中登录并打开表情面板；首次成功后每 5 分钟同步。仅 macOS 提供此助手，其他系统可手动导入导出目录 |
| 抖音       | 独立官方网页窗口登录，观察已加载的收藏列表响应  | 打开私信的收藏表情面板并向下滚动，按页自动收集；不是无人值守全量同步。页面登录、接口变动、网络和风控可能影响结果                   |
| 本地文件夹 | 关联目录，每 30 秒检查                          | 跨平台；应用运行期间有效                                                                                                           |

### macOS 目录授权

如果 QQ 或微信显示「需要授权」，点对应的 **授权目录**，在系统文件夹选择框中允许读取默认的数据目录。如果微信提示助手缓存权限，另点 **授权助手缓存**，选择默认的 `export-wechat-emoji` 目录；这是助手密钥 / URL 缓存，和微信原件数据目录是两处独立授权。应用没有权限时会保留已有表情并提示，不把失败显示为完成。

### 微信首次接入

1. 先正常退出微信。
2. 点 **读取微信收藏**，初次复制和准备微信副本可能需要一分钟。
3. 如弹出微信副本，完成登录并打开表情面板，等待下载与导入。
4. 若提示超时或失败，可重试；`connector-cache/wechat/<账号>/import.log` 保存脱敏后的助手错误尾部，便于本机排查。不要把密钥文件提交到仓库或公开问题中。

助手会在本机复制、重签名并运行微信副本，不修改原微信安装；数据库密钥保存在本机。第三方助手来源、版本、校验与许可证信息见 [NOTICE](vendor/wxemoticon/NOTICE.md)。该流程不是微信官方开放接口，客户端更新可能使其失效。

### 抖音导入

点 **打开抖音并收集**，等待页面加载并登录；打开私信收藏表情面板，向下滚动以加载更多。应用只处理 `CUSTOM_STICKER_PAGE` 的收藏响应，不发送聊天消息，不导入桌面客户端 Cookie。登录会话在本机独立保存。

动态表情只下载动画地址；动画下载失败或返回静态图时标记失败，不使用缩略图冒充动画。关闭导入窗口后停止接收新列表。

## 动图与数据

- 支持 GIF、PNG/APNG、JPG、WebP，按文件内容识别，扩展名错误也能处理。
- 保存、复制、拖出、导出不重编码、不压缩，保留原始文件字节；动态预览直接读取原件。
- 暂不把动态 WebP/APNG 转成 GIF；接收软件不支持时可导出原件。
- SHA-256 内容去重。单文件不超过 100 MB，目录递归深度不超过 12。
- QQ、抖音记忆已处理条目，手动移除后不会每次扫描重新出现；微信下载缓存和普通关联目录可能再次导入已移除项目，可先停用来源。
- 「最近使用」指在表情仓中的使用操作，不读取其他聊天软件的发送历史，也不能判断拖拽是否最终成功发送。

素材库位于 Electron `userData` 目录下的 `vault/`。macOS 初始版本通常位于 `~/Library/Application Support/表情仓/vault/`，包含 `library.json`、`originals/` 和 `connector-cache/`。退出应用后复制整个目录可备份；只导出图片不会备份标签与常用状态。

原件和元数据本地保存，无云同步、广告或统计服务。启用平台接入时会访问对应的官方网站或图片 CDN；构建或准备微信助手时会访问 GitHub。

## 开发

### 环境与启动

- Node.js **24 LTS**（最低 22.12）与 npm。
- macOS 的原生剪贴板助手需要 Xcode Command Line Tools：`xcode-select --install`。
- Windows / Linux 可开发素材库、目录收集及抖音部分；微信助手目前仅随 macOS 提供。

```sh
git clone https://github.com/DanZai233/sticker-vault.git
cd sticker-vault
npm ci
# macOS 下载固定版本并校验 SHA-256；其他系统自动跳过
npm run prepare:helper
# macOS 编译原文件复制 / 辅助功能粘贴助手；其他系统跳过
npm run build:native
npm start
```

开发时 `vendor/` 中下载或编译的二进制不会提交 Git。Electron 下载及助手下载需要网络。

### 常用命令

```sh
npm run check                # 语法检查与 Node 测试
npm test                     # 数据保真、去重、QQ 原件定位、抖音解析与域名校验
npm run prepare:helper -- darwin arm64
npm run build:native -- arm64
npm run dist -- --mac --arm64 --publish never
npm run dist -- --mac --x64 --publish never
npm run dist -- --win --x64 --publish never
npm run dist -- --win --arm64 --publish never
npm run dist -- --linux --x64 --publish never
npm run dist -- --linux --arm64 --publish never
```

请在目标系统构建相应安装包；如需交叉构建，请使用下述 GitHub Actions 矩阵。编译 macOS 助手时架构必须与安装包一致。产物在 `dist/`，执行 `node scripts/checksums.cjs` 生成 SHA-256 清单。

### 代码结构

```text
src/main.cjs            Electron 窗口、托盘、快捷键、IPC、原生文件拖拽
src/library.cjs         原件存储、格式识别、内容去重、元数据队列
src/connectors.cjs      QQ / 微信接入、抖音响应解析与下载校验
src/douyin.cjs          官方网页窗口与导入状态
src/douyin-preload.cjs  仅观察收藏列表的 fetch/XHR 响应
src/native.cjs          原文件复制与 macOS 光标粘贴适配
src/panel.*             菜单栏快捷面板
src/renderer.js         主素材库、最近使用、标签和接入设置
scripts/               助手校验下载、原生助手编译、打包与校验和
vendor/                第三方说明及本机准备的助手
```

新增平台时，把账号发现、增量指纹、状态与错误恢复放在独立适配器中。保持原件只读，不混入聊天图片或静态预览；先对固定测试数据验证，再用自己授权的真实账号验证。

## GitHub Actions 与发布

`.github/workflows/build.yml` 在推送 `main`、PR、手动运行和推送 `v*` 标签时构建：macOS arm64/x64、Windows x64/arm64、Linux x64/arm64，共 6 组。

流程使用 `npm ci` → 测试 → 校验下载相应架构助手 → 编译原生助手 → electron-builder 打包 → SHA-256 → 上传 Artifacts。普通构建只需仓库读取权限，标签发布任务才获得 `contents: write`；不需要配置个人访问令牌或签名证书。

发布新版本：先修改 `package.json` 与锁文件中的版本，并更新 [CHANGELOG](CHANGELOG.md)，提交后推送标签：

```sh
npm version 0.3.1 --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release 0.3.1"
git tag v0.3.1
git push origin main v0.3.1
```

全部 6 组成功后，标签任务自动创建 GitHub Release 并附上安装包及校验和；失败时不会发布部分安装包。手动重跑同一标签会更新同名附件。

构建成功不代表微信 / 抖音真实账号、系统权限和各聊天软件拖拽已通过验收。测试覆盖和已知限制见 [开发与测试说明](docs/DEVELOPMENT.md)。

## 许可证

本项目代码采用 [MIT](LICENSE)。第三方微信助手由其上游许可证约束，不属于微信官方软件。用户导入的表情素材版权归各自权利人所有。
