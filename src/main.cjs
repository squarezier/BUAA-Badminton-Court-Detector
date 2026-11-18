'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, powerMonitor, protocol, safeStorage, session, shell } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { productName, version } = require('../package.json');
const {
  CAMPUS_ORIGIN, LOGIN_URL, VENUES, venueUrl, validOptions,
  calendarDates, beijingClock, validatedSnapshot,
} = require('./courts.cjs');
const { signedInOnBookingSite, readBookingPage } = require('./site-page.cjs');
const { CourtMonitor, UserError } = require('./monitor.cjs');
const { Preferences } = require('./preferences.cjs');
const { feishuConnection } = require('./push-connection.cjs');
const { sendPush, testNotice } = require('./push.cjs');

const UI = 'courtwatch://app/index.html';
const ICON = path.join(__dirname, 'ui', 'icon.png');
const PROFILE_IDENTITY = '北航羽毛球余场提醒';
const PUSH_GUIDE = 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN';
const CAMPUS_HOSTS = new Set(['cgyy.buaa.edu.cn', 'sso.buaa.edu.cn']);
const WORLD = 1201;
const appFiles = new Map([
  ['/index.html', 'text/html; charset=utf-8'], ['/styles.css', 'text/css; charset=utf-8'],
  ['/renderer.js', 'text/javascript; charset=utf-8'], ['/icon.png', 'image/png'],
]);
const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false };
let mainWindow, campusWindow, tray, campusSession, uiSession, monitor, prefs;
let exiting = false;
let sending = false;
let editing = false;
let changingConnection = false;
const nextPushTestAt = new Map();

// Electron uses its internal app name for the macOS Keychain service.
// Keep that identity and the profile path for settings saved by older releases.
app.setName(PROFILE_IDENTITY);
const devProfile = !app.isPackaged && process.env.COURTWATCH_DEV_PROFILE;
const profile = devProfile ? path.resolve(devProfile) : path.join(app.getPath('appData'), PROFILE_IDENTITY);
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'courtwatch', privileges: { standard: true, secure: true } }]);

function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password) return url;
  } catch { /* URL was not usable */ }
  return null;
}

function campusPage(value) {
  const url = httpsUrl(value);
  return Boolean(url && CAMPUS_HOSTS.has(url.hostname));
}

function campusResource(value) {
  const url = httpsUrl(value);
  return Boolean(url && (url.hostname === 'buaa.edu.cn' || url.hostname.endsWith('.buaa.edu.cn')));
}

function onCampusLogin(value) {
  const url = httpsUrl(value);
  return Boolean(url && (url.hostname === 'sso.buaa.edu.cn' || (url.origin === CAMPUS_ORIGIN && /^\/venue\/login\/?$/.test(url.pathname))));
}

function noPermissions(target) {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.on('will-download', event => event.preventDefault());
}

async function appResponse(request) {
  const url = new URL(request.url);
  const mime = appFiles.get(url.pathname);
  if (request.method !== 'GET' || url.hostname !== 'app' || url.search || !mime) return new Response('Not found', { status: 404 });
  const data = await fs.readFile(path.join(__dirname, 'ui', url.pathname.slice(1)));
  return new Response(data, { headers: {
    'content-type': mime,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  } });
}

