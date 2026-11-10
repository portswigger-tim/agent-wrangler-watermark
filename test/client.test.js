import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { render, budget, liveRequests } from '../public/index.js';

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
  f.el.querySelector('button').dispatchEvent(new f.window.Event('click'));
  assert.equal(f.sent.length, 0);
  render(f.el, data, { ...f.options, confirm: () => true });
  const buttons = f.el.querySelectorAll('button');
  buttons[0].dispatchEvent(new f.window.Event('click'));
  buttons[1].dispatchEvent(new f.window.Event('click'));
  assert.deepEqual(f.sent, [{ type: 'watermark-release', id: 'one' }, { type: 'watermark-release', id: 'two' }]);
});

test('per-session panel filters requests; stale and failed telemetry pause indicators', () => {
  const f = fixture();
  render(f.el, data, { ...f.options, owner: 'a', now: 20000 });
  assert.equal(f.el.querySelectorAll('tbody tr').length, 1);
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
  const button = f.el.querySelector('button');
  Object.defineProperty(f.document, 'activeElement', { configurable: true, get: () => button });
  render(f.el, { ...data, telemetry: { ...data.telemetry, cpuPercent: 80 }, requests: [] }, f.options);
  assert.match(f.el.textContent, /CPU: 80%/);
  assert.equal(f.el.querySelectorAll('tbody tr').length, 0);
});
