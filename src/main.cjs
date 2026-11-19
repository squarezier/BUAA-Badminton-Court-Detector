'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, powerMonitor, protocol, safeStorage, session, shell } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { productName, version } = require('../package.json');
const {
  CAMPUS_ORIGIN, LOGIN_URL, CAMPUSES, VENUES, venueUrl, intervalSeconds, validOptions, validTarget, targetFields,
  calendarDates, beijingClock, validatedSnapshot,
} = require('./courts.cjs');
const { signedInOnBookingSite, readBookingPage } = require('./site-page.cjs');
const { CourtMonitor, UserError, CampusRateLimit } = require('./monitor.cjs');
const { Preferences } = require('./preferences.cjs');
const { httpsUrl, campusPage, allowedCampusRequest, assetRequestHeaders, assetResponseHeaders } = require('./campus-policy.cjs');
const { feishuConnection } = require('./push-connection.cjs');
const { sendPush, testNotice } = require('./push.cjs');

const UI = 'courtwatch://app/index.html';
const ICON = path.join(__dirname, 'ui', 'icon.png');
const PROFILE_IDENTITY = '北航羽毛球余场提醒';
const PUSH_GUIDE = 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN';
const WORLD = 1201;
const appFiles = new Map([
  ['/index.html', 'text/html; charset=utf-8'], ['/styles.css', 'text/css; charset=utf-8'],
  ['/renderer.js', 'text/javascript; charset=utf-8'], ['/icon.png', 'image/png'],
].map(([file, type]) => [new URL(file, UI).href, type]));
const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false, webviewTag: false };
let mainWindow, campusWindow, tray, campusSession, uiSession, monitor, prefs;
let exiting = false;
let sending = false;
let editing = false;
let changingConnection = false;
let campusSessionNumber = 0;
const nextPushTestAt = new Map();
const scanLimits = new Map();

// Electron includes the complete navigation URL in its default load warning.
// SSO return URLs may carry short-lived tickets. Retain the network error only.
process.prependListener('warning', warning => {
  if (warning.name !== 'electron' || !warning.message.startsWith('Failed to load URL: ')) return;
  const code = / with error: (ERR_[A-Z0-9_]+)$/.exec(warning.message)?.[1];
  warning.message = code ? `Page navigation failed (${code})` : 'Page navigation failed';
  warning.stack = `${warning.name}: ${warning.message}`;
});

// Check before creating any window, session, or opening the system vault.
if (app.isPackaged) {
  const unsafeSwitches = ['remote-debugging-port', 'remote-debugging-pipe', 'no-sandbox', 'disable-web-security',
    'ignore-certificate-errors', 'ignore-certificate-errors-spki-list', 'ssl-key-log-file', 'log-net-log'];
  if (unsafeSwitches.some(name => app.commandLine.hasSwitch(name)) || process.env.SSLKEYLOGFILE ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') app.exit(1);
}

// Electron uses its internal app name for the macOS Keychain service.
// Keep that identity and the profile path for settings saved by older releases.
app.setName(PROFILE_IDENTITY);
if (process.platform === 'linux') app.setDesktopName('houyu.desktop');
const devProfile = !app.isPackaged && process.env.COURTWATCH_DEV_PROFILE;
const profile = devProfile ? path.resolve(devProfile) : path.join(app.getPath('appData'), PROFILE_IDENTITY);
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'courtwatch', privileges: { standard: true, secure: true } }]);

function onCampusLogin(value) {
  const url = httpsUrl(value);
  return Boolean(url && (url.hostname === 'sso.buaa.edu.cn' || (url.origin === CAMPUS_ORIGIN && /^\/venue\/login\/?$/.test(url.pathname))));
}

function noPermissions(target) {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.on('will-download', event => event.preventDefault());
  target.setDevicePermissionHandler(() => false);
}

async function appResponse(request) {
  const mime = appFiles.get(request.url);
  if (request.method !== 'GET' || !mime) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  const data = await fs.readFile(path.join(__dirname, 'ui', url.pathname.slice(1)));
  return new Response(data, { headers: {
    'content-type': mime,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  } });
}

function secureCampusWindow(win, allowSameWindowPopup) {
  const contents = win.webContents;
  for (const name of ['will-frame-navigate', 'will-redirect']) {
    contents.on(name, (event, url) => {
      if (!campusPage(event.url ?? url)) event.preventDefault();
    });
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (allowSameWindowPopup && campusPage(url)) queueMicrotask(() => {
      if (!win.isDestroyed()) void win.loadURL(url).catch(() => {});
    });
    return { action: 'deny' };
  });
  contents.on('page-title-updated', event => event.preventDefault());
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isCrashed() && !mainWindow.webContents.isLoadingMainFrame()) {
    void mainWindow.loadURL(UI).catch(() => {});
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (monitor) publish(monitor.state());
}

