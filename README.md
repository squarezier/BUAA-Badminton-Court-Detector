<p align="center"><img src="src/ui/icon.png" alt="候羽" width="88"></p>
<h1 align="center">BUAA Badminton Court Detector</h1>
<p align="center"><strong>候羽</strong> · 北航羽毛球空场监控与微信提醒</p>

## 下载 v1.3.0

| 平台 | 下载 |
| --- | --- |
| macOS · Apple 芯片（M 系列） | [Houyu-macOS-arm64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.3.0/Houyu-macOS-arm64.zip) |
| macOS · Intel 芯片 | [Houyu-macOS-x64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.3.0/Houyu-macOS-x64.zip) |
| Windows 10/11 · x64 | [Houyu-Windows-x64.zip](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.3.0/Houyu-Windows-x64.zip) |

[源码压缩包](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.3.0/Houyu-Source.zip) · [SHA-256 校验](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v1.3.0/Houyu-SHA256SUMS.txt) · [版本说明](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/tag/v1.3.0)

macOS 需要 13 或更新版本。完整解压后，Mac 打开「候羽」，Windows 打开 `Houyu.exe`。本地构建包的签名情况见[使用指南](docs/guide.md#打开应用)。

## 三步上手

1. 点「登录北航」，在学校统一身份认证页登录。
2. 在「微信通知」打开 PushPlus。扫码登录并复制令牌后，回到候羽点「导入并测试」，在微信确认接收。
3. 选择沙河或学院路，设置 **1–1440 分钟**的检查频率，再点「开始监控」。

候羽只统计官网尚未开始的绿色可约场次。新出现的空场会合并成一条微信提醒，并附预约链接。电脑保持唤醒和联网时，关闭窗口后可在菜单栏或托盘继续监控。

## 界面预览

![北航蓝版候羽监控界面（示例数据）](docs/monitor.png)

[完整使用、测试与构建指南](docs/guide.md)
