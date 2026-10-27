/**
 * dsh-plugin-wakatime —— heartbeat 构造（lib/heartbeat.js）
 *
 * 纯函数模块：不读写文件、不发网络请求、不依赖 DSH 运行时。
 * 输出的字段名严格遵循 WakaTime API v1 的 heartbeat JSON。
 *
 * @module wakatime/lib/heartbeat
 */

/** 默认 category（与 WakaTime 官方 AI 插件一致）。 */
const DEFAULT_CATEGORY = 'ai coding';

/**
 * 字符串字段：去首尾空白，空串/非字符串返回 undefined（调用方据此省略字段）。
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 数值字段：仅接受有限数字，向上取整；0/负数/NaN/Infinity 返回 undefined（按契约省略）。
 * WakaTime 的 token 数、字符数、行变更均为整数。
 * @param {unknown} value
 * @returns {number | undefined}
 */
function optionalCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

/**
 * 构造一条 WakaTime heartbeat。
 *
 * 规则（docs/design.md）：
 * - `time` 以毫秒 epoch 传入，输出秒级（`Math.round(ms) / 1000`，最多 3 位小数）；
 * - 0 / undefined / 空串字段一律省略，绝不输出 null；
 * - 字符串统一去首尾空白；
 * - 字段顺序固定：entity、type、category、time，随后是可选字段。
 *
 * @param {{
 *   time: number,
 *   entity: string,
 *   type?: 'file' | 'app',
 *   category?: string,
 *   project?: string,
 *   branch?: string,
 *   language?: string,
 *   aiSession?: string,
 *   aiInputTokens?: number,
 *   aiOutputTokens?: number,
 *   aiPromptLength?: number,
 *   aiLineChanges?: number,
 * }} input
 * @returns {{
 *   entity: string,
 *   type: 'file' | 'app',
 *   category: string,
 *   time: number,
 *   project?: string,
 *   branch?: string,
 *   language?: string,
 *   ai_session?: string,
 *   ai_input_tokens?: number,
 *   ai_output_tokens?: number,
 *   ai_prompt_length?: number,
 *   ai_line_changes?: number,
 * }} WakaTime heartbeat 对象
 * @throws {TypeError} input 非对象、time 非有限数字或 entity 为空字符串（属于调用方编程错误）
 */
export function buildHeartbeat(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('buildHeartbeat: input 必须是一个对象');
  }

  const { time } = input;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new TypeError('buildHeartbeat: input.time 必须是毫秒时间戳（有限数字）');
  }

  const entity = optionalString(input.entity);
  if (!entity) {
    throw new TypeError('buildHeartbeat: input.entity 必须是非空字符串');
  }

  /** @type {Record<string, string | number>} */
  const heartbeat = {
    entity,
    type: input.type === 'app' ? 'app' : 'file',
    category: optionalString(input.category) ?? DEFAULT_CATEGORY,
    time: Math.round(time) / 1000,
  };

  const project = optionalString(input.project);
  if (project) heartbeat.project = project;

  const branch = optionalString(input.branch);
  if (branch) heartbeat.branch = branch;

  const language = optionalString(input.language);
  if (language) heartbeat.language = language;

  const aiSession = optionalString(input.aiSession);
  if (aiSession) heartbeat.ai_session = aiSession;

  const aiInputTokens = optionalCount(input.aiInputTokens);
  if (aiInputTokens !== undefined) heartbeat.ai_input_tokens = aiInputTokens;

  const aiOutputTokens = optionalCount(input.aiOutputTokens);
  if (aiOutputTokens !== undefined) heartbeat.ai_output_tokens = aiOutputTokens;

  const aiPromptLength = optionalCount(input.aiPromptLength);
  if (aiPromptLength !== undefined) heartbeat.ai_prompt_length = aiPromptLength;

  const aiLineChanges = optionalCount(input.aiLineChanges);
  if (aiLineChanges !== undefined) heartbeat.ai_line_changes = aiLineChanges;

  return heartbeat;
}

export { DEFAULT_CATEGORY as HEARTBEAT_DEFAULT_CATEGORY };
