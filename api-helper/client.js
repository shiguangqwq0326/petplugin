'use strict';
const { batchSize, preset } = require('./catalog');
const JUNK = [/^[\s\p{P}\p{S}]*$/u, /^(谢谢观看|谢谢收看|感谢观看|字幕由.*|请不吝点赞.*|ご視聴ありがとうございました)[。！!.]*$/u];
function cleanText(text) {
  return String(text || '').replace(/<\|[^|]*\|>/g, '').replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, '').replace(/\s+/g, ' ').trim();
}
function endpoint(base, kind, cfg) {
  if (/[{}<>]|你的|WorkspaceId/i.test(base)) throw new Error('请把接口地址中的业务空间占位符换成真实 ID');
  let url;
  try { url = new URL(base); } catch (_) { throw new Error('请填写完整的 http 或 https 接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址格式不支持');
  let p = url.pathname.replace(/\/+$/, '');
  if (kind === 'speech' && preset('speech', cfg.provider).protocol === 'aliyun') {
    if (/\/audio\/transcriptions$/i.test(p)) throw new Error('阿里云方式需要填写兼容接口地址');
    if (!/\/chat\/completions$/i.test(p)) {
      if (!p) p = '/compatible-mode/v1';
      else if (/\/compatible-mode$/i.test(p)) p += '/v1';
      p += '/chat/completions';
    }
  } else if (kind === 'speech') {
    if (!/\/audio\/transcriptions$/i.test(p)) p += /\/v1$/i.test(p) ? '/audio/transcriptions' : '/v1/audio/transcriptions';
  } else {
    p = p.replace(/\/(?:embeddings|models)$/i, '');
    if (!p) p = cfg.provider === 'aliyun' ? '/compatible-mode/v1' : cfg.provider === 'zhipu' ? '/api/paas/v4' : '/v1';
    p += kind === 'models' ? '/models' : '/embeddings';
  }
  url.pathname = p;
  return url.toString();
}
function local(base) { try { const h = new URL(base).hostname; return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(h); } catch (_) { return false; } }
function validate(cfg, kind) {
  preset(kind, cfg.provider);
  endpoint(cfg.base, kind, cfg);
  if (!cfg.key && !local(cfg.base)) throw new Error('请先填写该平台的 API 密钥');
  if (!cfg.model) throw new Error('请先选择或填写模型');
  if (kind === 'speech' && cfg.provider === 'aliyun' && !/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(cfg.model)) {
    throw new Error('此方式支持 qwen3-asr-flash 及其日期版本，请重新选择模型');
  }
}
function errorMessage(error, cfg) {
  let value = String(error?.message || error || '接口请求失败');
  if (cfg?.key) value = value.split(cfg.key).join('[密钥]');
  return value.replace(/data:audio\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[音频]').slice(0, 350);
}
class Client {
  constructor(fetcher = globalThis.fetch) { this.fetch = fetcher; this.pending = new Set(); this.stopped = false; }
  abort() { for (const ctrl of this.pending) ctrl.abort(); }
  stop() { this.stopped = true; this.abort(); }
  async request(cfg, url, options = {}, parent, timeout = 30000) {
    if (this.stopped || parent?.aborted) throw new Error('请求已取消');
    const ctrl = new AbortController(), abort = () => ctrl.abort();
    this.pending.add(ctrl);
    const timer = setTimeout(abort, Math.max(100, Math.min(60000, timeout)));
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) abort();
    try {
      const headers = { ...(cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}), ...(options.headers || {}) };
      const r = await this.fetch(url, { ...options, headers, signal: ctrl.signal });
      let data;
      try { data = await r.json(); } catch (e) { if (ctrl.signal.aborted) throw e; throw new Error('接口没有返回有效 JSON，请检查地址'); }
      if (ctrl.signal.aborted || this.stopped) throw new Error('请求已取消');
      if (!r.ok || data?.error) {
        const hint = { 400: '参数或模型不被接受', 401: '密钥不对，请检查平台及地域', 402: '余额不足', 403: '没有权限，请检查模型开通和业务空间', 404: '接口或模型不存在', 429: '请求过于频繁' }[r.status] || '接口请求失败';
        const detail = errorMessage(data?.error?.message || data?.message || '', cfg).slice(0, 160);
        throw new Error(`${r.status || ''} ${hint} ${detail}`.trim());
      }
      return data;
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(parent?.aborted || this.stopped ? '请求已取消' : '请求超时或已取消，请重试');
      throw new Error(errorMessage(e, cfg));
    } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); this.pending.delete(ctrl); }
  }
  async transcribe(cfg, wav, signal) {
    if (signal?.aborted || this.stopped) return { error: 'aborted' };
    try {
      validate(cfg, 'speech');
      const audio = Buffer.from(wav);
      if (!audio.length) throw new Error('录音为空，请重新说一句');
      let body, headers = {}, aliyun = cfg.provider === 'aliyun';
      if (aliyun) {
        const data = 'data:audio/wav;base64,' + audio.toString('base64');
        if (Buffer.byteLength(data) > 10000000) throw new Error('录音编码后超过 10MB，请缩短单句录音');
        body = JSON.stringify({ model: cfg.model, stream: false, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }], asr_options: { enable_itn: false, ...(cfg.language ? { language: cfg.language } : {}) } });
        headers['Content-Type'] = 'application/json';
      } else {
        body = new FormData(); body.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav'); body.append('model', cfg.model);
        if (cfg.language) body.append('language', cfg.language);
      }
      const data = await this.request(cfg, endpoint(cfg.base, 'speech', cfg), { method: 'POST', headers, body }, signal);
      let text;
      if (aliyun) {
        const choice = data?.choices?.[0];
        if (choice?.finish_reason === 'length') throw new Error('识别结果被截断，请缩短录音');
        const content = choice?.message?.content;
        text = typeof content === 'string' ? content : Array.isArray(content) && content.every(p => typeof p?.text === 'string') ? content.map(p => p.text).join('') : null;
      } else text = data?.text;
      if (typeof text !== 'string') throw new Error('接口没有返回识别文字，请检查接口类型和模型');
      text = cleanText(text);
      return JUNK.some(r => r.test(text)) || !text ? { text: '', empty: true } : { text };
    } catch (e) { return { error: signal?.aborted || this.stopped ? 'aborted' : errorMessage(e, cfg) }; }
  }
  async embed(cfg, texts, { signal, timeout = 15000 } = {}) {
    validate(cfg, 'memory');
    const all = [], size = batchSize(cfg); let dimensions = 0;
    for (let i = 0; i < texts.length; i += size) {
      const input = texts.slice(i, i + size).map(t => String(t).slice(0, 2000));
      if (input.some(t => !t.trim())) throw new Error('向量输入不能为空');
      const body = { model: cfg.model, input, ...(cfg.provider === 'zhipu' ? {} : { encoding_format: 'float' }) };
      const data = await this.request(cfg, endpoint(cfg.base, 'memory', cfg), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal, timeout);
      if (!Array.isArray(data?.data) || data.data.length !== input.length) throw new Error('返回的向量数量不对');
      const rows = data.data.slice();
      if (rows.some(r => r?.index !== undefined)) {
        rows.sort((a, b) => a.index - b.index);
        if (!rows.every((r, n) => r.index === n)) throw new Error('返回的向量序号不完整或重复');
      }
      for (const row of rows) {
        const raw = row?.embedding;
        if (!Array.isArray(raw) || !raw.length || !raw.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('向量内容无效');
        if (dimensions && raw.length !== dimensions) throw new Error('返回的向量维度不一致');
        dimensions = raw.length;
        const norm = Math.hypot(...raw);
        if (!Number.isFinite(norm) || norm === 0) throw new Error('返回了无效的零向量');
        all.push(Float32Array.from(raw, v => v / norm));
      }
    }
    return all;
  }
  async models(kind, cfg) {
    const builtin = preset(kind, cfg.provider).models;
    try {
      const data = await this.request(cfg, endpoint(cfg.base, 'models', cfg), { method: 'GET' }, undefined, 15000);
      if (!Array.isArray(data?.data)) throw new Error('接口未返回模型列表');
      const match = kind === 'memory' ? id => /embed|bge|bce/i.test(id) && !/rerank/i.test(id)
        : cfg.provider === 'aliyun' ? id => /^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id)
        : id => /asr|sensevoice|whisper|transcri/i.test(id) && !/realtime|filetrans/i.test(id);
      const ids = data.data.map(r => r?.id).filter(id => typeof id === 'string' && id.length <= 200 && match(id));
      return { models: [...new Set([...builtin, ...ids])], note: ids.length ? '已读取模型列表，请确认账号已开通所选模型。' : '未找到其他候选，已显示内置模型；也可手动填写。' };
    } catch (e) { return { models: [...builtin], note: '未能读取平台列表，已显示内置候选：' + errorMessage(e, cfg) }; }
  }
}
module.exports = { Client, endpoint, validate, local, cleanText, errorMessage };
