'use strict';
const fs = require('fs'), path = require('path');
const { config, freshData, dayBudget, DAILY_CAP } = require('./core');
function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.empty-nest-care.tmp';
  const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
class Repository {
  constructor(dir) { this.file = path.join(dir, 'state.json'); }
  load() {
    let d;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return freshData(); throw new Error('插件心情数据无法读取；为避免重置或重复扣分，已停止启用：' + e.message); }
    if (!d || d.schema !== 1 || !Number.isInteger(d.mood) || d.mood < 0 || d.mood > 100 ||
        !d.day || typeof d.day.date !== 'string' || !Number.isInteger(d.day.spent) || d.day.spent < 0 || d.day.spent > 7 || !Array.isArray(d.history)) {
      throw new Error('插件数据格式异常，请保留 state.json 并查看日志；不会自动回满心情');
    }
    d.config = config(d.config, true);
    if (d.pending && (typeof d.pending.id !== 'string' || !Number.isFinite(d.pending.at) ||
        !Number.isInteger(d.pending.mood) || d.pending.mood < 0 || d.pending.mood > 100 ||
        !Number.isInteger(d.pending.requested) || d.pending.requested < 0 || d.pending.requested > 7 ||
        !d.pending.day || !Number.isInteger(d.pending.day.spent) || d.pending.day.spent < 0 || d.pending.day.spent > 7)) {
      throw new Error('有未完成但格式异常的扣分记录，停止启用');
    }
    return d;
  }
  save(d) { atomicJSON(this.file, d); return d; }
  disappear(data, adapter, now) {
    const mood = Math.max(0, data.mood - data.config.moodLoss), day = dayBudget(data, now);
    const pending = { id: require('crypto').randomUUID(), at: now, mood, day,
      requested: Math.min(DAILY_CAP - day.spent, mood === 0 ? data.config.zeroAffectionLoss : data.config.affectionLoss) };
    const prepared = this.save({ ...data, pending }); // 先写事务，崩溃重启时按同一 id 恢复。
    return this.finish(prepared, adapter);
  }
  finish(data, adapter) {
    if (!data.pending) return data;
    const p = data.pending, receipt = adapter.debit(p);
    const entry = { at: p.at, mood: p.mood, affectionLoss: receipt.loss, id: p.id };
    return this.save({ ...data, mood: p.mood, day: { ...p.day, spent: Math.min(7, p.day.spent + receipt.loss) },
      history: [...data.history, entry].slice(-60), pending: null });
  }
}
module.exports = { Repository, atomicJSON };
