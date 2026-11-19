macOS 原生助手由 scripts/macos-insert.swift 编译，运行 npm run build:native 生成 sticker-insert。二进制不提交 Git；CI 按目标架构生成并复制到资源目录外层。Windows 的文件剪贴板使用系统 PowerShell，Linux 使用文件 URI 剪贴板。
