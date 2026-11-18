<p align="center"><img src="src/ui/icon.png" alt="候羽" width="88"></p>
<h1 align="center">BUAA Badminton Court Detector</h1>
<p align="center"><strong>候羽</strong> · 北航羽毛球空场监控与飞书提醒</p>

## 下载 v1.5.1

| 平台 | 下载 |
| --- | --- |
| macOS · Apple 芯片（M 系列） | [Houyu-macOS-arm64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.5.1/Houyu-macOS-arm64.zip) |
| macOS · Intel 芯片 | [Houyu-macOS-x64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.5.1/Houyu-macOS-x64.zip) |
| Windows 10/11 · x64 | [Houyu-Windows-x64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.5.1/Houyu-Windows-x64.zip) |

[源码压缩包](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.5.1/Houyu-Source.zip) · [SHA-256 校验](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.5.1/Houyu-SHA256SUMS.txt) · [版本说明](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/tag/v1.5.1)

macOS 需要 13 或更新版本。完整解压后，Mac 打开「候羽」，Windows 打开 `Houyu.exe`。本地构建包的签名情况见[使用指南](docs/guide.md#打开应用)。

## 三步上手

1. 点「登录北航」，在学校统一身份认证页登录。
2. 在飞书群里添加「自定义机器人」，把 Webhook 填到候羽的「飞书通知」，点「连接并测试」。
3. 选择沙河或学院路，设置 **1–1440 分钟**的检查频率，再点「开始监控」。

候羽在北京时间 07:00 刷新官网预约日期。只有已预约的场次重新变绿时，才发「疑似退订」提醒，列出具体时段、场号和预约链接。电脑保持唤醒和联网时，关闭窗口后可在菜单栏或托盘继续监控。

## 界面预览

![北航蓝版候羽监控界面（示例数据）](docs/monitor.png)

[完整使用、测试与构建指南](docs/guide.md)
