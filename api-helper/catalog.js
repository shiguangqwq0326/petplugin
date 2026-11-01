'use strict';
const PRESETS = {
  speech: {
    siliconflow: { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'], protocol: 'file' },
    aliyun: { name: '阿里云', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-asr-flash'], protocol: 'aliyun' },
    compatible: { name: '其他兼容接口', base: 'http://127.0.0.1:8000/v1', models: [], protocol: 'file' },
  },
  memory: {
    siliconflow: { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', models: ['BAAI/bge-m3', 'Pro/BAAI/bge-m3', 'Qwen/Qwen3-Embedding-0.6B', 'Qwen/Qwen3-Embedding-4B', 'Qwen/Qwen3-Embedding-8B'] },
    aliyun: { name: '阿里云', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.7-text-embedding-flash', 'qwen3.7-text-embedding', 'text-embedding-v4'] },
    zhipu: { name: '智谱', base: 'https://open.bigmodel.cn/api/paas/v4', models: ['embedding-3'] },
    compatible: { name: '其他兼容接口 / 本地', base: 'http://127.0.0.1:11434/v1', models: [] },
  },
};
function preset(kind, provider) {
  if (!Object.hasOwn(PRESETS, kind) || !Object.hasOwn(PRESETS[kind], provider)) throw new Error('请选择有效的平台');
  return PRESETS[kind][provider];
}
function defaults(kind) {
  const p = preset(kind, 'siliconflow');
  return { enabled: false, provider: 'siliconflow', base: p.base, model: p.models[0], key: '', language: '' };
}
const cleanKey = (value) => String(value || '').replace(/[\s\u3000\u200B-\u200D\u2060\uFEFF]+/g, '');
function parseConfig(kind, input = {}, previous = defaults(kind), strict = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式不对');
  const provider = input.provider || previous.provider;
  let p;
  try { p = preset(kind, provider); } catch (e) { if (strict) throw e; return defaults(kind); }
  const same = provider === previous.provider;
  const key = cleanKey(input.key) || (input.clearKey ? '' : same ? previous.key : '');
  if (/[^\x21-\x7e]/.test(key)) throw new Error('密钥中含有中文或全角字符，请重新复制');
  const cfg = {
    enabled: input.enabled === undefined ? !!previous.enabled : input.enabled === true,
    provider, base: String(input.base || (same ? previous.base : '') || p.base).trim().replace(/\/+$/, ''),
    model: String(input.model || (same ? previous.model : '') || p.models[0] || '').trim().slice(0, 200),
    key, language: ['', 'zh', 'ja', 'en'].includes(input.language) ? input.language : (previous.language || ''),
  };
  if (cfg.base.length > 2000) throw new Error('接口地址太长');
  return cfg;
}
function batchSize(cfg) {
  if (cfg.provider === 'aliyun') {
    if (/^qwen3\.7-text-embedding/.test(cfg.model)) return 20;
    if (/^text-embedding-v[34]/.test(cfg.model)) return 10;
    return 25;
  }
  return cfg.provider === 'zhipu' ? 64 : 32;
}
module.exports = { PRESETS, preset, defaults, parseConfig, cleanKey, batchSize };
