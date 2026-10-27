import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHeartbeat } from '../lib/heartbeat.js';

test('buildHeartbeat：完整字段映射为 WakaTime API v1 字段名，顺序稳定', () => {
  const heartbeat = buildHeartbeat({
    time: 1730000000123,
    entity: 'D:\\Projects\\demo',
    type: 'app',
    category: 'ai coding',
    project: 'demo',
    branch: 'main',
    language: 'typescript',
    aiSession: 'session-1',
    aiInputTokens: 1200,
    aiOutputTokens: 345,
    aiPromptLength: 88,
    aiLineChanges: 12,
  });

  assert.deepEqual(heartbeat, {
    entity: 'D:\\Projects\\demo',
    type: 'app',
    category: 'ai coding',
    time: 1730000000.123,
    project: 'demo',
    branch: 'main',
    language: 'typescript',
    ai_session: 'session-1',
    ai_input_tokens: 1200,
    ai_output_tokens: 345,
    ai_prompt_length: 88,
    ai_line_changes: 12,
  });
  assert.deepEqual(Object.keys(heartbeat), [
    'entity',
    'type',
    'category',
    'time',
    'project',
    'branch',
    'language',
    'ai_session',
    'ai_input_tokens',
    'ai_output_tokens',
    'ai_prompt_length',
    'ai_line_changes',
  ]);
});

test('buildHeartbeat：time 毫秒 → 秒，保留最多 3 位小数', () => {
  assert.equal(buildHeartbeat({ time: 1730000000123, entity: 'e' }).time, 1730000000.123);
  assert.equal(buildHeartbeat({ time: 1730000000999, entity: 'e' }).time, 1730000000.999);
  assert.equal(buildHeartbeat({ time: 1730000000000, entity: 'e' }).time, 1730000000);
  // 传入带小数的毫秒也会先四舍五入到整毫秒
  assert.equal(buildHeartbeat({ time: 1730000000123.7, entity: 'e' }).time, 1730000000.124);
});

test('buildHeartbeat：0 / undefined / 空串字段一律省略，绝不输出 null', () => {
  const heartbeat = buildHeartbeat({
    time: 1730000000123,
    entity: '  D:\\x  ',
    type: 'file',
    category: '',
    project: '',
    branch: '   ',
    language: undefined,
    aiSession: '',
    aiInputTokens: 0,
    aiOutputTokens: undefined,
    aiPromptLength: 0,
    aiLineChanges: 0,
  });

  assert.deepEqual(heartbeat, {
    entity: 'D:\\x',
    type: 'file',
    category: 'ai coding',
    time: 1730000000.123,
  });
  for (const value of Object.values(heartbeat)) {
    assert.notEqual(value, null);
  }
});

test('buildHeartbeat：字符串去首尾空白，数值取整', () => {
  const heartbeat = buildHeartbeat({
    time: 1,
    entity: '  /repo  ',
    project: '  repo  ',
    category: '  ai coding  ',
    aiInputTokens: 12.7,
    aiOutputTokens: 0.4,
    aiPromptLength: 7.5,
    aiLineChanges: 3.2,
  });

  assert.equal(heartbeat.entity, '/repo');
  assert.equal(heartbeat.project, 'repo');
  assert.equal(heartbeat.category, 'ai coding');
  assert.equal(heartbeat.ai_input_tokens, 13);
  // 0.4 四舍五入为 0 → 省略
  assert.equal('ai_output_tokens' in heartbeat, false);
  assert.equal(heartbeat.ai_prompt_length, 8);
  assert.equal(heartbeat.ai_line_changes, 3);
});

test('buildHeartbeat：type 默认 file，非法值回退 file，category 默认 ai coding', () => {
  const heartbeat = buildHeartbeat({ time: 1, entity: '/x', type: 'url' });
  assert.equal(heartbeat.type, 'file');
  assert.equal(heartbeat.category, 'ai coding');
});

test('buildHeartbeat：负数/NaN/Infinity 数值字段被省略', () => {
  const heartbeat = buildHeartbeat({
    time: 1,
    entity: '/x',
    aiInputTokens: -5,
    aiOutputTokens: Number.NaN,
    aiPromptLength: Number.POSITIVE_INFINITY,
    aiLineChanges: -0,
  });

  for (const key of ['ai_input_tokens', 'ai_output_tokens', 'ai_prompt_length', 'ai_line_changes']) {
    assert.equal(key in heartbeat, false, `${key} 不应出现`);
  }
});

test('buildHeartbeat：非法入参抛 TypeError（调用方编程错误）', () => {
  assert.throws(() => buildHeartbeat(null), TypeError);
  assert.throws(() => buildHeartbeat('x'), TypeError);
  assert.throws(() => buildHeartbeat({ entity: '/x' }), TypeError);
  assert.throws(() => buildHeartbeat({ time: Number.NaN, entity: '/x' }), TypeError);
  assert.throws(() => buildHeartbeat({ time: 1 }), TypeError);
  assert.throws(() => buildHeartbeat({ time: 1, entity: '   ' }), TypeError);
});
