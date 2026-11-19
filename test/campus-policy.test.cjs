'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { campusPage, allowedCampusRequest, assetRequestHeaders, assetResponseHeaders } = require('../src/campus-policy.cjs');

test('only the two official campus origins can host documents or receive active requests', () => {
  for (const origin of ['https://sso.buaa.edu.cn', 'https://cgyy.buaa.edu.cn']) {
    assert.equal(campusPage(origin), true);
    assert.equal(allowedCampusRequest({ url: origin, method: 'POST', resourceType: 'xhr' }), true);
  }
  const asset = 'https://images.buaa.edu.cn/logo.png';
  assert.equal(allowedCampusRequest({ url: asset, method: 'GET', resourceType: 'image' }), true);
  for (const resourceType of ['mainFrame', 'subFrame', 'script', 'xhr', 'webSocket']) {
    assert.equal(allowedCampusRequest({ url: asset, method: 'GET', resourceType }), false);
  }
  for (const url of ['http://sso.buaa.edu.cn', 'https://example.invalid', 'file:///fixture']) {
    assert.equal(allowedCampusRequest({ url, method: 'GET', resourceType: 'image' }), false);
  }
  assert.equal(allowedCampusRequest({ url: asset, method: 'POST', resourceType: 'image' }), false);
});

test('passive campus assets receive only display headers and cannot set or replace session cookies', () => {
  assert.deepEqual(assetRequestHeaders({
    Accept: 'image/png', Range: 'bytes=0-4', 'Accept-Language': 'zh-CN',
    Cookie: 'fixture=1', Referer: 'https://sso.buaa.edu.cn/fixture', Authorization: 'fixture',
    'X-Campus-Token': 'fixture', 'X-Student-Identity': 'fixture',
  }), { Accept: 'image/png', Range: 'bytes=0-4', 'Accept-Language': 'zh-CN' });
  assert.deepEqual(assetResponseHeaders({
    'set-cookie': ['fixture=1'], 'Set-Cookie2': ['fixture=2'], 'Content-Type': ['image/png'], 'Cache-Control': ['private'],
  }), { 'Content-Type': ['image/png'], 'Cache-Control': ['private'] });
});
