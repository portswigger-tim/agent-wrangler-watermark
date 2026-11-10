import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import client, { render, renderCard, budget, liveRequests } from '../public/index.js';

const data = {
  telemetry: { sampledAt: 1000, cpuPercent: 25, cpuCores: 8, totalMemoryMiB: 16384, availableMemoryMiB: 8192, memorySource: 'test' },
  pressure: 'normal',
  requests: [
    { id: 'one', owner: 'a', label: '<img src=x onerror=alert(1)>', memoryMiB: 1024, cpuCores: 2, state: 'granted' },
    { id: 'two', owner: 'b', label: 'queued', memoryMiB: 2048, cpuCores: 4, state: 'queued' },
    { id: 'three', owner: 'a', label: 'finished', memoryMiB: 1024, cpuCores: 2, state: 'released' },
  ],
};

function fixture() {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const el = document.querySelector('#root');
  const sent = [];
  return { document, window, el, sent, options: { api: { send: (frame) => sent.push(frame) }, now: 1000 } };
}

test('dashboard displays measured metrics and literal labels without HTML injection', () => {
  const f = fixture();
  render(f.el, data, f.options);
  assert.match(f.el.textContent, /CPU: 25%/);
  assert.match(f.el.textContent, /8.0 GiB available/);
  assert.match(f.el.textContent, /not measured session usage/);
  assert.equal(f.el.querySelectorAll('tbody tr').length, 2);
  assert.equal(f.el.querySelectorAll('meter').length, 2);
  assert.equal(f.el.querySelector('img'), null);
  assert.match(f.el.textContent, /<img src=x/);
});

test('release requires stopped-work confirmation, cancelling a queue does not', () => {
  const f = fixture();
  render(f.el, data, { ...f.options, confirm: () => false });
  f.el.querySelector('[data-watermark-request="one"]').dispatchEvent(new f.window.Event('click'));
  assert.equal(f.sent.length, 0);
  render(f.el, data, { ...f.options, confirm: () => true });
  f.el.querySelector('[data-watermark-request="one"]').dispatchEvent(new f.window.Event('click'));
  f.el.querySelector('[data-watermark-request="two"]').dispatchEvent(new f.window.Event('click'));
  assert.deepEqual(f.sent, [{ type: 'watermark-release', id: 'one' }, { type: 'watermark-release', id: 'two' }]);
});

test('stale and failed host telemetry pause indicators in the app', () => {
  const f = fixture();
  render(f.el, data, { ...f.options, now: 20000 });
  assert.match(f.el.textContent, /Waiting for fresh/);
  render(f.el, { error: 'cannot sample', requests: [] }, f.options);
  assert.match(f.el.textContent, /Admissions paused: cannot sample/);
});

test('reserved figures exclude queued and terminal requests', () => {
  assert.deepEqual(budget(data.requests), { memory: 1024, cpu: 2 });
  assert.equal(liveRequests(data, 'a').length, 1);
});

test('metrics and rows refresh while a release button has focus', () => {
  const f = fixture();
  render(f.el, data, f.options);
  const button = f.el.querySelector('[data-watermark-request="one"]');
  Object.defineProperty(f.document, 'activeElement', { configurable: true, get: () => button });
  render(f.el, { ...data, telemetry: { ...data.telemetry, cpuPercent: 80 }, requests: [] }, f.options);
  assert.match(f.el.textContent, /CPU: 80%/);
  assert.equal(f.el.querySelectorAll('tbody tr').length, 0);
});

test('status focus survives repeated refreshes after a control disappears', () => {
  const f = fixture();
  let active;
  Object.defineProperty(f.document, 'activeElement', { configurable: true, get: () => active });
  f.window.HTMLElement.prototype.focus = function () { active = this; };
  render(f.el, data, f.options);
  f.el.querySelector('[data-watermark-request="one"]').focus();
  render(f.el, { ...data, requests: [] }, f.options);
  assert.ok(active.classList.contains('watermark-status'));
  render(f.el, { ...data, requests: [] }, f.options);
  assert.equal(active, f.el.querySelector('.watermark-status'));
});

test('cards show measured CPU and RSS, separate from reservation counts, and open the app', () => {
  const f = fixture();
  let opened = 0;
  const graph = { ...data, sessionUsage: { sampledAt: 1000, sessions: { a: { status: 'ok', cpuPercent: 125, memoryMiB: 512, processCount: 3 } } } };
  renderCard(f.el, { sessionId: 'a' }, graph, { now: 1000, navigate: () => opened++ });
  assert.match(f.el.textContent, /CPU 125% · RAM 512 MiB · 1 grant/);
  assert.doesNotMatch(f.el.textContent, /1.0 GiB|queued/);
  assert.match(f.el.querySelector('button').title, /100% = one core/);
  f.el.querySelector('button').dispatchEvent(new f.window.Event('click'));
  assert.equal(opened, 1);
  renderCard(f.el, { sessionId: 'a' }, graph, { now: 20000 });
  assert.match(f.el.textContent, /CPU — · RAM —/);
});

test('Watermark app groups the current queue, offers, grants and readable session labels', () => {
  const f = fixture();
  const offered = { id: 'offer', owner: 'a', label: 'Build offer', state: 'offered', claimDeadline: 6000, memoryMiB: 100, cpuCores: 1 };
  render(f.el, { ...data, requests: [...data.requests, offered] }, { ...f.options, sessions: [{ sessionId: 'a', label: 'Project build' }] });
  assert.equal(f.el.querySelector('#watermark-queued tbody tr').textContent.includes('queued'), true);
  assert.match(f.el.querySelector('#watermark-offered').textContent, /Build offer.*Project build.*5s/);
  assert.match(f.el.querySelector('#watermark-granted').textContent, /Project build/);
  assert.equal(f.el.querySelectorAll('.watermark-count strong').length, 3);
});

test('client contributes cards and an app view, with no session-panel section', () => {
  const slots = [];
  client.register({ api: {}, register: (slot) => slots.push(slot) });
  assert.deepEqual(slots, ['view', 'card.pill']);
});

test('session links and count tiles keep keyboard focus across graph updates', () => {
  for (const key of ['session:one', 'count:queued']) {
    const f = fixture();
    let active;
    Object.defineProperty(f.document, 'activeElement', { configurable: true, get: () => active });
    const prototype = f.window.HTMLElement.prototype;
    const original = prototype.focus;
    prototype.focus = function () { active = this; };
    try {
      render(f.el, data, f.options);
      [...f.el.querySelectorAll('[data-watermark-focus]')].find((el) => el.dataset.watermarkFocus === key).focus();
      render(f.el, data, f.options);
      assert.equal(active.dataset.watermarkFocus, key);
      assert.ok(f.el.contains(active));
    } finally { prototype.focus = original; }
  }
});
