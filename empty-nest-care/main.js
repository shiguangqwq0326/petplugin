'use strict';
const { Controller, config, dayBudget, DAILY_CAP } = require('./core');
const { Repository } = require('./storage');
const { connect } = require('./host-adapter');
let cleanup = null;

exports.activate = api => {
  if (api.apiVersion !== 1) throw new Error('需要桌宠插件接口 v1');
  const electron = require('electron');
  const adapter = connect(api, electron), repo = new Repository(api.dataDir);
  let data = repo.finish(repo.load(), adapter);
  repo.save(data);
  let panel = null, failure = '', stopped = false, beat = 0, flags = { ready: false, busy: false };
  const paused = new Set();
  const now = () => Date.now();
  const engine = new Controller(data, {
    disappear: (state, time) => { data = repo.disappear(state, adapter, time); return data; },
    warn: text => api.pet.say(text, { mood: 'sad', action: 'none' }),
  }, now());
  function status() {
    return { ...engine.snapshot(), config: data.config, mood: data.mood, affection: adapter.value(),
      day: dayBudget(data, now()), dailyCap: DAILY_CAP, petName: api.host.petName,
      error: failure, ready: flags.ready, history: data.history.slice(-12).reverse(),
      rule: '本插件的好感扣减不受原好感度开关、单次上限及每日上限约束；独立每日最多扣 7 点，好感最低为 0。' };
  }
  function send() {
    if (stopped) return;
    api.renderer.send({ type: 'state', ...engine.snapshot(), error: failure });
    if (panel && !panel.isDestroyed()) api.windows.post(panel, 'state', status());
  }
  function fail(e) {
    failure = String(e && e.message || e); engine.force(now()); engine.phase = 'visible';
    flags.ready = false; api.warn(failure); send();
  }
  function openPanel() {
    if (panel && !panel.isDestroyed()) { panel.focus(); return; }
    panel = api.windows.open({ file: 'panel.html', width: 480, height: 740, title: '渐隐工具箱', backgroundColor: '#f7f6fb' });
  }
  function saveConfig(input) {
    if (failure) throw new Error('当前插件异常，请先排查日志并重新加载');
    const next = config(input, true);
    data = repo.save({ ...data, config: next }); engine.data = data;
    engine.force(now()); // 改时长不立即追扣；开始新一轮。
    chime.update({ checked: next.chatChime }); send(); return status();
  }
  api.menu.add({ label: '渐隐工具箱（心情 / 调试）…', click: openPanel });
  const chime = api.menu.add({ label: '聊天报时', type: 'checkbox', checked: data.config.chatChime,
    click: ({ checked }) => {
      try { saveConfig({ ...data.config, chatChime: checked }); }
      catch (e) { chime.update({ checked: data.config.chatChime }); api.warn(e.message); openPanel(); }
    } });
  api.menu.add({ label: '找回桌宠（不额外扣分）', click: () => { engine.reset(now()); send(); } });
  api.ipc.handle('state', status);
  api.ipc.handle('save', input => {
    try { return { ok: true, state: saveConfig(input) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  api.ipc.handle('reveal', () => { engine.reset(now()); send(); return { ok: true }; });
  api.events.on('chat:before', e => {
    if (!e.proactive) { engine.chat(now()); send(); }
    else if (engine.phase === 'hidden' || engine.phase === 'fading') { e.cancel = true; e.reply = ''; }
  });
  api.events.on('pet:loaded', () => { beat = 0; flags.ready = false; engine.pause(now()); send(); });
  api.events.on('pet:visibility', () => { engine.pause(now()); send(); });
  api.renderer.onMessage(m => {
    if (!m || typeof m !== 'object' || stopped) return;
    if (m.type === 'heartbeat') {
      beat = now(); flags = { ready: m.ready === true, busy: m.busy === true };
      if (m.error && !failure) fail(new Error(String(m.error).slice(0, 250)));
    } else if (m.type === 'wake') { engine.wake(now()); send(); }
    else if (m.type === 'call-chat') { engine.chat(now()); send(); }
    else if (m.type === 'panel') openPanel();
  });
  const listeners = [];
  for (const [event, key, on] of [['suspend', 'sleep', true], ['resume', 'sleep', false], ['lock-screen', 'lock', true], ['unlock-screen', 'lock', false]]) {
    const fn = () => { on ? paused.add(key) : paused.delete(key); engine.pause(now()); send(); };
    electron.powerMonitor.on(event, fn); listeners.push([event, fn]);
  }
  const timer = api.timers.setInterval(() => {
    if (stopped) return;
    try {
      const time = now(), available = !failure && !paused.size && flags.ready && time - beat < 3500 && api.pet.isVisible();
      engine.tick(time, { available, busy: flags.busy });
      send();
      if (available && (engine.phase === 'hidden' || engine.phase === 'fading')) {
        const b = api.pet.getBounds(), p = electron.screen.getCursorScreenPoint();
        if (b) api.renderer.send({ type: 'cursor', x: p.x - b.x, y: p.y - b.y });
      }
    } catch (e) { fail(e); }
  }, 250);
  cleanup = () => {
    if (stopped) return;
    stopped = true; api.timers.clear(timer);
    for (const [event, fn] of listeners) electron.powerMonitor.removeListener(event, fn);
    panel = null;
  };
  api.onDispose(cleanup);
  api.log('渐隐插件已启用；独立心情持久保存，当前心情 ' + data.mood + '，不会写入原设置。');
};
exports.deactivate = () => { if (cleanup) cleanup(); cleanup = null; };
