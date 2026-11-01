'use strict';
// 由插件宿主 new Function('pet', code) 执行；不需要修改 renderer.js / preload.js。
(() => {
  let disposed = false, compatible = false, error = '', state = { phase: 'visible', holdFace: false }, receivedAt = 0;
  let fixedFace = null, selectedCycle = -1, frame = 0, pointerDown = false, lastCursor = null, probing = false;
  const restore = [], handlers = [];
  const stage = document.getElementById('stage');
  const oldOpacity = stage ? stage.style.opacity : '';
  const className = 'empty-nest-care-hidden';
  const css = document.createElement('style');
  css.textContent = `.${className} #bubble,.${className} #chat,.${className} #chatBtn,.${className} #callBtn{visibility:hidden!important;pointer-events:none!important}`;
  pet.mount(css);
  const hint = document.createElement('button');
  hint.textContent = '点击让她出现'; hint.title = '单击原位置唤回，不会再扣一次心情';
  hint.style.cssText = 'position:absolute;display:none;border:1px dashed rgba(127,118,189,.22);border-radius:45%;background:rgba(127,118,189,.065);color:rgba(95,86,143,.42);font:12px Microsoft YaHei,sans-serif;padding:6px;cursor:pointer;';
  pet.mount(hint, { clickable: true });
  const chip = document.createElement('button');
  chip.textContent = '♡'; chip.title = '渐隐工具箱 · 心情与调试';
  chip.style.cssText = 'position:absolute;right:12px;bottom:14px;width:26px;height:26px;border:1px solid #dcd8ea;border-radius:50%;color:#7f76bd;background:rgba(255,255,255,.8);cursor:pointer;opacity:.6';
  chip.onclick = () => pet.send({ type: 'panel' });
  pet.mount(chip, { clickable: true });
  const obscured = () => state.phase === 'fading' || state.phase === 'hidden';
  function bounds() {
    try {
      const b = model.getBounds();
      return b && b.width > 0 && b.height > 0 ? b : null;
    } catch (_) { return null; }
  }
  function contains(x, y) {
    const b = bounds(); if (!b) return false;
    const ellipse = (cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    return ellipse(b.x + b.width * .5, b.y + b.height * .23, b.width * .26, b.height * .23) ||
      ellipse(b.x + b.width * .5, b.y + b.height * .65, b.width * .30, b.height * .36);
  }
  function cursor(x, y) {
    lastCursor = { x, y };
    if (!compatible || !obscured()) { hint.style.display = 'none'; return; }
    const hit = contains(x, y), b = bounds();
    if (hit && b) {
      // 淡色区域必须覆盖实际唤回位置：Windows 的完全透明像素可能不接收原生点击。
      Object.assign(hint.style, { display: 'block', left: `${b.x}px`, top: `${b.y}px`,
        width: `${b.width}px`, height: `${b.height}px` });
    } else hint.style.display = 'none';
    // 复用宿主接口；不注册无法取消的 onCursor 监听。
    setIgnore(!(hit || (window.PetPluginHost && window.PetPluginHost.hit(x, y))));
  }
  function busy() {
    return (typeof chatBusy !== 'undefined' && chatBusy) || (typeof voicePlaying !== 'undefined' && voicePlaying) ||
      (typeof reacting !== 'undefined' && reacting) || (typeof dragging !== 'undefined' && dragging) ||
      (typeof swapping !== 'undefined' && swapping) || !!(window.Call && window.Call.active);
  }
  function applyFace() {
    if (!compatible || !fixedFace || !state.holdFace) return;
    if (typeof wakeIfDozing === 'function') wakeIfDozing(false);
    Promise.resolve(playFace(fixedFace, { strength: 1, fade: .4 })).catch(reportError);
  }
  function reportError(e) {
    if (disposed || error) return;
    error = '页面适配失败：' + String(e && e.message || e); compatible = false;
    state = { phase: 'visible', holdFace: false }; paint();
    pet.send({ type: 'heartbeat', ready: false, busy: false, error });
  }
  function paint() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (disposed) return;
    const t = Math.max(0, Date.now() - receivedAt);
    let opacity = 1;
    if (compatible && !state.error) {
      if (state.phase === 'hidden') opacity = 0;
      else if (state.phase === 'fading') opacity = Math.max(.001, 1 - (state.transition + t) / state.fadeMs);
      else if (state.phase === 'appearing') {
        const from = state.appearFrom || 0;
        opacity = from + (1 - from) * Math.min(1, (state.transition + t) / state.appearMs);
      }
    }
    if (stage) stage.style.opacity = state.phase === 'visible' ? oldOpacity : String(opacity);
    document.documentElement.classList.toggle(className, compatible && obscured());
    chip.style.display = obscured() || !!document.querySelector('#chat.show, #call.show') ? 'none' : '';
    if (!obscured()) hint.style.display = 'none';
    if (compatible && ((state.phase === 'fading' && opacity > .001) || (state.phase === 'appearing' && opacity < 1))) frame = requestAnimationFrame(paint);
  }
  function hook(get, set, make) {
    const original = get(), wrapper = make(original); set(wrapper);
    restore.push(() => { if (get() === wrapper) set(original); });
  }
  function installHooks() {
    hook(() => playFace, f => { playFace = f; }, original => function (name, opts) {
      return original.call(this, state.holdFace && fixedFace ? fixedFace : name,
        state.holdFace && fixedFace ? { ...opts, strength: 1 } : opts);
    });
    hook(() => react, f => { react = f; }, original => {
      const wrapper = function (...args) { return obscured() ? Promise.resolve() : original.apply(this, args); };
      // 宿主 react 的异步取消序号必须在包装前后保持一致。
      Object.defineProperty(wrapper, 'requestSeq', { get: () => original.requestSeq, set: v => { original.requestSeq = v; }, configurable: true });
      return wrapper;
    });
    hook(() => startDoze, f => { startDoze = f; }, original => function (...args) { if (!state.holdFace && !obscured()) return original.apply(this, args); });
    hook(() => hitTest, f => { hitTest = f; }, original => function (x, y) {
      return obscured() ? contains(x, y) || !!(window.PetPluginHost && window.PetPluginHost.hit(x, y)) : original.call(this, x, y);
    });
    hook(() => tryIdleTalk, f => { tryIdleTalk = f; }, original => function (...args) { if (!obscured()) return original.apply(this, args); });
    hook(() => proactive, f => { proactive = f; }, original => function (arg) {
      if (obscured()) { if (window.petAPI && window.petAPI.proactiveDone) window.petAPI.proactiveDone({ id: arg.id, status: 'busy' }); return Promise.resolve(); }
      return original.call(this, arg);
    });
    if (typeof showUserText === 'function') hook(() => showUserText, f => { showUserText = f; }, original => function (text, cls) {
      if (text && !cls) { state.holdFace = false; pet.send({ type: 'call-chat' }); }
      return original.call(this, text, cls);
    });
  }
  async function probe() {
    if (probing || compatible || error || disposed) return;
    if (typeof model === 'undefined' || !model || typeof faceLayer === 'undefined' || !faceLayer) return; // 模型可能还在异步加载。
    probing = true;
    try {
      if (window.idleFadePlugin) throw new Error('检测到旧版补丁式渐隐插件，请先卸载旧版，避免两个渐隐计时器冲突');
      if (!stage || typeof playFace !== 'function' || typeof hitTest !== 'function' || typeof setIgnore !== 'function' ||
          typeof startDoze !== 'function' || typeof proactive !== 'function' || typeof tryIdleTalk !== 'function' || typeof react !== 'function' || typeof getMotion !== 'function') {
        throw new Error('缺少表情、点击或自动对话兼容接口');
      }
      const faces = typeof FACES !== 'undefined' ? FACES : {};
      const groups = {};
      for (const kind of ['sad', 'cry']) {
        const names = Object.keys(faces).filter(k => Array.isArray(faces[k]) && new RegExp('^face_' + kind + '(?:_|$)').test(faces[k][0]));
        // 每套模型只需要一个存在的候选；避免把某人的中文表情名硬编码到另一桌宠。
        const valid = [];
        for (const name of names) { try { if (await getMotion(name)) { valid.push(name); break; } } catch (_) {} }
        if (!valid.length) throw new Error('模型缺少可读取的 face_' + kind + ' 表情');
        groups[kind] = valid;
      }
      if (disposed) return;
      installHooks(); compatible = true;
      pet.onMessage(m => {
        if (!m || disposed) return;
        if (m.type === 'cursor') cursor(m.x, m.y);
        else if (m.type === 'state') {
          const wasHold = state.holdFace;
          state = m; receivedAt = Date.now();
          if (m.error) { state.holdFace = false; state.phase = 'visible'; }
          if (m.holdFace && selectedCycle !== m.cycle) {
            selectedCycle = m.cycle; const pool = groups[m.faceKind];
            fixedFace = pool && pool[0]; applyFace();
          } else if (wasHold && !state.holdFace && typeof idleFace === 'function') idleFace();
          paint(); if (lastCursor && obscured()) cursor(lastCursor.x, lastCursor.y);
        }
      });
    } catch (e) { reportError(e); }
    finally { probing = false; }
  }
  function on(type, fn) { window.addEventListener(type, fn, true); handlers.push([type, fn]); }
  on('mousedown', e => {
    if (e.button !== 0) return;
    pointerDown = false; // 上次在窗口外松开鼠标时，也不能吞掉下一次正常点击。
    if (!compatible || !obscured() || !contains(e.clientX, e.clientY)) return;
    // 其它插件的按钮不应被吞掉。
    const owner = e.target && e.target.closest && e.target.closest('.plugin-ui');
    if (owner && owner !== hint) return;
    pointerDown = true; e.preventDefault(); e.stopImmediatePropagation();
  });
  on('mouseup', e => { if (pointerDown && e.button === 0) { e.preventDefault(); e.stopImmediatePropagation(); } });
  on('click', e => {
    if (e.button !== 0 || !pointerDown) return;
    pointerDown = false; e.preventDefault(); e.stopImmediatePropagation();
    if (obscured() && contains(e.clientX, e.clientY)) pet.send({ type: 'wake' });
  });
  on('blur', () => { pointerDown = false; });
  on('mousemove', e => { if (obscured()) cursor(e.clientX, e.clientY); });
  const timer = setInterval(() => {
    if (disposed) return;
    void probe();
    // 主进程消息中断时恢复可见，不能把人物永久留在透明态。
    if (receivedAt && Date.now() - receivedAt > 4000 && obscured()) { state = { phase: 'visible', holdFace: false }; paint(); }
    pet.send({ type: 'heartbeat', ready: compatible, busy: compatible && !!busy(), error });
    chip.style.display = obscured() || document.querySelector('#chat.show, #call.show') ? 'none' : '';
  }, 1000);
  pet.onUnload(() => {
    disposed = true; clearInterval(timer); if (frame) cancelAnimationFrame(frame);
    for (const [type, fn] of handlers) window.removeEventListener(type, fn, true);
    for (const undo of restore.reverse()) undo();
    if (stage) stage.style.opacity = oldOpacity;
    document.documentElement.classList.remove(className);
    if (compatible && typeof idleFace === 'function') idleFace();
    if (compatible && typeof setIgnore === 'function') setIgnore(true);
  });
  void probe();
})();
