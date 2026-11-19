'use strict';

const CAMPUS_HOSTS = new Set(['cgyy.buaa.edu.cn', 'sso.buaa.edu.cn']);
const PASSIVE_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);
const ASSET_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'cache-control', 'origin', 'range', 'user-agent']);

function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password) return url;
  } catch { /* Invalid destination. */ }
  return null;
}

function campusPage(value) {
  return CAMPUS_HOSTS.has(httpsUrl(value)?.hostname);
}

function allowedCampusRequest({ url, method, resourceType }) {
  const host = httpsUrl(url)?.hostname;
  if (!host) return false;
  return CAMPUS_HOSTS.has(host) || (method === 'GET' && PASSIVE_TYPES.has(resourceType) &&
    (host === 'buaa.edu.cn' || host.endsWith('.buaa.edu.cn')));
}

function assetRequestHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => ASSET_HEADERS.has(name.toLowerCase())));
}

function assetResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !/^set-cookie2?$/i.test(name)));
}

module.exports = { httpsUrl, campusPage, allowedCampusRequest, assetRequestHeaders, assetResponseHeaders };
