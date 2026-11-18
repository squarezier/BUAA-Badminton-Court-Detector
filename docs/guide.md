# 使用、测试与构建

候羽在电脑上查看北航智慧场馆的羽毛球场地余量。你可以监控沙河综合馆，或同时监控学院路体育馆主馆与训练馆（副馆）。

## 打开应用

- macOS 13 或更新版本可用。Apple 芯片 Mac 使用 `macOS-arm64` 包，Intel Mac 使用 `macOS-x64` 包。解压后打开「候羽」。
- Windows 10/11 的 x64 电脑使用 `Windows-x64` 包。完整解压后打开 `Houyu` 文件夹中的 `Houyu.exe`。
- 从旧版升级时，先从菜单栏或托盘退出旧版。候羽会使用同一系统用户下已有的监控设置和安全存储。
- 这些是本地构建的分发包。Mac 包使用临时签名，正式分发需要 Developer ID 签名和公证。Windows 包未做应用发布者签名。macOS 和 Windows 可能提示校验发布者。

## 登录、连接微信、开始监控

1. 点击「登录北航」，在题栏标记为 `sso.buaa.edu.cn` 的统一身份认证窗口输入自己的学号和密码。登录后回到应用。
2. 进入「微信通知」，点击「打开 PushPlus」，使用微信扫码登录，关注「pushplus 推送加」服务号并按平台要求完成实名认证。打开「一对一消息」并点击「一键复制」。
3. 回到候羽，点击「导入并测试」。候羽读取刚复制的令牌，通过 HTTPS 请求 PushPlus 给你发一条测试，并在受理后保存令牌。请在微信服务号里确认收到「候羽｜测试提醒」。[PushPlus 官方接入说明](https://www.pushplus.plus/doc/function/one.html)
4. 回到「场地监控」，选校区，在「检查频率」输入 1–1440 分钟的整数并保存，再点「开始监控」。监控运行中可以调整频率，正在查询的一轮会完整结束。首次查询显示已有余量，随后每轮把新出现的空场合并为一条消息。同一空场连续可约时只提醒一次。
5. 关闭窗口后，应用保留在 macOS 菜单栏或 Windows 托盘。电脑需要保持唤醒且联网。休眠时暂停，唤醒后补查。登录过期后需重新登录并开始监控。

## 查询和通知

- 只统计官网开放日期里尚未开始、带可约标记且显示绿色底色的场地格。日期和时刻按北京时间解释。轮询间隔从上一轮完成时计算。所有场馆都暂时读不到时，应用会延长重试间隔。
- 官网临时打不开，或格子底色与预约状态不一致时，该馆显示核验异常。应用保留上次成功记录用于比较，当前空场和通知只采用成功核验的场馆数据。场馆预约与付款均在北航官网手动完成。
- 通知列出校区、场馆、日期、时段、场号、价格和官网链接。PushPlus 限流时，应用会等待重试时间，届时只发送仍可约的场次。微信实际送达时间取决于 PushPlus 和服务号。送达结果不明时，应用会显示状态，避免自动重发同一批消息。

## 本地数据

- 学号和密码在官方认证页面输入。该窗口使用独立沙箱与内存会话。退出应用会结束该会话。
- 只有点击「导入并测试」时，应用才读取剪贴板。应用通过系统钥匙串或 Windows 安全存储加密微信推送令牌。系统安全存储不可用时，令牌只保留在内存中。设置页可以移除令牌。
- 应用通过 HTTPS 将令牌和场地提醒发送给 PushPlus。推送正文只有场地信息，不包含北航账户信息。应用无遥测服务。

## 运行和构建源码

需要 Node.js 22 或更新版本。在源码根目录运行以下命令。

```sh
npm ci
npm test
npm start
```

`npm test` 包含定时逻辑、回归用例和 10,000 轮模拟查询。安装开发依赖后，可用 Electron 在专用测试目录中运行桌面回归。测试使用模拟登录、时段和推送数据。

```sh
npx electron test/desktop-production.cjs ./qa/production
npx electron test/desktop-smoke.cjs ./qa/preview
```

项目使用 Electron 45.3.4。安装和构建所需的 Electron 来自其官方发布。[Electron 发行说明](https://releases.electronjs.org/release/v45.3.4)

`scripts/package.py` 接受平台、官方运行时目录、临时目录和输出 ZIP 路径。运行时目录应包含对应 Electron ZIP 与官方 `SHASUMS256.txt`。Mac 打包使用 `ditto`、`sips` 和 `codesign`。Windows x64 包使用 Python 3 和已安装的 Node.js 打包依赖。

```sh
python3 scripts/package.py darwin-arm64 ./runtime ./staging ./Houyu-macOS-arm64.zip
python3 scripts/package.py win32-x64 ./runtime ./staging ./Houyu-Windows-x64.zip
```

## 界面素材

界面主色为北航蓝（`#005BAC`）。羽球与球场边线组成的候羽图标由 `scripts/icon.py` 渲染。[北航色彩规范](https://xcb.buaa.edu.cn/info/1091/2057.htm)