function sendToInterface(channel, ...values) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed() && mainWindow.webContents.getURL() === UI) {
    mainWindow.webContents.send(channel, ...values);
  }
}

function publish(state) {
  sendToInterface('courtwatch:state', viewState(state));
  if (!tray || tray.isDestroyed()) return;
  const label = state.running ? (state.checking ? '正在查场地' : '监控中') : '监控已暂停';
  tray.setToolTip(`${productName} · ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开窗口', click: showMain },
    { label, enabled: false },
    { label: '暂停监控', enabled: state.running, click: () => monitor.stop() },
    { type: 'separator' },
    { label: '退出应用', click: () => app.quit() },
  ]));
}

function viewState(state) {
  return { ...state, pushService: prefs.provider };
}

async function execute(win, action, argument) {
  const code = `(${action.toString()})(${argument === undefined ? '' : JSON.stringify(argument)})`;
  return win.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
}

async function readVenue(id, signal) {
  signal.throwIfAborted();
  const started = Date.now();
  const target = venueUrl(id);
  const win = new BrowserWindow({
    show: false, skipTaskbar: true, width: 1270, height: 920,
    webPreferences: { ...webPreferences, session: campusSession, backgroundThrottling: false },
  });
  secureCampusWindow(win, false);
  const contentsId = win.webContents.id;
  let interrupt;
  const interrupted = new Promise((_resolve, reject) => { interrupt = reject; });
  const cancel = () => interrupt(signal.reason);
  scanLimits.set(contentsId, retryAfter => interrupt(new CampusRateLimit(retryAfter)));
  const timeout = setTimeout(() => interrupt(new Error('Timetable timed out')), 32000);
  signal.addEventListener('abort', cancel, { once: true });
  const verifyDestination = () => {
    const url = win.webContents.getURL();
    if (onCampusLogin(url)) throw new UserError('北航会话已失效，请重新登录。', 'auth');
    if (url !== target) throw new UserError('官网跳转异常，请在预约页查看。');
  };
  async function inspect() {
    await win.loadURL(target);
    signal.throwIfAborted();
    verifyDestination();
    const result = await execute(win, readBookingPage, {
      bookableLabels: [...calendarDates(started).keys()], nowClock: beijingClock(started),
      venueName: CAMPUSES[VENUES[id].campus].label + VENUES[id].label.replace('（副馆）', ''),
    });
    signal.throwIfAborted();
    verifyDestination();
    if (result?.error === 'colors') throw new UserError('官网格子的颜色和预约状态不一致，本轮无法确认该馆余量。');
    if (result?.error === 'layout' || !result?.days) {
      throw new UserError('官网时段表暂不可读，请稍后重试。');
    }
    return validatedSnapshot(id, result.days, started, result.unread);
  }
  try {
    return await Promise.race([interrupted, inspect()]);
  } catch (error) {
    if (error instanceof UserError || signal.aborted) throw error;
    if (!win.isDestroyed() && onCampusLogin(win.webContents.getURL())) throw new UserError('北航会话已失效，请重新登录。', 'auth');
    throw new UserError('暂时无法连接官网或读取时段表。');
  } finally {
    clearTimeout(timeout);
    scanLimits.delete(contentsId);
    signal.removeEventListener('abort', cancel);
    if (!win.isDestroyed()) win.destroy();
  }
}

async function loadCampusPage(win, url) {
  const contents = win.webContents;
  let timer;
  let httpStatus;
  const recordStatus = (_event, _location, status) => { httpStatus = status; };
  contents.on('did-navigate', recordStatus);
  try {
    await Promise.race([win.loadURL(url), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Campus page load timed out')), 25000);
    })]);
    if (httpStatus >= 400) throw new Error('Campus page returned an HTTP error');
  } catch (error) {
    if (win.isDestroyed() || (error.code === 'ERR_ABORTED' &&
      (contents.isLoadingMainFrame() || campusPage(contents.getURL())))) return;
    contents.stop();
    win.setTitle('北航官网暂时无法打开 · 请检查网络');
    throw new UserError('北航官网暂时无法打开，请检查网络后重试。');
  } finally {
    clearTimeout(timer);
    if (!contents.isDestroyed()) contents.off('did-navigate', recordStatus);
  }
}

async function openCampus(url, login) {
  if (campusWindow && !campusWindow.isDestroyed()) {
    if (login && monitor.auth !== 'opening') {
      campusWindow.destroy();
    } else {
      campusWindow.show();
      campusWindow.focus();
      if (!login && monitor.auth !== 'opening' && campusWindow.webContents.getURL() !== url) return loadCampusPage(campusWindow, url);
      return;
    }
  }
  const previous = monitor.auth;
  if (login) monitor.setAuth('opening');
  const awaitingAuth = login ? 'opening' : 'signed-out';
  const win = new BrowserWindow({
    width: 1060, height: 800, minWidth: 700, minHeight: 560, title: '北航官方网站',
    icon: ICON, autoHideMenuBar: true, webPreferences: { ...webPreferences, session: campusSession },
  });
  campusWindow = win;
  secureCampusWindow(win, true);
  let checking = false;
  const updateTitle = () => {
    if (win.isDestroyed()) return;
    const host = httpsUrl(win.webContents.getURL())?.hostname;
    if (host) win.setTitle(`${host === 'sso.buaa.edu.cn' ? '北航统一身份认证' : '北航官方场馆预约'} · ${host}`);
  };
  const checkSignIn = async () => {
    if (checking || win.isDestroyed() || monitor.auth !== awaitingAuth) return;
    const location = win.webContents.getURL();
    const url = httpsUrl(location);
    if (!url || url.origin !== CAMPUS_ORIGIN || !/^\/venue\/(home|venue-reservation\/\d+)\/?$/.test(url.pathname)) return;
    checking = true;
    try {
      if (await execute(win, signedInOnBookingSite) && !win.isDestroyed() &&
          monitor.auth === awaitingAuth && win.webContents.getURL() === location) {
        monitor.setAuth('signed-in');
        if (login) { win.close(); showMain(); }
      }
    } catch { /* Navigation may still be in progress. */ }
    finally { checking = false; }
  };
  const checker = setInterval(() => void checkSignIn(), 850);
  win.webContents.on('did-navigate', updateTitle);
  win.webContents.on('did-navigate-in-page', updateTitle);
  win.on('closed', () => {
    clearInterval(checker);
    if (campusWindow === win) campusWindow = null;
    if (monitor.auth === 'opening') monitor.setAuth(previous === 'expired' ? 'expired' : 'signed-out');
  });
  try { await loadCampusPage(win, url); }
  catch (error) {
    if (login && !win.isDestroyed() && monitor.auth === 'opening') {
      win.destroy();
      showMain();
    }
    throw error;
  }
}

async function dispatch(message, signal) {
  if (!prefs.provider) return { kind: 'blocked', text: '请先连接飞书群机器人。' };
  if (sending || changingConnection) return { kind: 'retry', text: '另一条通知正在处理，下一轮会再检查。' };
  sending = true;
  try {
    const connection = await prefs.readConnection();
    if (signal?.aborted) return { kind: 'cancelled' };
    return await sendPush(connection, message, signal);
  } catch {
    return { kind: 'retry', retryAfterMs: 60000, text: '系统安全存储暂时无法解锁，下次核验到场地后重试。' };
  }
  finally { sending = false; }
}

async function storePushConnection(connection, sessionOnly = false) {
  const persistent = await prefs.saveConnection(connection, sessionOnly);
  monitor.setDelivery(Boolean(connection), persistent);
}

async function testPushConnection(candidate, sessionOnly = false) {
  if (sending || changingConnection) throw new UserError('通知正在处理，请稍候。');
  changingConnection = true;
  try {
    let saved;
    if (prefs.provider) {
      try { saved = await prefs.readConnection(); }
      catch { if (!candidate) throw new UserError('系统安全存储暂时无法解锁。'); }
    }
    const connection = candidate ?? saved;
    if (!connection) throw new UserError('请先连接飞书群机器人。');
    const now = Date.now();
    const { provider } = connection;
    const sameDestination = !candidate || (saved?.provider === 'feishu' && candidate.webhook === saved.webhook);
    if (now < Math.max(nextPushTestAt.get(provider) ?? 0, sameDestination ? monitor.pushNotBefore : 0)) {
      throw new UserError('通知服务暂缓接收测试，请稍后再试。');
    }
    nextPushTestAt.set(provider, now + 15000);
    const result = await sendPush(connection, testNotice(now));
    if (result.kind === 'retry') {
      nextPushTestAt.set(provider, Math.max(now + 15000, Date.now() + result.retryAfterMs));
    }
    if (candidate) {
      if (result.kind === 'retry') throw new UserError('这次测试暂未发送成功，请稍后再试。');
      if (result.kind !== 'accepted') throw new UserError(result.text);
      if (!sameDestination || candidate.secret !== saved?.secret || sessionOnly || !prefs.encrypted) {
        try { await storePushConnection(connection, sessionOnly); }
        catch { throw new UserError('飞书已受理测试。配置保存失败，请检查系统安全存储后重试。'); }
      }
    }
    monitor.recordDelivery(result);
    if (result.kind !== 'accepted') throw new UserError(result.text);
  } finally { changingConnection = false; }
}

function handle(action, run) {
  ipcMain.handle(`courtwatch:${action}`, async (event, value) => {
    const frame = event.senderFrame;
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
        !frame || frame !== event.sender.mainFrame || frame.url !== UI || event.sender.getURL() !== UI) {
      return { ok: false, error: '请求来源无效。' };
    }
    try { return { ok: true, value: await run(value) }; }
    catch (error) { return { ok: false, error: error instanceof UserError ? error.message : '操作未完成，请重试。' }; }
  });
}

async function saveMonitorOptions(options) {
  if (editing) throw new UserError('上一个设置正在保存，请稍候。');
  editing = true;
  try { await prefs.saveOptions(options); monitor.setOptions(options); }
  finally { editing = false; }
}

function setupIpc() {
  handle('state', () => viewState(monitor.state()));
  handle('login', () => openCampus(LOGIN_URL, true));
  handle('open-venue', id => {
    if (typeof id !== 'string' || !Object.hasOwn(VENUES, id)) throw new UserError('场馆无效。');
    return openCampus(venueUrl(id), false);
  });
  handle('log-out', async () => {
    if (campusWindow && !campusWindow.isDestroyed()) campusWindow.destroy();
    monitor.setAuth('signed-out');
    const previous = campusSession;
    previous.webRequest.onBeforeRequest((_request, reply) => reply({ cancel: true }));
    campusSession = newCampusSession();
    const closed = await Promise.allSettled([previous.closeAllConnections()]);
    const cleared = await Promise.allSettled([previous.clearAuthCache(), previous.clearStorageData(), previous.clearCache()]);
    if ([...closed, ...cleared].some(op => op.status === 'rejected')) {
      throw new UserError('已切换到新的登录会话。部分旧缓存清理失败，退出候羽可结束原内存会话。');
    }
  });
  handle('start', () => {
    if (editing) throw new UserError('正在保存监控设置，请稍候。');
    monitor.start();
  });
  handle('pause', () => monitor.stop());
  handle('options', async options => {
    if (!validOptions(options)) throw new UserError('请选择有效的校区和检查频率。');
    if (monitor.running && options.campus !== monitor.options.campus) throw new UserError('请先暂停监控再切换校区。');
    await saveMonitorOptions({ ...monitor.options, campus: options.campus, interval: intervalSeconds(options.interval) / 60 });
  });
  handle('target', async value => {
    const { campus, target } = value ?? {};
    if (campus !== monitor.options.campus) throw new UserError('校区已变更，请重新选择目标。');
    const targets = { ...monitor.options.targets };
    if (target === null) {
      delete targets[campus];
    } else {
      if (!validTarget(target)) throw new UserError('请检查目标日期和起止时间。');
      if (Date.parse(`${target.date}T${target.end}:00+08:00`) <= Date.now()) throw new UserError('请选择尚未结束的北京时间段。');
      targets[campus] = targetFields(target);
    }
    await saveMonitorOptions({ ...monitor.options, targets });
  });
  handle('push-connect', value => {
    const connection = feishuConnection(value);
    if (!connection) throw new UserError('请填写飞书自定义机器人的 Webhook，并检查签名密钥格式。');
    return testPushConnection(connection, value.sessionOnly === true);
  });
  handle('push-test', () => testPushConnection());
  handle('push-unlock', async () => {
    if (!prefs.encrypted || prefs.provider) return;
    if (sending || changingConnection) throw new UserError('通知正在处理，请稍候。');
    changingConnection = true;
    try {
      await prefs.readConnection();
      monitor.setDelivery(true, true);
    } catch { throw new UserError('系统安全存储暂时无法解锁。'); }
    finally { changingConnection = false; }
  });
  handle('push-disconnect', async () => {
    if (sending || changingConnection) throw new UserError('通知正在处理，请稍候。');
    changingConnection = true;
    try { await storePushConnection(null); }
    finally { changingConnection = false; }
  });
  handle('push-guide', () => shell.openExternal(PUSH_GUIDE));
}

function newCampusSession() {
  const partition = campusSessionNumber === 0 ? 'buaa-session' : `buaa-session-${campusSessionNumber}`;
  campusSessionNumber++;
  const target = session.fromPartition(partition, { cache: false });
  noPermissions(target);
  target.webRequest.onResponseStarted({ urls: [CAMPUS_ORIGIN + '/*'] }, details => {
    if (details.statusCode !== 429 || !['mainFrame', 'xhr'].includes(details.resourceType)) return;
    const limited = scanLimits.get(details.webContentsId);
    if (!limited) return;
    const header = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === 'retry-after');
    limited(header?.[1]?.[0]);
  });
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowedCampusRequest(details) });
  });
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    callback(campusPage(details.url) ? {} : { requestHeaders: assetRequestHeaders(details.requestHeaders) });
  });
  target.webRequest.onHeadersReceived((details, callback) => {
    callback(campusPage(details.url) ? {} : { responseHeaders: assetResponseHeaders(details.responseHeaders ?? {}) });
  });
  return target;
}

async function initialize() {
  campusSession = newCampusSession();
  uiSession = session.fromPartition('courtwatch-ui', { cache: false });
  noPermissions(uiSession);
  uiSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.method !== 'GET' || !appFiles.has(details.url) });
  });
  await uiSession.protocol.handle('courtwatch', appResponse);
  prefs = new Preferences(path.join(app.getPath('userData'), 'settings.json'), safeStorage);
  await prefs.load();
  monitor = new CourtMonitor({ options: prefs.options, checkVenue: readVenue, dispatch, onChange: publish });
  monitor.setDelivery(Boolean(prefs.provider), Boolean(prefs.encrypted), prefs.warning);
  setupIpc();

  const windowColors = () => nativeTheme.shouldUseDarkColors
    ? { color: '#262b2d', symbolColor: '#e5e5dc' }
    : { color: '#f9f7f2', symbolColor: '#445461' };
  const nativeTitleBar = process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 17, y: 13 } }
    : process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: { ...windowColors(), height: 36 } }
      : {};
  mainWindow = new BrowserWindow({
    ...nativeTitleBar,
    width: 1060, height: 720, minWidth: 760, minHeight: 630, title: productName, icon: ICON,
    show: false, backgroundColor: windowColors().color, autoHideMenuBar: true,
    webPreferences: { ...webPreferences, session: uiSession, preload: path.join(__dirname, 'preload.cjs') },
  });
  nativeTheme.on('updated', () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.setBackgroundColor(windowColors().color);
    if (process.platform === 'win32') mainWindow.setTitleBarOverlay({ ...windowColors(), height: 36 });
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', event => event.preventDefault());
  mainWindow.webContents.on('page-title-updated', event => event.preventDefault());
  const clearDraft = () => sendToInterface('courtwatch:clear-draft');
  mainWindow.on('hide', clearDraft);
  mainWindow.on('minimize', clearDraft);
  powerMonitor.on('lock-screen', clearDraft);
  mainWindow.on('close', event => {
    if (exiting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  const trayPath = process.platform === 'darwin' ? path.join(__dirname, 'ui', 'trayTemplate.png') : ICON;
  const trayImage = nativeImage.createFromPath(trayPath).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  try {
    tray = new Tray(trayImage);
    tray.on('click', showMain);
  } catch (error) {
    if (process.platform !== 'linux') throw error;
  }
  if (process.platform === 'darwin') app.setAboutPanelOptions({ applicationName: productName, applicationVersion: version });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: productName, submenu: [
      { label: `关于${productName}`, role: 'about' }, { type: 'separator' },
      { label: `隐藏${productName}`, role: 'hide' }, { label: `退出${productName}`, role: 'quit' },
    ] }] : []),
    ...(process.platform === 'linux' ? [{ label: productName, submenu: [
      { label: '显示窗口', click: showMain }, { label: '退出候羽', role: 'quit', accelerator: 'Ctrl+Q' },
    ] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  powerMonitor.on('suspend', () => { clearDraft(); monitor.setSuspended(true); });
  powerMonitor.on('resume', () => monitor.setSuspended(false));
  publish(monitor.state());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(UI);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.on('activate', showMain);
  app.on('before-quit', () => { exiting = true; monitor?.stop(false); });
  app.on('window-all-closed', () => { if (!tray || exiting) app.quit(); });
  app.whenReady().then(initialize).catch(() => {
    process.stderr.write('Houyu could not initialize the desktop window.\n');
    app.exit(1);
  });
}
