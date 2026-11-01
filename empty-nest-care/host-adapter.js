'use strict';
const path = require('path');
const { atomicJSON } = require('./storage');
const SOURCE = '渐隐插件（独立额度）';
function createAdapter(instance, notify = () => {}) {
  if (!instance || !instance.state || !Number.isFinite(instance.state.value) || !Array.isArray(instance.state.log) ||
      typeof instance.file !== 'string' || typeof instance.lingering !== 'function') throw new Error('宿主没有可兼容的好感度实例');
  return {
    value: () => instance.state.value,
    debit(p) {
      const s = instance.state;
      const receipts = Array.isArray(s.emptyNestCareReceipts) ? s.emptyNestCareReceipts : [];
      const old = receipts.find(r => r.id === p.id);
      if (old) return old;
      const loss = Math.min(Math.max(0, Math.floor(s.value)), p.requested);
      const receipt = { id: p.id, loss, at: p.at };
      const next = { ...s, value: s.value - loss,
        log: [...s.log, ...(loss ? [{ at: p.at, delta: -loss, value: s.value - loss,
          reason: p.mood === 0 ? '长时间没有主动对话，心情为零' : '长时间没有主动对话', source: SOURCE, pluginEvent: p.id }] : [])].slice(-200),
        emptyNestCareReceipts: [...receipts, receipt].slice(-80) };
      if (p.mood === 0) next.mood = { mood: 'hurt', intensity: 0.8, at: p.at };
      // 不走 apply()，因此不受 affectionEnabled / maxStep / dayCap 限制；数值仍保留 0 下限。
      // 先成功落盘，再替换宿主内存；同一同步主进程中没有“另一份实例”覆盖问题。
      atomicJSON(instance.file, next);
      instance.state = next;
      notify(instance);
      return receipt;
    },
  };
}
function connect(api, electron) {
  if (!api.pet.moods.includes('hurt')) throw new Error('此宿主不支持文档要求的 hurt 心情');
  const root = electron.app.getAppPath();
  const manifest = require(path.join(root, 'package.json'));
  if (manifest.name !== api.host.appId) throw new Error('宿主身份不匹配');
  // 只读取已经加载的主模块，绝不再次执行 main.js。
  const loaded = require.cache[require.resolve(path.join(root, manifest.main || 'main.js'))];
  const getter = loaded && loaded.exports && loaded.exports._test && loaded.exports._test.affection;
  if (typeof getter !== 'function') throw new Error('此宿主没有好感度兼容入口 _test.affection；请使用带插件接口 v1 的四桌宠版本');
  const instance = getter();
  const expected = path.resolve(electron.app.getPath('userData'), 'affection.json');
  if (!instance || path.resolve(instance.file) !== expected) throw new Error('好感数据位置与当前桌宠不一致');
  return createAdapter(instance, a => {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      try { if (!win.isDestroyed()) { win.webContents.send('aff-changed'); win.webContents.send('lingering', a.lingering()); } }
      catch (_) { /* 某个面板恰好关闭不影响已完成的扣分。 */ }
    }
  });
}
module.exports = { connect, createAdapter, SOURCE };
