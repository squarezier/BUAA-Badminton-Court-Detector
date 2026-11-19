<p align="center"><img src="src/ui/icon.png" width="64" alt="候羽"></p>
<h1 align="center">候羽</h1>
<p align="center">北航羽毛球退订提醒 · BUAA Badminton Court Detector</p>

想打周五晚上的球，可以在候羽里选「学院路」「周五」「18:00–20:00」。候羽在主馆或训练馆看到符合条件的退订，就会把时段和场号发到飞书群。点消息底部的场馆名，去北航官网订场。

## 下载 v2.0.0

| 电脑 | 下载 | 打开 |
| --- | --- | --- |
| <img src="docs/platforms/apple.svg" width="16" alt=""> Mac · macOS 13 及以上 | [Apple 芯片（M 系列）](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v2.0.0/Houyu-macOS-arm64.zip) · [Intel 芯片](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v2.0.0/Houyu-macOS-x64.zip) | 解压，打开「候羽」 |
| <img src="docs/platforms/windows.svg" width="16" alt=""> Windows 10 / 11 | [Windows x64](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v2.0.0/Houyu-Windows-x64.zip) | 解压整个文件夹，打开 `Houyu.exe` |
| <img src="docs/platforms/linux.svg" width="16" alt=""> Ubuntu 22.04 / 24.04 | [Linux amd64](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v2.0.0/Houyu-Linux-amd64.deb) | 安装 DEB，在应用菜单打开「候羽」 |

[版本说明](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/tag/v2.0.0) · [SHA-256 校验文件](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v2.0.0/Houyu-SHA256SUMS.txt) · [源码包](https://github.com/squarezier/BUAA-Badminton-Court-Detector/releases/download/v2.0.0/Houyu-Source.zip)

## 使用手册

1. 点 **登录北航**，在学校统一身份认证页登录。
2. 在接收消息的飞书群里添加 **自定义机器人**。复制 Webhook，粘贴到候羽的 **飞书通知**，点 **连接并测试**。机器人开了签名校验的话，把签名密钥也填上。群里收到「候羽｜测试提醒」就连好了。
3. 选 **学院路** 或 **沙河**，点 **开始监控**。默认看这个校区所有时段和场号。只想等某个时间，就在 **提醒目标** 里选日期、起止时间，再点 **保存目标**。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/monitor-dark.png">
  <img src="docs/monitor.png" width="920" alt="学院路空场表，按日期列出主馆和训练馆的时段、绿色场号与价格">
</picture>

表里绿色的数字就是可约场号。选表格右上角的日期，可以单看那一天。要改飞书提醒的日期，请到「提醒目标」里设置。学院路看主馆和训练馆，沙河看综合馆的数字场和 B 区场。

等场时让电脑保持唤醒、联网。关掉窗口照常监控，退出候羽后停止。

<details>
<summary>飞书机器人和提醒目标填在哪儿？</summary>
<p><img src="docs/feishu.png" width="760" alt="飞书通知页的 Webhook 与签名密钥输入位置"></p>
<p><img src="docs/target.png" width="760" alt="为学院路保存某天 18:00 到 20:00 的提醒目标"></p>
</details>

## 飞书里会收到什么？

下面这张示例里，沙河 18:00 可以选 1、B1、B3 号场，19:00 可以选 B2。每行对应一个时段，价格跟在场号后面。

<img src="docs/feishu-card.png" width="510" alt="飞书群消息示例，含两个时段、四个场次和沙河官网预约入口">

第一次查询只记下场地状态。每天早上 7 点放出新场、未付款占位超时，都会刷新空场表。只有观察到原先已预约的场次重新可约，并且符合场馆退订规则，才会发「疑似退订」提醒。检查间隔默认 2 分钟，最短可设为 1 秒，从上轮查完后起算。[场馆规则与常见问题](docs/guide.md)

写给在北航想打球、又总抢不到场的同学。要是候羽帮你约到了一场，欢迎回来点个 ⭐ Star。
