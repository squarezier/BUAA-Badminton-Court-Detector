<p align="center"><img src="src/ui/icon.png" alt="候羽" width="88"></p>
<h1 align="center">BUAA Badminton Court Detector</h1>
<p align="center"><strong>候羽</strong> · 北航羽毛球空场监控与飞书提醒</p>

## 下载 v1.6.0

| 平台 | 下载 |
| --- | --- |
| macOS · Apple 芯片（M 系列） | [Houyu-macOS-arm64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.0/Houyu-macOS-arm64.zip) |
| macOS · Intel 芯片 | [Houyu-macOS-x64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.0/Houyu-macOS-x64.zip) |
| Windows 10/11 · x64 | [Houyu-Windows-x64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.0/Houyu-Windows-x64.zip) |

[源码压缩包](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.0/Houyu-Source.zip) · [SHA-256 校验](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.6.0/Houyu-SHA256SUMS.txt) · [版本说明](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/tag/v1.6.0)

macOS 需要 13 或更新版本。完整解压后，Mac 打开「候羽」，Windows 打开 `Houyu.exe`。本地构建包的签名情况见[使用指南](docs/guide.md#打开应用)。

## 三步上手

1. 点「登录北航」，在学校统一身份认证页登录。
2. 在飞书群里添加「自定义机器人」，把 Webhook 填到候羽的「飞书通知」，点「连接并测试」。
3. 选择校区和检查频率，点「开始监控」。只想等某天的场时，打开「提醒目标」，选择日期、开始和结束时间。

例如设为「学院路 · 周五 18:00–20:00」，主馆和训练馆在这个时段内从已预约变为绿色可约的场次都会推送，卡片列全时段、场馆和场号。两个校区各自保存一个目标。首次查询和每天 07:00 正常放号都只更新空场表。

## 界面预览

![候羽场地监控界面（示例数据）](docs/monitor.png)

[查看目标设置界面](docs/target.png) · [完整使用、测试与构建指南](docs/guide.md)
