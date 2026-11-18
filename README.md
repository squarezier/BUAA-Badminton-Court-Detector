<p align="center"><img src="src/ui/icon.png" width="68" alt="候羽的羽毛球图标"></p>
<h1 align="center">候羽</h1>
<p align="center">BUAA Badminton Court Detector · 北航羽毛球退订提醒</p>

## 下载 v1.6.1

| 你的电脑 | 安装包 |
| --- | --- |
| Mac · Apple 芯片（M 系列） | [下载 macOS arm64 版](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.1/Houyu-macOS-arm64.zip) |
| Mac · Intel 芯片 | [下载 macOS Intel 版](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.1/Houyu-macOS-x64.zip) |
| Windows 10 / 11 · x64 | [下载 Windows 版](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.1/Houyu-Windows-x64.zip) |

完整解压后，在 macOS 13 或更新版本打开「候羽」，在 Windows 打开 `Houyu.exe`。[打开应用](docs/guide.md#打开应用) · [源码](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.1/Houyu-Source.zip) · [SHA-256 校验](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.1/Houyu-SHA256SUMS.txt) · [版本说明](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/tag/v1.6.1)

## 使用手册

### 1. 连接飞书

在飞书群里添加「自定义机器人」。打开候羽的「飞书通知」，粘贴 Webhook，点 **连接并测试**。若机器人开启了签名校验，同时填入签名密钥。在群里收到「候羽｜测试提醒」即已连通。

<img src="docs/feishu.png" width="690" alt="飞书通知页，包含 Webhook、可选签名密钥和连接并测试按钮">

### 2. 登录并开始监控

点左下角 **登录北航**，在学校官网完成认证。选择校区，按需修改并保存检查间隔，点 **开始监控**。下图是运行后的示例，绿色数字是可约场号，点场馆名即可打开对应的官网预约页。

<img src="docs/monitor.png" width="940" alt="学院路空场表，同一天的主馆与训练馆分别列出时段、可约场号和价格">

### 3. 只等想打的时段（可选）

在 **提醒目标** 选好日期和起止时间，点 **保存目标**。例如学院路 18:00–20:00，主馆和训练馆在范围内的所有退订场次都会纳入提醒。移除目标后，恢复这个校区所有时段的退订提醒。

<img src="docs/target.png" width="690" alt="学院路 18:00 到 20:00 的目标，覆盖主馆和训练馆全部场号">

**何时推送？** 同一场次上次已预约、本次变为绿色可约时，候羽才向飞书发送疑似退订。首次查询和每天北京时间 07:00 正常放号只刷新列表。电脑保持唤醒、联网，关掉窗口后仍可在菜单栏或托盘找到候羽。[详细指南](docs/guide.md)
