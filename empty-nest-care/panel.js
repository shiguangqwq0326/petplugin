'use strict';
const $ = id => document.getElementById(id);
const numbers = ['idleMinutes', 'moodLoss', 'affectionLoss', 'zeroAffectionLoss'];
let initialized = false, dirty = false, lastConfig = '', lastHistory = '';
function preview() {
  const minutes = Number($('idleMinutes').value) - Number($('warningMinutes').value);
  $('preview').textContent = minutes > 0 ? `提醒台词：你已经有${minutes}分钟没有理我了` : '消失时长必须大于提前提醒时长，才能启用聊天报时。';
}
function form(c) {
  for (const key of numbers) $(key).value = c[key];
  $('chatChime').checked = c.chatChime; $('warningMinutes').value = c.warningMinutes; preview();
}
function render(s) {
  if (!s) return;
  const encoded = JSON.stringify(s.config);
  if (!initialized || (!dirty && encoded !== lastConfig)) { form(s.config); initialized = true; }
  lastConfig = encoded;
  $('petName').textContent = `${s.petName} · 独立心情与渐隐规则`;
  $('mood').value = s.mood; $('moodValue').textContent = `${s.mood} / 100`;
  $('affection').textContent = s.affection; $('spent').textContent = `${s.day.spent} / ${s.dailyCap}`;
  const phases = { visible: '正常显示', fading: '正在渐隐', hidden: '已消失，点击原位置唤回', appearing: '正在出现' };
  const remaining = Math.max(0, Math.ceil((s.config.idleMinutes * 60000 - s.elapsed) / 60000));
  $('phase').textContent = s.ready ? `${phases[s.phase] || s.phase}${s.phase === 'visible' ? ` · 距离渐隐约 ${remaining} 分钟` : ''}` : '等待人物页面准备（暂不计时、不扣分）';
  $('error').textContent = s.error || '';
  $('rule').textContent = s.rule;
  const history = JSON.stringify(s.history);
  if (history !== lastHistory) {
    lastHistory = history; $('history').replaceChildren();
    for (const item of s.history) {
      const li = document.createElement('li'); li.textContent = `${new Date(item.at).toLocaleString()} · 心情 ${item.mood} · 好感 −${item.affectionLoss}`;
      $('history').appendChild(li);
    }
    if (!s.history.length) { const li = document.createElement('li'); li.textContent = '还没有消失记录'; $('history').appendChild(li); }
  }
}
$('form').addEventListener('input', () => { dirty = true; preview(); });
$('form').addEventListener('submit', async e => {
  e.preventDefault(); $('save').disabled = true; $('result').textContent = '';
  const c = Object.fromEntries(numbers.map(k => [k, Number($(k).value)]));
  c.chatChime = $('chatChime').checked; c.warningMinutes = Number($('warningMinutes').value);
  try {
    const result = await window.pluginAPI.invoke('save', c);
    if (!result || !result.ok) throw new Error(result && result.error || '保存失败');
    dirty = false; form(result.state.config); render(result.state); $('result').textContent = '已保存，开始新一轮计时';
  } catch (err) { $('result').textContent = err.message; }
  finally { $('save').disabled = false; }
});
$('reveal').addEventListener('click', async () => {
  try { await window.pluginAPI.invoke('reveal'); } catch (err) { $('error').textContent = err.message; }
});
window.pluginAPI.on('state', render);
window.pluginAPI.invoke('state').then(render).catch(e => { $('error').textContent = e.message; });
