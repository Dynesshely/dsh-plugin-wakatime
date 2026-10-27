import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseIni,
  readWakaTimeConfig,
  resolveSettings,
  computeStateDir,
  ensureStateDir,
  defaultUserAgent,
  normalizeString,
  clampInt,
  DEFAULT_API_URL,
  DEFAULT_CATEGORY,
  MIN_INTERVAL_RANGE,
  IDLE_TIMEOUT_RANGE,
} from '../lib/cfg.js';

/**
 * 建一个临时目录，并在测试结束后删掉。
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
async function makeTempDir(t, prefix = 'wakatime-cfg-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 写一个临时 cfg 文件。
 * @param {string} dir
 * @param {string} content
 * @param {string} [name]
 * @returns {Promise<string>}
 */
async function writeCfg(dir, content, name = '.wakatime.cfg') {
  const file = path.join(dir, name);
  await fsp.writeFile(file, content, 'utf8');
  return file;
}

test('parseIni：BOM/CRLF/注释/空格/无 section 归入 settings', () => {
  const text = [
    '\uFEFF# 整行注释',
    '; 分号注释',
    'top_key = top value',
    'spaces   =   padded   ',
    '',
    '[Settings]',
    'API_KEY = abc-123',
    'proxy=http://localhost:40404',
    'debug=false',
    '[Other]',
    'X = y',
  ].join('\r\n');

  const { sections } = parseIni(text);

  assert.equal(sections.settings.top_key, 'top value');
  assert.equal(sections.settings.spaces, 'padded');
  assert.equal(sections.settings.api_key, 'abc-123');
  assert.equal(sections.settings.proxy, 'http://localhost:40404');
  assert.equal(sections.settings.debug, 'false');
  // section 名小写
  assert.equal(sections.settings.x, undefined);
  assert.equal(sections.other.x, 'y');
  // 键名小写
  assert.equal(sections.settings.API_KEY, undefined);
});

test('parseIni：同名键后者覆盖，续行并入上一个值，不误伤内联井号', () => {
  const text = [
    '[settings]',
    'api_key = first',
    'api_key = second',
    'note = a # b',
    'multi = line1',
    '    line2',
    '    line3',
    'junk-without-equals',
  ].join('\n');

  const { sections } = parseIni(text);

  assert.equal(sections.settings.api_key, 'second');
  // 内联 # 不是注释（值里允许出现 #）
  assert.equal(sections.settings.note, 'a # b');
  // 以空白开头的行作为续行并入多行值
  assert.equal(sections.settings.multi, 'line1 line2 line3');
  // 不以空白开头且无 = 的乱行直接忽略，不影响上一个键
  assert.equal(sections.settings.junkWithOutEquals, undefined);
  assert.equal(sections.settings.api_key, 'second');
});

test('parseIni：空文本/非字符串返回空 sections，不抛错', () => {
  assert.deepEqual(parseIni(''), { sections: {} });
  assert.deepEqual(parseIni(null), { sections: {} });
  assert.deepEqual(parseIni(undefined), { sections: {} });
});

test('readWakaTimeConfig：文件不存在 → { found:false } 且不抛错', async (t) => {
  const dir = await makeTempDir(t);
  const cfgPath = path.join(dir, 'nope', '.wakatime.cfg');

  const result = await readWakaTimeConfig({ cfgPath });

  assert.equal(result.found, false);
  assert.equal(result.path, path.resolve(cfgPath));
  assert.equal(result.sections, undefined);
});

test('readWakaTimeConfig：读取 BOM+CRLF 文件，返回解析后的 settings 且不携带原文', async (t) => {
  const dir = await makeTempDir(t);
  const cfgPath = await writeCfg(
    dir,
    '\uFEFF[settings]\r\napi_key = key-in-file\r\nproxy = http://localhost:40404\r\ndebug = true\r\n',
  );

  const result = await readWakaTimeConfig({ cfgPath });

  assert.equal(result.found, true);
  assert.equal(result.path, path.resolve(cfgPath));
  assert.equal(result.settings.api_key, 'key-in-file');
  assert.equal(result.settings.proxy, 'http://localhost:40404');
  assert.equal(result.settings.debug, 'true');
  // 返回值里不放原文，避免 api_key 泄漏到日志
  assert.equal('text' in result, false);
  assert.equal(JSON.stringify(result).includes('key-in-file'), true);
});

