'use strict';
const $ = id => document.getElementById(id);
const api = window.pluginAPI;
let state, choosing = null, models = [], busy = false, modelRequest = 0;
function closeChooser() { choosing = null; modelRequest++; $('chooser').hidden = true; $('modelRead').disabled = false; }
const cleared = { speech: false, memory: false };
const text = (id, value, error = false) => { $(id).textContent = value || ''; $(id).classList.toggle('error', error); };
function draft(kind) {
  return { enabled: $(kind+'Enabled').checked, provider: $(kind+'Provider').value, base: $(kind+'Base').value.trim(), model: $(kind+'Model').value.trim(), key: $(kind+'Key').value, clearKey: cleared[kind], language: kind === 'speech' ? $('speechLanguage').value : '' };
}
function updateInfo(s) {
  state = s;
  text('memoryInfo', `${s.memoryCount} 条记忆和资料，${s.stale} 条需要重算。${s.hostMemoryOn ? '' : '桌宠的长期记忆目前关闭。'}${s.progress ? ' '+s.progress : ''}${s.error ? ' '+s.error : ''}`, !!s.error);
  $('rebuild').disabled = s.rebuilding || !s.memory.enabled;
  $('backup').disabled = !s.backup;
}
function fill(s) {
  updateInfo(s);
  for (const kind of ['speech','memory']) {
    const cfg = s[kind], select = $(kind+'Provider'); select.textContent = '';
    for (const [id, p] of Object.entries(s.presets[kind])) { const o = document.createElement('option'); o.value = id; o.textContent = p.name; select.appendChild(o); }
    select.value = cfg.provider; $(kind+'Enabled').checked = cfg.enabled;
    $(kind+'Base').value = cfg.base; $(kind+'Model').value = cfg.model;
    $(kind+'Key').value = ''; $(kind+'Key').placeholder = cfg.hasKey ? '已保存，留空不变' : '填写该平台密钥（本地服务可留空）';
    cleared[kind] = false;
  }
  $('speechLanguage').value = s.speech.language || '';
}
function filterModels() {
  const query = $('modelSearch').value.trim().toLowerCase(), list = $('modelOptions'); list.textContent = '';
  for (const id of models.filter(m => m.toLowerCase().includes(query))) { const option = document.createElement('option'); option.value = id; option.textContent = id; list.appendChild(option); }
  if (list.options.length) list.selectedIndex = 0;
}
for (const kind of ['speech','memory']) {
  $(kind+'Provider').onchange = () => {
    const p = state.presets[kind][$(kind+'Provider').value];
    $(kind+'Base').value = p.base; $(kind+'Model').value = p.models[0] || '';
    $(kind+'Key').value = ''; $(kind+'Key').placeholder = '填写新平台密钥'; cleared[kind] = true;
    closeChooser();
  };
  $(kind+'Show').onclick = () => { const input = $(kind+'Key'); input.type = input.type === 'password' ? 'text' : 'password'; $(kind+'Show').textContent = input.type === 'password' ? '显示' : '隐藏'; };
  $(kind+'Clear').onclick = () => { $(kind+'Key').value = ''; $(kind+'Key').placeholder = '保存后清除该密钥'; cleared[kind] = true; };
  $(kind+'Choose').onclick = () => {
    closeChooser(); choosing = kind; models = [...state.presets[kind][$(kind+'Provider').value].models];
    const current = $(kind+'Model').value.trim(); if (current && !models.includes(current)) models.unshift(current);
    $('chooserTitle').textContent = kind === 'memory' ? '选择记忆模型' : '选择识别模型';
    $('modelSearch').value = ''; filterModels(); $('chooser').hidden = false;
    text('modelNote', '先显示内置候选；需要时可读取平台模型列表，也可以直接在模型输入框中填写。');
    $('chooser').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  $(kind+'Test').onclick = async () => {
    const button = $(kind+'Test'); button.disabled = true; text(kind+'Status', '测试中…');
    try { const r = await api.invoke('test', { kind, config: draft(kind) }); text(kind+'Status', r.error || r.message, !!r.error); }
    catch (e) { text(kind+'Status', '测试失败：'+e.message, true); }
    finally { button.disabled = false; }
  };
}
$('modelSearch').oninput = filterModels;
$('modelRead').onclick = async () => {
  const kind = choosing; if (!kind) return;
  const request = ++modelRequest;
  $('modelRead').disabled = true; text('modelNote', '读取中…');
  try {
    const r = await api.invoke('models', { kind, config: draft(kind) });
    if (choosing !== kind || request !== modelRequest) return;
    if (r.error) return text('modelNote', r.error, true);
    models = r.models; filterModels(); text('modelNote', r.note);
  } catch (e) { if (request === modelRequest) text('modelNote', e.message, true); }
  finally { if (request === modelRequest) $('modelRead').disabled = false; }
};
$('modelUse').onclick = () => { if (choosing && $('modelOptions').value) $(choosing+'Model').value = $('modelOptions').value; closeChooser(); };
$('modelClose').onclick = closeChooser;
$('save').onclick = async () => {
  if (busy) return; busy = true; $('save').disabled = true;
  try {
    const r = await api.invoke('save', { speech: draft('speech'), memory: draft('memory') });
    if (r.error) return text('status', r.error, true);
    fill(r.state); text('status', '已保存并应用。更换记忆模型后，请重算记忆。');
  } catch (e) { text('status', e.message, true); }
  finally { busy = false; $('save').disabled = false; }
};
$('rebuild').onclick = async () => {
  $('rebuild').disabled = true; text('status', '正在重算记忆，请保持当前接口设置…');
  try { const r = await api.invoke('rebuild'); text('status', r.error || r.message, !!r.error); }
  catch (e) { text('status', e.message, true); }
  finally { try { updateInfo(await api.invoke('state')); } catch (_) {} }
};
$('backup').onclick = async () => { try { const r = await api.invoke('open-backup'); if (r.error) text('status', r.error, true); } catch (e) { text('status', e.message, true); } };
api.on('state', updateInfo);
api.invoke('state').then(s => { fill(s); text('status', '设置只在启用相应选项后接管。'); }).catch(e => text('status', '读取设置失败：'+e.message, true));
