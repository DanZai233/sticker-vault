# wxemoticon 0.3.0

上游：https://github.com/liusheng22/export-wechat-emoji
发布：https://github.com/liusheng22/export-wechat-emoji/releases/tag/v0.3.0
作者 / 权利归属：上游项目贡献者。
上游 CLI Cargo.toml 声明许可证：MIT。

包含上游发布的 Apple Silicon CLI 二进制，未修改：
wxemoticon-aarch64-apple-darwin.tar.gz
SHA-256: d36cbcc546e88f3c112172688efb7845da13cc31761b5a33e2e877628f9cbb4b
已与 GitHub release asset digest 核对。

首次获取数据库密钥时会复制、临时重签名并运行微信副本，将密钥保存在本机；需要先退出原微信，在副本中登录并打开表情面板。表情仓只读取导出的图片，不展示或上传密钥。运行期间 CLI 会访问表情 CDN。上游工具不属于微信官方产品。

应用内的 QQ 适配器及抖音收藏响应解析、下载代码为本项目实现。

Windows x64（ARM64 包通过系统 x64 仿真）使用 wxemoticon-x86_64-windows.zip，SHA-256: ceb10c0b2052716cc493e5446d3cb59d1b3090d2b64014ad6ddc7b3b28a033d0。Windows 读取已登录进程，不使用 macOS 副本流程。