test('readWakaTimeConfig：目标不可读（目录）→ { found:false } 且不抛错', async (t) => {
  const dir = await makeTempDir(t);
  const asDir = path.join(dir, '.wakatime.cfg');
  await fsp.mkdir(asDir);

  const result = await readWakaTimeConfig({ cfgPath: asDir });

  assert.equal(result.found, false);
  assert.ok(result.error);
});

test('readWakaTimeConfig：默认路径与本机真实 ~/.wakatime.cfg（存在时）', async (t) => {
  const result = await readWakaTimeConfig();

  assert.equal(typeof result.path, 'string');
  assert.ok(result.path.endsWith('.wakatime.cfg'));
  if (!result.found) {
    t.skip('本机没有 ~/.wakatime.cfg，跳过真实文件解析验证');
    return;
  }
  assert.equal(result.found, true);
  assert.equal(typeof result.settings, 'object');
  // 不打印值，只验证解析结果类型
  if ('api_key' in result.settings) {
    assert.equal(typeof result.settings.api_key, 'string');
    assert.ok(result.settings.api_key.length > 0);
  }
  if ('proxy' in result.settings) {
    assert.equal(typeof result.settings.proxy, 'string');
  }
});

test('resolveSettings：插件 config 覆盖 cfg 文件，数值夹到合法范围', () => {
  const file = {
    found: true,
    path: 'C:\\fake\\.wakatime.cfg',
    settings: {
      api_key: 'file-key',
      proxy: 'http://localhost:40404',
      hostname: 'file-host',
      debug: 'true',
      language: 'file-lang',
    },
  };

  const settings = resolveSettings({
    file,
    config: {
      apiKey: 'plugin-key',
      minIntervalSeconds: 1,
      idleTimeoutMinutes: 9999,
      debug: false,
      enabled: false,
      entityType: 'app',
      category: '  ai coding  ',
      projectFromCwd: false,
      includeSubagentSessions: true,
      language: ' typescript ',
      apiUrl: 'https://example.test/api/v1///',
      hostname: 'plugin-host',
    },
    env: { DSH_HOME: path.join(os.tmpdir(), 'dsh-home-test') },
  });

  assert.equal(settings.apiKey, 'plugin-key');
  assert.equal(settings.apiUrl, 'https://example.test/api/v1');
  assert.equal(settings.proxy, 'http://localhost:40404');
  assert.equal(settings.hostname, 'plugin-host');
  assert.equal(settings.debug, false); // plugin boolean 覆盖 cfg 的 'true'
  assert.equal(settings.enabled, false);
  assert.equal(settings.minIntervalSeconds, MIN_INTERVAL_RANGE[0]);
  assert.equal(settings.idleTimeoutMinutes, IDLE_TIMEOUT_RANGE[1]);
  assert.equal(settings.entityType, 'app');
  assert.equal(settings.category, 'ai coding');
  assert.equal(settings.projectFromCwd, false);
  assert.equal(settings.includeSubagentSessions, true);
  assert.equal(settings.language, 'typescript');
  assert.equal(settings.cfgPath, 'C:\\fake\\.wakatime.cfg');
  assert.equal(settings.stateDir, path.join(path.resolve(os.tmpdir(), 'dsh-home-test'), 'cache', 'wakatime-dsh'));
});

test('resolveSettings：无 cfg 文件时的默认值', () => {
  const settings = resolveSettings({ file: { found: false }, config: {}, env: {} });

  assert.equal(settings.apiKey, undefined);
  assert.equal(settings.apiUrl, DEFAULT_API_URL);
  assert.equal(settings.proxy, undefined);
  assert.equal(settings.hostname, os.hostname());
  assert.equal(settings.debug, false);
  assert.equal(settings.enabled, true);
  assert.equal(settings.minIntervalSeconds, 120);
  assert.equal(settings.idleTimeoutMinutes, 15);
  assert.equal(settings.entityType, 'file');
  assert.equal(settings.category, DEFAULT_CATEGORY);
  assert.equal(settings.projectFromCwd, true);
  assert.equal(settings.includeSubagentSessions, false);
  assert.equal(settings.language, undefined);
  assert.match(settings.userAgent, /^dsh-plugin-wakatime\/\d+\.\d+\.\d+ \(.+\) node\/\d+\.\d+\.\d+/);
  assert.ok(settings.stateDir.length > 0);
});