function secureCampusWindow(win, allowSameWindowPopup) {
  const contents = win.webContents;
  for (const name of ['will-navigate', 'will-redirect']) {
    contents.on(name, (event, url, _inPlace, isMainFrame = true) => {
      if (!(isMainFrame ? campusPage : campusResource)(event.url ?? url)) event.preventDefault();
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

function publish(state) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed()) {
    mainWindow.webContents.send('courtwatch:state', viewState(state));
  }
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
  return { ...state, pushService: prefs.connection?.provider ?? null };
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
  const close = () => { if (!win.isDestroyed()) win.destroy(); };
  const timeout = setTimeout(close, 32000);
  signal.addEventListener('abort', close, { once: true });
  const verifyDestination = () => {
    const url = win.webContents.getURL();
    if (onCampusLogin(url)) throw new UserError('北航会话已失效，请重新登录。', 'auth');
    if (url !== target) throw new UserError('官网跳转异常，请在预约页查看。');
  };
  try {
    await win.loadURL(target);
    signal.throwIfAborted();
    verifyDestination();
    const result = await execute(win, readBookingPage, {
      bookableLabels: [...calendarDates(started).keys()], nowClock: beijingClock(started),
    });
    signal.throwIfAborted();
    verifyDestination();
    if (result?.error === 'colors') throw new UserError('官网格子的颜色和预约状态不一致，本轮无法确认该馆余量。');
    if (result?.error === 'layout' || !result?.days) {
      throw new UserError('官网时段表暂不可读，请稍后重试。');
    }
    return validatedSnapshot(id, result.days, started);
  } catch (error) {
    if (error instanceof UserError || signal.aborted) throw error;
    if (!win.isDestroyed() && onCampusLogin(win.webContents.getURL())) throw new UserError('北航会话已失效，请重新登录。', 'auth');
    throw new UserError('暂时无法连接官网或读取时段表。');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', close);
    close();
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
  if (!prefs.connection) return { kind: 'blocked', text: '请先连接飞书群机器人。' };
  if (sending || changingConnection) return { kind: 'retry', text: '另一条通知正在处理，下一轮会再检查。' };
  sending = true;
  try { return await sendPush(prefs.connection, message, signal); }
  finally { sending = false; }
}

async function storePushConnection(connection) {
  const persistent = await prefs.saveConnection(connection);
  monitor.setDelivery(Boolean(connection), persistent);
}

async function testPushConnection(candidate) {
  const saved = prefs.connection;
  const connection = candidate ?? saved;
  if (!connection) throw new UserError('请先连接飞书群机器人。');
  if (sending || changingConnection) throw new UserError('通知正在处理，请稍候。');
  const now = Date.now();
  const { provider } = connection;
  const sameDestination = !candidate || (saved?.provider === 'feishu' && candidate.webhook === saved.webhook);
  const nextTest = nextPushTestAt.get(provider) ?? 0;
  if (now < Math.max(nextTest, sameDestination ? monitor.pushNotBefore : 0)) {
    throw new UserError('通知服务暂缓接收测试，请稍后再试。');
  }
  changingConnection = true;
  try {
    nextPushTestAt.set(provider, now + 15000);
    const result = await sendPush(connection, testNotice(now));
    if (result.kind === 'retry') {
      nextPushTestAt.set(provider, Math.max(now + 15000, Date.now() + result.retryAfterMs));
    }
    if (candidate) {
      if (result.kind === 'retry') throw new UserError('这次测试暂未发送成功，请稍后再试。');
      if (result.kind !== 'accepted') throw new UserError(result.text);
      if (!sameDestination || candidate.secret !== saved?.secret || !prefs.encrypted) {
        try { await storePushConnection(connection); }
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
    if (!mainWindow || event.sender !== mainWindow.webContents || !frame || frame.parent || frame.url !== UI) {
      return { ok: false, error: '请求来源无效。' };
    }
    try { return { ok: true, value: await run(value) }; }
    catch (error) { return { ok: false, error: error instanceof UserError ? error.message : '操作未完成，请重试。' }; }
  });
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
    await campusSession.clearStorageData();
    await campusSession.clearCache();
  });
  handle('start', () => {
    if (editing) throw new UserError('正在保存监控设置，请稍候。');
    monitor.start();
  });
  handle('pause', () => monitor.stop());
  handle('options', async options => {
    if (!validOptions(options)) throw new UserError('请选择有效的校区和检查频率。');
    if (editing) throw new UserError('上一个设置正在保存，请稍候。');
    if (monitor.running && options.campus !== monitor.options.campus) throw new UserError('请先暂停监控再切换校区。');
    const clean = { campus: options.campus, interval: options.interval };
    editing = true;
    try { await prefs.saveOptions(clean); monitor.setOptions(clean); }
    finally { editing = false; }
  });
  handle('push-connect', value => {
    const connection = feishuConnection(value);
    if (!connection) throw new UserError('请填写飞书自定义机器人的 Webhook，并检查签名密钥格式。');
    return testPushConnection(connection);
  });
  handle('push-test', () => testPushConnection());
  handle('push-disconnect', async () => {
    if (sending || changingConnection) throw new UserError('通知正在处理，请稍候。');
    changingConnection = true;
    try { await storePushConnection(null); }
    finally { changingConnection = false; }
  });
  handle('push-guide', () => shell.openExternal(PUSH_GUIDE));
}

async function initialize() {
  campusSession = session.fromPartition('buaa-session');
  uiSession = session.fromPartition('courtwatch-ui');
  noPermissions(campusSession);
  noPermissions(uiSession);
  campusSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.resourceType === 'mainFrame' ? campusPage(details.url) : campusResource(details.url);
    callback({ cancel: !allowed });
  });
  await uiSession.protocol.handle('courtwatch', appResponse);
  prefs = new Preferences(path.join(app.getPath('userData'), 'settings.json'), safeStorage);
  await prefs.load();
  monitor = new CourtMonitor({ options: prefs.options, checkVenue: readVenue, dispatch, onChange: publish });
  monitor.setDelivery(Boolean(prefs.connection), Boolean(prefs.encrypted), prefs.warning);
  setupIpc();

  mainWindow = new BrowserWindow({
    width: 1130, height: 820, minWidth: 760, minHeight: 630, title: productName, icon: ICON,
    show: false, backgroundColor: '#f3f7fc', autoHideMenuBar: true,
    webPreferences: { ...webPreferences, session: uiSession, preload: path.join(__dirname, 'preload.cjs') },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', event => event.preventDefault());
  mainWindow.webContents.on('page-title-updated', event => event.preventDefault());
  mainWindow.on('close', event => {
    if (exiting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  const trayPath = process.platform === 'darwin' ? path.join(__dirname, 'ui', 'trayTemplate.png') : ICON;
  const trayImage = nativeImage.createFromPath(trayPath).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.on('click', showMain);
  if (process.platform === 'darwin') app.setAboutPanelOptions({ applicationName: productName, applicationVersion: version });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: productName, submenu: [
      { label: `关于${productName}`, role: 'about' }, { type: 'separator' },
      { label: `隐藏${productName}`, role: 'hide' }, { label: `退出${productName}`, role: 'quit' },
    ] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  powerMonitor.on('suspend', () => monitor.setSuspended(true));
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
