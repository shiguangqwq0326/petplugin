'use strict';
// 只更新页面内的“识别可用”标志；不改原设置，也不改语音错误提示。
let originalHasAsr = null;
function apply(message) {
  if (message?.type !== 'availability' || typeof settings !== 'object') return;
  originalHasAsr = !!message.hostHasAsr;
  settings.hasAsr = message.speechReady || originalHasAsr;
}
const off = pet.onMessage(apply);
pet.onUnload(() => { off(); if (typeof settings === 'object' && originalHasAsr !== null) settings.hasAsr = originalHasAsr; });
pet.send({ type: 'ready' });