test('resolveSettings：cfg 的 debug/hostname/apiKey 作为回退，非法数值被夹住', () => {
  const file = {
    found: true,
    settings: { api_key: 'k', debug: 'TRUE', hostname: 'cfg-host' },
  };
  const settings = resolveSettings({
    file,
    config: { minIntervalSeconds: 5000, idleTimeoutMinutes: 0, enabled: 'yes' },
    env: {},
  });

  assert.equal(settings.apiKey, 'k');
  assert.equal(settings.debug, true);
  assert.equal(settings.hostname, 'cfg-host');
  assert.equal(settings.minIntervalSeconds, 900);
  assert.equal(settings.idleTimeoutMinutes, IDLE_TIMEOUT_RANGE[0]);
  // 非 boolean 的 enabled 不覆盖默认 true
  assert.equal(settings.enabled, true);
});

test('resolveSettings：config 为 null / 非对象时不崩', () => {
  const settings = resolveSettings({ file: null, config: null, env: {} });
  assert.equal(settings.enabled, true);
  assert.equal(settings.apiKey, undefined);
});

test('computeStateDir：DSH_HOME 优先，否则 ~/.dsh/cache，含目录名', () => {
  const dshHome = path.join(os.tmpdir(), 'dsh-home-x');
  assert.equal(
    computeStateDir({ env: { DSH_HOME: dshHome }, homeDir: 'C:\\Users\\x' }),
    path.join(path.resolve(dshHome), 'cache', 'wakatime-dsh'),
  );
  assert.equal(
    computeStateDir({ env: {}, homeDir: path.join(os.tmpdir(), 'home-x') }),
    path.join(path.resolve(os.tmpdir(), 'home-x'), '.dsh', 'cache', 'wakatime-dsh'),
  );
});

test('ensureStateDir：创建嵌套目录；目标不可创建时退化到 fallback', async (t) => {
  const dir = await makeTempDir(t);
  const target = path.join(dir, 'a', 'b', 'wakatime-dsh');
  assert.equal(await ensureStateDir(target), target);
  assert.equal((await fsp.stat(target)).isDirectory(), true);

  // 把一个普通文件当作父目录 → mkdir 失败 → 退化到 fallbackDir
  const blocker = path.join(dir, 'blocker');
  await fsp.writeFile(blocker, 'x');
  const fallback = path.join(dir, 'fallback-state');
  const warnings = [];
  const actual = await ensureStateDir(path.join(blocker, 'wakatime-dsh'), {
    fallbackDir: fallback,
    logger: { warn: (msg) => warnings.push(msg) },
  });
  assert.equal(actual, fallback);
  assert.equal((await fsp.stat(fallback)).isDirectory(), true);
  assert.equal(warnings.length, 1);
});

test('defaultUserAgent / normalizeString / clampInt 的边界行为', () => {
  const ua = defaultUserAgent({ platform: 'win32', release: '10.0.26100', arch: 'x64', nodeVersion: '23.3.0' });
  assert.equal(ua, 'dsh-plugin-wakatime/0.2.0 (Windows-10.0.26100-x64) node/23.3.0');

  assert.equal(normalizeString('  x '), 'x');
  assert.equal(normalizeString('   '), undefined);
  assert.equal(normalizeString(42), undefined);

  assert.equal(clampInt(5, 120, 10, 900), 10);
  assert.equal(clampInt(1000, 120, 10, 900), 900);
  assert.equal(clampInt('300', 120, 10, 900), 300);
  assert.equal(clampInt('abc', 120, 10, 900), 120);
  assert.equal(clampInt(120.6, 120, 10, 900), 121);
});

