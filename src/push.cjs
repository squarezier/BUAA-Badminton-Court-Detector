'use strict';

const { createHmac } = require('node:crypto');
const { CAMPUSES, VENUES, venueUrl, groupSlots, beijingClock } = require('./courts.cjs');
const { productName } = require('../package.json');

const PUSH_URL = 'https://www.pushplus.plus/send';
const SERVER_CHAN_ORIGIN = 'https://sctapi.ftqq.com';
const PUSH_RESPONSE_LIMIT = 65536;
const NETWORK_RETRY_DELAY = 60000;
const PUSH_RETRY_DEFAULT = 120000;
const SERVER_CHAN_RETRY_DEFAULT = 24 * 60 * 60 * 1000;
const FEISHU_RETRY_DEFAULT = 60000;
const FEISHU_REQUEST_LIMIT = 20000;
const FEISHU_DETAIL_BUDGET = 16000;
const feishuDay = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short',
});
const FEISHU_ERRORS = {
  19001: '飞书 Webhook 无效，请在群机器人设置里重新复制。',
  19021: '飞书签名校验失败，请核对签名密钥和电脑时间。',
  19022: '飞书拒绝了当前网络，请核对机器人 IP 白名单。',
  19024: '飞书关键词校验失败，请在机器人关键词中加入「候羽」。',
  9499: '飞书拒绝了消息格式，请检查机器人配置。',
};

const markdownBlock = content => ({ tag: 'markdown', content });

function feishuCard(title, at, elements) {
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: `${beijingClock(at)} · 北京时间` },
    },
    body: { direction: 'vertical', elements },
  };
}

