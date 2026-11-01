'use strict';
const DEFAULTS = Object.freeze({ idleMinutes: 30, moodLoss: 20, affectionLoss: 1, zeroAffectionLoss: 3, chatChime: false, warningMinutes: 5 });
const FADE_MS = 15000, APPEAR_MS = 800, DAILY_CAP = 7;
const fields = { idleMinutes: [1, 1440], moodLoss: [1, 100], affectionLoss: [0, 7], zeroAffectionLoss: [0, 7] };
function config(input = {}, strict = false) {
  const out = { ...DEFAULTS };
  for (const [key, [min, max]] of Object.entries(fields)) {
    const n = input[key] === undefined ? out[key] : input[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      if (strict) throw new Error(`${key} 必须是 ${min}～${max} 的整数`);
    } else out[key] = n;
  }
  if (typeof input.chatChime === 'boolean') out.chatChime = input.chatChime;
  if ([5, 10, 15].includes(input.warningMinutes)) out.warningMinutes = input.warningMinutes;
  else if (strict && input.warningMinutes !== undefined) throw new Error('聊天报时只能选择提前 5、10 或 15 分钟');
  if (strict && Object.keys(input).some(k => !(k in DEFAULTS))) throw new Error('包含不允许修改的字段（心情不能手动调整）');
  if (out.chatChime && out.warningMinutes >= out.idleMinutes) {
    if (strict) throw new Error('启用聊天报时时，消失时长必须大于提前提醒时长');
    out.chatChime = false;
  }
  return out;
}
function dayKey(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayBudget(data, now) {
  const date = dayKey(now), old = data.day || { date, spent: 0 };
  // 向后调时钟不能重新领当天额度。
  return date > old.date ? { date, spent: 0 } : { ...old };
}
function freshData() { return { schema: 1, mood: 100, config: { ...DEFAULTS }, day: { date: '', spent: 0 }, history: [], pending: null }; }
class Controller {
  constructor(data, { disappear, warn }, now) {
    this.data = data; this.effects = { disappear, warn }; this.phase = 'visible'; this.elapsed = 0;
    this.transition = 0; this.appearFrom = 0; this.cycle = 0; this.faceKind = null; this.holdFace = false;
    this.warned = false; this.lastTick = now; this.available = false;
  }
  reset(now, releaseFace = false) {
    this.elapsed = 0; this.warned = false; this.lastTick = now;
    if (this.phase !== 'visible') {
      this.appearFrom = this.phase === 'fading' ? Math.max(0, 1 - this.transition / FADE_MS) :
        this.phase === 'appearing' ? this.appearFrom + (1 - this.appearFrom) * Math.min(1, this.transition / APPEAR_MS) : 0;
      this.phase = 'appearing'; this.transition = 0;
    }
    if (releaseFace) this.holdFace = false;
  }
  chat(now) { this.reset(now, true); }
  wake(now) { if (this.phase === 'hidden' || this.phase === 'fading') this.reset(now); }
  force(now) { this.reset(now, true); }
  pause(now) { this.phase = 'visible'; this.elapsed = 0; this.transition = 0; this.warned = false; this.lastTick = now; this.available = false; }
  tick(now, flags) {
    const delta = now - this.lastTick; this.lastTick = now;
    if (!flags.available || delta < 0 || delta > 5000) { this.pause(now); return; }
    if (!this.available) { this.available = true; return; }
    const dt = Math.max(0, delta);
    if (this.phase === 'appearing') {
      this.transition += dt;
      if (this.transition >= APPEAR_MS) this.phase = 'visible';
      return;
    }
    if (this.phase === 'hidden') return;
    if (this.phase === 'fading') {
      // 突然开始通话、拖拽或换衣服时取消本轮，不扣分。
      if (flags.busy) { this.force(now); return; }
      this.transition += dt;
      if (this.transition >= FADE_MS) {
        this.data = this.effects.disappear(this.data, now); // 落盘失败会抛错；不进入隐藏态。
        this.phase = 'hidden';
      }
      return;
    }
    this.elapsed += dt;
    const c = this.data.config, limit = c.idleMinutes * 60000;
    if (flags.busy) return;
    if (this.elapsed >= limit) {
      this.phase = 'fading'; this.transition = 0; this.cycle++;
      this.faceKind = this.data.mood - c.moodLoss <= 0 ? 'cry' : 'sad'; this.holdFace = true;
    } else if (c.chatChime && !this.warned && this.elapsed >= (c.idleMinutes - c.warningMinutes) * 60000) {
      this.warned = true;
      this.effects.warn(`你已经有${c.idleMinutes - c.warningMinutes}分钟没有理我了`);
    }
  }
  snapshot() {
    return { phase: this.phase, elapsed: this.elapsed, transition: this.transition, cycle: this.cycle,
      faceKind: this.faceKind, holdFace: this.holdFace, appearFrom: this.appearFrom, fadeMs: FADE_MS, appearMs: APPEAR_MS };
  }
}
module.exports = { DEFAULTS, FADE_MS, APPEAR_MS, DAILY_CAP, config, dayKey, dayBudget, freshData, Controller };
