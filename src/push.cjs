'use strict';

const { CAMPUSES, VENUES, venueUrl, groupSlots, beijingClock, parseToken } = require('./courts.cjs');
const { productName } = require('../package.json');

const PUSH_URL = 'https://www.pushplus.plus/send';
const SERVER_CHAN_ORIGIN = 'https://sctapi.ftqq.com';
const PUSH_RESPONSE_LIMIT = 65536;
const PUSH_RETRY_DEFAULT = 120000;
const SERVER_CHAN_RETRY_DEFAULT = 24 * 60 * 60 * 1000;

function serverChanKey(value) {
  const token = parseToken(value);
  return token?.startsWith('SCT') ? token : null;
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
  const heading = `${beijingClock(at)}（北京时间）发现以下空场：`;
  const footer = '余量随时变化，请以预约页为准。';
  return {
    title: `${productName}｜${site.label}新增 ${slots.length} 场次`,
    content: `<p>${escapeHtml(heading)}</p><ul>${details.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>${more ? `<p>${more}</p>` : ''}<p>${links}</p><p>${footer}</p>`,
    markdown: [heading, details.map(line => `- ${line}`).join('\n'), more, markdownLinks, footer].filter(Boolean).join('\n\n'),
  };
}

function testNotice(at) {
  const text = `${beijingClock(at)}（北京时间）发起了一条测试。收到这条消息，表示微信服务号可接收场地提醒。`;
  return {
    title: `${productName}｜测试提醒`,
    content: `<p>${escapeHtml(text)}</p>`,
    markdown: text,
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

function serverChanResult(code) {
  if (code === 0) return { kind: 'accepted', text: 'Server酱已受理，请在微信确认接收。' };
  if (Number.isSafeInteger(code) && code > 0) {
    return { kind: 'blocked', text: `Server酱拒绝发送（${code}），请检查 SendKey、微信通道和当天额度。` };
  }
  return { kind: 'unknown', text: 'Server酱返回异常，送达状态待确认。' };
}

async function sendPush(token, message, signal, fetchRequest = fetch) {
  const serverChan = Boolean(serverChanKey(token));
  const service = serverChan ? 'Server酱' : 'PushPlus';
  const endpoint = serverChan ? `${SERVER_CHAN_ORIGIN}/${encodeURIComponent(token)}.send` : PUSH_URL;
  const body = serverChan
    ? new URLSearchParams({ title: message.title, desp: message.markdown, noip: '1' })
    : JSON.stringify({ token, title: message.title, content: message.content, template: 'html', channel: 'wechat' });
  try {
    const timeout = AbortSignal.timeout(12000);
    const response = await fetchRequest(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: serverChan ? undefined : { 'content-type': 'application/json; charset=utf-8' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        const fallback = serverChan ? SERVER_CHAN_RETRY_DEFAULT : PUSH_RETRY_DEFAULT;
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
  } catch {
    if (signal?.aborted) return { kind: 'cancelled' };
    return { kind: 'unknown', text: '连接中断或超时，送达状态待确认。' };
  }
}

module.exports = { notice, testNotice, sendPush, serverChanKey };