function feishuAvailability(groups, links) {
  const byDate = new Map();
  let shown = 0;
  let detailBytes = 0;
  for (const group of groups) {
    const price = group.price ? `¥${group.price}/场` : '免费';
    const row = `**${group.start}–${group.end} · ${VENUES[group.venue].label}**  \n场号 **${group.courts.join('、')} 号**　·　${price}`;
    detailBytes += Buffer.byteLength(JSON.stringify(row));
    if (detailBytes > FEISHU_DETAIL_BUDGET) break;
    if (!byDate.has(group.date)) byDate.set(group.date, []);
    byDate.get(group.date).push(row);
    shown++;
  }
  const elements = [...byDate].map(([date, rows]) => {
    const label = feishuDay.format(new Date(`${date}T12:00:00+08:00`)).replace(/(星期|周)/u, ' $1');
    return markdownBlock(`**${label}**\n\n${rows.join('\n\n')}`);
  });
  if (shown < groups.length) {
    elements.push(markdownBlock(`另有 ${groups.length - shown} 组场次，可在候羽查看。`));
  }
  elements.push({ tag: 'hr' }, markdownBlock(`**预约**　${links.join('　·　')}\n余量以官网为准。`));
  return elements;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function notice(campus, slots, at) {
  const site = CAMPUSES[campus];
  const groups = groupSlots(slots);
  const details = groups.slice(0, 18).map(group => {
    const [, month, day] = group.date.split('-');
    const price = group.price ? `¥${group.price}` : '免费';
    return `${Number(month)}月${Number(day)}日 ${group.start}–${group.end} · ${VENUES[group.venue].label} · ${group.courts.join('、')}号 · ${price}`;
  });
  const more = groups.length > 18 ? `另有 ${groups.length - 18} 个时段，可打开桌面应用查看。` : '';
  const venues = [...new Set(groups.map(group => group.venue))];
  const links = venues.map(id => `<a href="${venueUrl(id)}">${escapeHtml(VENUES[id].label)}预约页</a>`).join(' · ');
  const markdownLinks = venues.map(id => `[${VENUES[id].label}预约页](${venueUrl(id)})`).join(' · ');
  const feishuLinks = venues.map(id => `[${VENUES[id].label} ↗](${venueUrl(id)})`);
  const statusChange = '官网状态从已预约变为绿色可约。';
  const footer = '余量随时变化，请以预约页为准。';
  const title = `${productName}｜${site.label}疑似退订 ${slots.length} 场次`;
  const elements = [markdownBlock(statusChange), ...feishuAvailability(groups, feishuLinks)];
  return {
    title,
    content: `<p>${statusChange}</p><ul>${details.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>${more ? `<p>${more}</p>` : ''}<p>${links}</p><p>${footer}</p>`,
    markdown: [statusChange, details.map(line => `- ${line}`).join('\n'), more, markdownLinks, footer].filter(Boolean).join('\n\n'),
    feishuCard: feishuCard(title, at, elements),
  };
}

function testNotice(at) {
  const text = `${beijingClock(at)}（北京时间）发起了一条测试。收到这条消息后，即可通过此渠道接收候羽的空场提醒。`;
  const title = `${productName}｜测试提醒`;
  return {
    title,
    content: `<p>${escapeHtml(text)}</p>`,
    markdown: text,
    feishuCard: feishuCard(title, at, [markdownBlock(text)]),
  };
}

async function readSmallJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No provider response body');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PUSH_RESPONSE_LIMIT) throw new Error('Provider response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function retryDelay(header, fallback) {
  if (!header) return fallback;
  const duration = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isSafeInteger(duration) && duration > 0 ? duration : fallback;
}

function couldNotConnect(error) {
  const cause = error?.cause;
  if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if (cause?.syscall === 'getaddrinfo') return ['EAI_AGAIN', 'ENOTFOUND'].includes(cause.code);
  return cause?.syscall === 'connect' && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(cause.code);
}

function serverChanResult(code) {
  if (code === 0) return { kind: 'accepted', text: 'Server酱已受理，请在微信确认接收。' };
  if (Number.isSafeInteger(code) && code > 0) {
    return { kind: 'blocked', text: `Server酱拒绝发送（${code}），请检查 SendKey、微信通道和当天额度。` };
  }
  return { kind: 'unknown', text: 'Server酱返回异常，送达状态待确认。' };
}

function feishuResult(response, data) {
  const code = data?.code;
  const legacySuccess = code === undefined && data?.StatusCode === 0 && data.StatusMessage === 'success';
  if (response.ok && (code === 0 || legacySuccess)) return { kind: 'accepted', text: '飞书已受理，请在群里确认消息。' };
  if (code === 11232) {
    const retryAfterMs = retryDelay(response.headers.get('retry-after'), FEISHU_RETRY_DEFAULT);
    return { kind: 'retry', retryAfterMs, text: '飞书暂时限流，将延后重试。' };
  }
  if ((Number.isSafeInteger(code) && code !== 0) || [400, 401, 403, 404, 410].includes(response.status)) {
    return { kind: 'blocked', text: FEISHU_ERRORS[code] ?? '飞书拒绝发送，请核对 Webhook 和机器人的安全设置。' };
  }
  return { kind: 'unknown', text: '飞书返回异常，送达状态待确认。' };
}

function pushRequest(connection, message) {
  const json = { 'content-type': 'application/json; charset=utf-8' };
  if (connection.provider === 'feishu') {
    const payload = { msg_type: 'interactive', card: message.feishuCard };
    if (connection.secret) {
      payload.timestamp = String(Math.floor(Date.now() / 1000));
      payload.sign = createHmac('sha256', `${payload.timestamp}\n${connection.secret}`).digest('base64');
    }
    return { endpoint: connection.webhook, headers: json, body: JSON.stringify(payload) };
  }
  if (connection.provider === 'serverchan') {
    const endpoint = `${SERVER_CHAN_ORIGIN}/${encodeURIComponent(connection.token)}.send`;
    return { endpoint, body: new URLSearchParams({ title: message.title, desp: message.markdown, noip: '1' }) };
  }
  const body = JSON.stringify({ token: connection.token, title: message.title, content: message.content, template: 'html', channel: 'wechat' });
  return { endpoint: PUSH_URL, headers: json, body };
}

async function sendPush(connection, message, signal, fetchRequest = fetch) {
  const feishu = connection.provider === 'feishu';
  const serverChan = connection.provider === 'serverchan';
  const service = feishu ? '飞书' : serverChan ? 'Server酱' : 'PushPlus';
  let response;
  try {
    const { endpoint, headers, body } = pushRequest(connection, message);
    if (feishu && Buffer.byteLength(body) > FEISHU_REQUEST_LIMIT) {
      return { kind: 'blocked', text: '提醒超过飞书消息大小限制，请在候羽查看当前空场。' };
    }
    const timeout = AbortSignal.timeout(12000);
    response = await fetchRequest(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body,
    });
    if (feishu && response.status !== 429 && response.status < 500) {
      const data = await readSmallJson(response).catch(() => null);
      if (signal?.aborted) return { kind: 'cancelled' };
      return feishuResult(response, data);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        const fallback = feishu ? FEISHU_RETRY_DEFAULT : serverChan ? SERVER_CHAN_RETRY_DEFAULT : PUSH_RETRY_DEFAULT;
        return { kind: 'retry', retryAfterMs: retryDelay(response.headers.get('retry-after'), fallback), text: `${service}请求过于频繁，将延后重试。` };
      }
      if (response.status === 401 || response.status === 403) return { kind: 'blocked', text: `${service}拒绝了请求，请核对密钥和微信配置。` };
      return { kind: 'unknown', text: `${service}返回异常，送达状态待确认。` };
    }
    const result = await readSmallJson(response);
    const value = result?.code;
    if (serverChan) return serverChanResult(typeof value === 'string' && /^\d{1,8}$/.test(value) ? Number(value) : value);
    const code = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
    if (code === 200) return { kind: 'accepted', text: 'PushPlus 已受理，请在微信确认接收。' };
    if (code === 500) return { kind: 'retry', retryAfterMs: PUSH_RETRY_DEFAULT, text: 'PushPlus 暂时异常，将在后续检查中重试。' };
    if (code === 903) return { kind: 'blocked', text: 'PushPlus 令牌无效，请在官网重新复制。' };
    if (code === 905) return { kind: 'blocked', text: 'PushPlus 要求先完成实名认证。' };
    if (code === 900) return { kind: 'blocked', text: 'PushPlus 限制发送，请检查配额或账号状态。' };
    if (!Number.isInteger(code) || code < 100 || code > 999) return { kind: 'unknown', text: 'PushPlus 返回异常，送达状态待确认。' };
    return { kind: 'blocked', text: `PushPlus 拒绝发送（${code}），请核对令牌和服务号。` };
  } catch (error) {
    // A failure before connecting cannot have delivered the POST. A timeout or
    // disconnect after connection is ambiguous and must not be retried blindly.
    if (!response && couldNotConnect(error)) {
      return { kind: 'retry', retryAfterMs: NETWORK_RETRY_DELAY, text: `暂时无法连接${service}，重新核验空场后将重试。` };
    }
    if (signal?.aborted) return { kind: 'cancelled' };
    return { kind: 'unknown', text: '连接中断或超时，送达状态待确认。' };
  }
}

module.exports = { notice, testNotice, sendPush };
