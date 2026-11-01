'use strict';
const path = require('path');
const crypto = require('crypto');
const { validate, local } = require('./client');
const MARK = Symbol.for('mafuyu.api-helper.bridge');
function spaceId(cfg) {
  const hash = crypto.createHash('sha256').update(JSON.stringify([cfg.provider, cfg.base.replace(/\/+$/, ''), cfg.model])).digest('hex').slice(0, 12);
  return cfg.model + '@api-helper:' + hash;
}
function connect(api, electron, state) {
  const root = electron.app.getAppPath();
  const pkg = require(path.join(root, 'package.json'));
  if (pkg.name !== 'mafuyu-desktop-pet' || pkg.name !== api.host.appId) throw new Error('此版本支持朝比奈真冬桌宠');
  // 只取已加载模块，不再次执行宿主 main.js；插件密钥单独配置。
  const main = require.cache[require.resolve(path.join(root, pkg.main || 'main.js'))];
  const memory = main?.exports?._test?.memory?.();
  if (!memory || typeof memory.cfg !== 'function' || typeof memory.embed !== 'function' || typeof memory.reembed !== 'function') throw new Error('桌宠没有兼容的记忆入口，请使用当前 2.8.5/2.8.6 版本');
  if (path.resolve(memory.file || '') !== path.resolve(electron.app.getPath('userData'), 'memory.json')) throw new Error('记忆数据位置与当前桌宠不一致');
  const ipc = electron.ipcMain, handlers = ipc._invokeHandlers;
  if (!handlers || typeof handlers.get !== 'function' || typeof ipc.removeHandler !== 'function') throw new Error('此 Electron 版本不支持可恢复的语音兼容桥');
  for (const channel of ['call-asr', 'get-settings']) if (typeof handlers.get(channel) !== 'function') throw new Error('缺少桌宠接口：' + channel);
  if (memory[MARK]) throw new Error('接口助手已连接，请勿重复加载');
  const cfgDescriptor = Object.getOwnPropertyDescriptor(memory, 'cfg');
  const embedDescriptor = Object.getOwnPropertyDescriptor(memory, 'embed');
  const oldCfg = memory.cfg, oldEmbed = memory.embed, captured = [], turns = new Map(), cancelled = [];
  let stopped = false;
  function speechReady() {
    const cfg = state.config().speech;
    try { if (stopped || !cfg.enabled) return false; validate(cfg, 'speech'); return true; } catch (_) { return false; }
  }
  function cfgWrapper(...args) {
    const base = oldCfg.apply(this, args), cfg = state.config().memory;
    if (stopped || !cfg.enabled) return base;
    return { ...base, base: cfg.base, key: cfg.key || (local(cfg.base) ? 'LOCAL' : ''), keyLabel: '接口助手的记忆密钥', model: spaceId(cfg) };
  }
  function embedWrapper(texts, options = {}) {
    const cfg = state.config().memory;
    if (stopped || !cfg.enabled) return oldEmbed.call(this, texts, options);
    return state.client.embed({ ...cfg }, texts, options);
  }
  function cancel(_event, prefix) {
    if (typeof prefix !== 'string' || !prefix) return;
    cancelled.push(prefix); if (cancelled.length > 200) cancelled.shift();
    for (const [key, controls] of turns) if (key === prefix || key.startsWith(prefix + ':')) for (const ctrl of controls) ctrl.abort();
  }
  const originalAsr = handlers.get('call-asr');
  async function asrWrapper(event, payload) {
    const cfg = state.config().speech;
    if (stopped || !cfg.enabled) return originalAsr(event, payload);
    const key = typeof payload?.key === 'string' ? payload.key : '';
    if (!key || cancelled.some(p => key === p || key.startsWith(p + ':'))) return { error: 'aborted' };
    const ctrl = new AbortController();
    if (!turns.has(key)) turns.set(key, new Set());
    turns.get(key).add(ctrl);
    try { return await state.client.transcribe({ ...cfg }, payload.wav, ctrl.signal); }
    finally { const set = turns.get(key); set?.delete(ctrl); if (!set?.size) turns.delete(key); }
  }
  const originalSettings = handlers.get('get-settings');
  async function settingsWrapper(...args) {
    const value = await originalSettings(...args);
    return value && speechReady() ? { ...value, hasAsr: true } : value;
  }
  function register(channel, fn) {
    const previous = handlers.get(channel);
    captured.push({ channel, fn, previous });
    ipc.removeHandler(channel);
    try { ipc.handle(channel, fn); }
    catch (e) { if (!handlers.get(channel)) ipc.handle(channel, previous); throw e; }
  }
  function dispose() {
    if (stopped) return;
    stopped = true;
    for (const controls of turns.values()) for (const ctrl of controls) ctrl.abort();
    turns.clear(); ipc.removeListener('call-cancel', cancel);
    // 只还原仍由本插件持有的入口，避免覆盖后加载插件的替换。
    for (const { channel, fn, previous } of captured.reverse()) if (handlers.get(channel) === fn) { ipc.removeHandler(channel); ipc.handle(channel, previous); }
    if (memory.cfg === cfgWrapper) { if (cfgDescriptor) Object.defineProperty(memory, 'cfg', cfgDescriptor); else delete memory.cfg; }
    if (memory.embed === embedWrapper) { if (embedDescriptor) Object.defineProperty(memory, 'embed', embedDescriptor); else delete memory.embed; }
    if (memory[MARK] === dispose) delete memory[MARK];
  }
  api.onDispose(dispose);
  try {
    memory[MARK] = dispose; memory.cfg = cfgWrapper; memory.embed = embedWrapper;
    register('call-asr', asrWrapper); register('get-settings', settingsWrapper); ipc.on('call-cancel', cancel);
  } catch (e) { dispose(); throw e; }
  return { memory, dispose, speechReady, cancelActive() { for (const controls of turns.values()) for (const ctrl of controls) ctrl.abort(); } };
}
module.exports = { connect, spaceId };
