'use strict';
const fs = require('fs');
const path = require('path');
const { Client, validate, errorMessage } = require('./client');
const { PRESETS, defaults, parseConfig } = require('./catalog');
const { connect } = require('./host-adapter');
let cleanup;
exports.activate = api => {
  if (api.apiVersion !== 1) throw new Error('需要桌宠插件接口 v1');
  const saved = api.storage.get('config', {});
  let config = {};
  for (const kind of ['speech', 'memory']) {
    try { config[kind] = parseConfig(kind, saved[kind] || {}, defaults(kind), false); } catch (_) { config[kind] = defaults(kind); }
  }
  const client = new Client(); let panel = null, stopped = false, rebuilding = false, progress = '', failure = '';
  api.onDispose(() => client.stop());
  const adapter = connect(api, require('electron'), { config: () => config, client });
  function publicConfig(kind) { const { key, ...rest } = config[kind]; return { ...rest, hasKey: !!key }; }
  function status() {
    const stats = adapter.memory.stats();
    return { speech: publicConfig('speech'), memory: publicConfig('memory'), presets: PRESETS,
      speechReady: adapter.speechReady(), hostMemoryOn: adapter.memory.cfg().on, memoryCount: stats.total ?? (stats.memory + stats.knowledge), stale: stats.stale,
      rebuilding, progress, error: failure, backup: fs.existsSync(path.join(api.dataDir, 'memory-before-rebuild.json')) };
  }
  function availability() { api.renderer.send({ type: 'availability', speechReady: adapter.speechReady(), hostHasAsr: !!api.settings.get().hasAsr }); }
  function send() { availability(); if (panel && !panel.isDestroyed()) api.windows.post(panel, 'state', status()); }
  function open() {
    if (panel && !panel.isDestroyed()) return panel.focus();
    panel = api.windows.open({ file: 'panel.html', width: 760, height: 790, title: '接口助手', backgroundColor: '#f6f5fb' });
  }
  function draft(kind, input) { if (!['speech','memory'].includes(kind)) throw new Error('设置类型不支持'); return parseConfig(kind, input, config[kind]); }
  api.menu.add({ label: '接口助手…', click: open });
  api.ipc.handle('state', status);
  api.ipc.handle('save', input => {
    if (rebuilding) return { error: '正在重算记忆，请完成后再改设置' };
    try {
      const next = { speech: draft('speech', input?.speech || {}), memory: draft('memory', input?.memory || {}) };
      for (const kind of ['speech','memory']) if (next[kind].enabled) validate(next[kind], kind);
      client.abort(); adapter.cancelActive();
      api.storage.set('config', next); config = next; failure = ''; send();
      return { ok: true, state: status() };
    } catch (e) { return { error: errorMessage(e) }; }
  });
  api.ipc.handle('models', async input => {
    try { const cfg = draft(input?.kind, input?.config || {}); return await client.models(input.kind, cfg); }
    catch (e) { return { error: errorMessage(e) }; }
  });
  api.ipc.handle('test', async input => {
    try {
      const kind = input?.kind, cfg = draft(kind, input?.config || {});
      if (kind === 'memory') { const [vec] = await client.embed(cfg, ['测试记忆检索']); return { ok: true, message: '向量接口已连通，返回 ' + vec.length + ' 维。' }; }
      const n = 8000, wav = Buffer.alloc(44 + n * 2);
      wav.write('RIFF'); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
      const r = await client.transcribe(cfg, wav);
      return r.error ? r : { ok: true, message: r.text ? '接口已连通；静音出现文字，请再用实际语音确认效果。' : '接口已连通，静音没有识别出文字。' };
    } catch (e) { return { error: errorMessage(e) }; }
  });
  api.ipc.handle('rebuild', async () => {
    if (rebuilding) return { error: '已经在重算，请等待' };
    if (!config.memory.enabled) return { error: '请先保存并启用插件的记忆设置' };
    rebuilding = true; failure = ''; progress = '正在准备…'; send();
    try {
      fs.mkdirSync(api.dataDir, { recursive: true });
      if (fs.existsSync(adapter.memory.file)) {
        const temporary = path.join(api.dataDir, 'memory-before-rebuild.json.tmp');
        fs.copyFileSync(adapter.memory.file, temporary); fs.renameSync(temporary, path.join(api.dataDir, 'memory-before-rebuild.json'));
      }
      const r = await adapter.memory.reembed((d, n) => { progress = `${d} / ${n}`; send(); });
      if (r.error) throw new Error(r.error);
      progress = '已重算 ' + r.count + ' 条记忆和资料。'; return { ok: true, message: progress };
    } catch (e) { failure = errorMessage(e, config.memory); return { error: failure }; }
    finally { rebuilding = false; if (!stopped) send(); }
  });
  api.ipc.handle('open-backup', () => {
    const file = path.join(api.dataDir, 'memory-before-rebuild.json');
    if (!fs.existsSync(file)) return { error: '还没有重算前备份' };
    api.openPath(api.dataDir); return { ok: true };
  });
  api.events.on('settings:changed', () => {
    send();
    // 宿主随后广播原设置；下一轮补回识别可用标志，防止被 hasAsr:false 覆盖。
    api.timers.setTimeout(() => { if (!stopped) availability(); }, 0);
  });
  api.events.on('pet:loaded', availability);
  api.renderer.onMessage(m => { if (m?.type === 'ready') availability(); });
  cleanup = () => { if (stopped) return; stopped = true; client.stop(); adapter.dispose(); panel = null; };
  api.onDispose(cleanup);
  api.log('接口助手已启用；设置保存在插件中。');
};
exports.deactivate = () => { cleanup?.(); cleanup = null; };
