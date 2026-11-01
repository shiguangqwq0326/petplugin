'use strict';

/**
 * 今日天气 · 桌宠插件（接口版本 v1）
 *
 * 工作方式：
 *   1. 第一次问天气时，插件会问「你在哪座城市」，并把城市名换成经纬度存起来；
 *   2. 以后说「今天天气怎么样」时，向 Open-Meteo 查询当天的天气；
 *   3. 用一句话回答：今天天气 + 要不要带伞 + 需要额外注意的事；
 *   4. 查询失败（断网、接口报错、数据不完整）时只回答「我没有办法看到你所在地的天气」。
 *
 * 只使用 Node 自带的 fetch / URL / AbortController，不依赖任何第三方包，也不需要 API 密钥。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const FAIL_TEXT = '我没有办法看到你所在地的天气';
const ASK_CITY = '你所在的城市是哪里？告诉我城市名就好，比如「杭州」。';
const ALSO_ASK_CITY = '先告诉我你在哪座城市吧，比如「杭州」，我才能看天气。';
const CONFIRM_CITY = (label) => `记住了，你在${label}。以后问我「今天天气怎么样」就好。`;
const NOT_FOUND = (name) => `我没找到「${name}」这个地方，能换个说法吗？比如「杭州」或「上海市」。`;

const CACHE_MS = 10 * 60 * 1000; // 同一城市 10 分钟内复用结果，避免反复请求
const REPLY_BUDGET_MS = 1000;    // 聊天回答最多先等这么久（宿主上限 1.5 秒）
const HTTP_TIMEOUT_MS = 6000;    // 单次网络请求超时

const GEOCODE_API = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';

// WMO 天气代码 → 中文描述
const WMO = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '有雾凇',
  51: '有毛毛雨',
  53: '有毛毛雨',
  55: '毛毛雨下个不停',
  56: '有冻毛毛雨',
  57: '冻毛毛雨下个不停',
  61: '有小雨',
  63: '有中雨',
  65: '有大雨',
  66: '有冻雨',
  67: '有较强的冻雨',
  71: '有小雪',
  73: '有中雪',
  75: '有大雪',
  77: '有雪粒',
  80: '有阵雨',
  81: '有较强阵雨',
  82: '有暴雨',
  85: '有阵雪',
  86: '有较强阵雪',
  95: '有雷阵雨',
  96: '有雷阵雨和冰雹',
  99: '有强雷暴和冰雹',
};

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

/* ------------------------------------------------------------------ */
/* 插件内状态                                                          */
/* ------------------------------------------------------------------ */

let api = null;
let disposed = false;
let generation = 0;         // 每次启用 / 停用都加一，用来丢弃上一轮的异步结果
let awaitingCity = false;   // 正在等用户回答城市名
let inflight = null;        // 正在进行的查询（避免连问两次发两次请求）
let cache = { key: '', at: 0, text: '' };
const aborts = new Set();

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeSpace(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function errText(err) {
  return String((err && (err.message || err)) || '未知错误').slice(0, 300);
}

function keyOf(place) {
  return `${Number(place.latitude).toFixed(3)},${Number(place.longitude).toFixed(3)}`;
}

function placeLabel(place) {
  const name = place.name || '你所在的城市';
  const admin1 = String(place.admin1 || '');
  const redundant = !admin1 || admin1 === name || admin1 === `${name}市` || admin1 === `${name}省` || admin1 === `${name}自治区`;
  return redundant ? name : `${name}（${admin1}）`;
}

function readSavedPlace() {
  if (!api) return null;
  const p = api.storage.get('place', null);
  if (!p || typeof p !== 'object') return null;
  const latitude = Number(p.latitude);
  const longitude = Number(p.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    name: String(p.name || '你所在的城市'),
    admin1: String(p.admin1 || ''),
    country: String(p.country || ''),
    latitude,
    longitude,
  };
}

/* ------------------------------------------------------------------ */
/* 文字理解                                                            */
/* ------------------------------------------------------------------ */

/** 把「我在浙江省杭州市西湖区」「杭州市」「杭州」都整理成「杭州」 */
function cleanCity(input) {
  let s = normalizeSpace(input);
  s = s.replace(/^[“”"'‘’《》]+/, '').replace(/[“”"'‘’《》]+$/, '');
  s = s.replace(/[。！？!?，,；;：:]+$/, '');
  // 去掉「我在 / 住在 / 来自 / 位于 / 坐标在」之类的前缀
  s = s.replace(/^(?:请问|那个|就是|我|俺|咱|我们)?(?:现在|目前|平时|一直)?(?:住在|家在|来自|位于|坐标在|坐标|在)\s*/, '');
  s = s.replace(/^(?:的)?(?:城市|地方)(?:是|在|叫)?\s*/, '');
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  // 中文地名里的空格直接去掉；英文地名保留单词之间的空格
  s = /[\u3400-\u9fff]/.test(s) ? s.replace(/\s+/g, '') : s.replace(/\s+/g, ' ').trim();
  // 去掉省 / 自治区前缀，再截到「市 / 地区」为止
  s = s.replace(/^.{2,8}?(?:省|自治区)/, '');
  s = s.replace(/^(.{2,}?)(?:市|地区).*$/, '$1');
  s = s.replace(/人$/, '');
  if (s.length > 30) s = s.slice(0, 30);
  return s;
}

/** 这句话是不是在问今天的天气（只认今天，明天 / 后天交给模型自己答） */
function isWeatherAsk(text) {
  const t = normalizeSpace(text).replace(/\s/g, '');
  if (!t || t.startsWith('/')) return false;
  if (/(明天|后天|大后天|下周|周末|未来)/.test(t) && !/(今天|今日|现在|目前|外面)/.test(t)) return false;
  if (!/(天气|气温|下雨|下雪|带伞|冷不冷|热不热|晒不晒|潮不潮|几度|多少度)/.test(t)) return false;
  if (/[？?]|怎么样|如何|咋样|好吗|好不好|冷不冷|热不热|晒不晒|潮不潮|要不要|用不用|需不需要|需要带|吗|呢|下不下|会不会|多少|几度/.test(t)) return true;
  // 「今天天气」「天气如何」这类很短的问法
  return /^(今天|今日|现在|目前|外面|这边|当地)?(的)?(天气|气温)(怎么样|如何|咋样|好吗|好不好)?[？?]?$/.test(t);
}

/* ------------------------------------------------------------------ */
/* 网络请求                                                            */
/* ------------------------------------------------------------------ */

async function getJson(url) {
  const controller = new AbortController();
  aborts.add(controller);
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`天气接口返回 HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    aborts.delete(controller);
  }
}

/** 城市名 → { name, admin1, country, latitude, longitude }；找不到返回 null */
async function geocodeOnce(name) {
  const url = new URL(GEOCODE_API);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '8');
  // 中文地名用中文结果；英文地名改用英文结果，否则会优先匹配到同名的偏远小镇
  url.searchParams.set('language', /[\u3400-\u9fff]/.test(name) ? 'zh' : 'en');
  url.searchParams.set('format', 'json');

  const data = await getJson(url.toString());
  return Array.isArray(data && data.results) ? data.results : [];
}

// GeoNames 地名类型：行政中心优先于普通村镇
const FEATURE_RANK = { PPLC: 6, PPLA: 5, PPLA2: 4, PPLG: 4, PPLA3: 3, PPLA4: 2, PPL: 1 };

/** 「厦门市」→「厦门」，用于回答里更自然的称呼（「芒市」这类两字地名保持不变） */
function displayCityName(name) {
  return /^[\u3400-\u9fff]{2,}市$/.test(name) ? name.slice(0, -1) : name;
}

async function resolveCity(name) {
  // Open-Meteo 的中文索引并不统一：有的城市收录为「杭州」，有的只收录「厦门市」。
  // 两种写法都查一次，再按「行政中心 > 人口」挑最像城市的那条，避免匹配到同名村镇。
  const queries = [name];
  if (/[\u3400-\u9fff]/.test(name) && !/(市|地区|自治州|盟|县)$/.test(name)) queries.push(`${name}市`);

  const settled = await Promise.allSettled(queries.map((q) => geocodeOnce(q)));
  let succeeded = 0;
  let lastError = null;
  const pool = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      succeeded += 1;
      pool.push(...item.value);
    } else {
      lastError = item.reason;
    }
  }
  if (!succeeded && lastError) throw lastError;
  if (!pool.length) return null;

  const seen = new Set();
  const unique = [];
  for (const raw of pool) {
    if (!raw) continue;
    const latitude = Number(raw.latitude);
    const longitude = Number(raw.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ raw, latitude, longitude });
  }
  if (!unique.length) return null;

  unique.sort((a, b) => {
    // 先看人口（真正的大城市通常人口远大于同名村镇），人口相同再看行政级别
    const popDiff = (Number(b.raw.population) || 0) - (Number(a.raw.population) || 0);
    if (popDiff !== 0) return popDiff;
    const rankA = FEATURE_RANK[a.raw.feature_code] || 0;
    const rankB = FEATURE_RANK[b.raw.feature_code] || 0;
    return rankB - rankA;
  });

  const best = unique[0];
  return {
    name: displayCityName(String(best.raw.name || name)),
    admin1: String(best.raw.admin1 || ''),
    country: String(best.raw.country || ''),
    latitude: best.latitude,
    longitude: best.longitude,
  };
}

function forecastUrl(place) {
  const url = new URL(FORECAST_API);
  const q = url.searchParams;
  q.set('latitude', String(place.latitude));
  q.set('longitude', String(place.longitude));
  q.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max,wind_speed_10m_max');
  q.set('timezone', 'auto');
  q.set('forecast_days', '1');
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* 一句话天气                                                          */
/* ------------------------------------------------------------------ */

function pickNumber(list, index) {
  if (!Array.isArray(list)) return NaN;
  const raw = list[index];
  if (raw === null || raw === undefined || raw === '') return NaN;
  return typeof raw === 'number' ? raw : Number(raw);
}

function weatherText(code) {
  return WMO[code] || '天气变化';
}

function umbrellaText({ code, probability, rain }) {
  const wet = RAIN_CODES.has(code) || SNOW_CODES.has(code);
  if (wet || probability >= 50 || rain >= 1) return '记得带伞';
  if (probability >= 30) return '最好带把伞';
  return '不用带伞';
}

function cautionText({ code, tmax, tmin, uv, wind, rain }) {
  if (code === 95 || code === 96 || code === 99) return '有雷雨，尽量别在户外久留';
  if (code === 66 || code === 67 || code === 56 || code === 57) return '有冻雨，路面会很滑';
  if (SNOW_CODES.has(code)) return '路面可能打滑，走路小心';
  if (rain >= 10) return '雨势不小，尽量避开积水路段';
  if (code === 45 || code === 48) return '能见度低，出门慢一点';
  if (uv >= 8) return '紫外线很强，记得防晒';
  if (uv >= 6) return '紫外线偏强，防晒别忘';
  if (tmax >= 35) return '天气炎热，注意补水防暑';
  if (tmin <= 0) return '气温很低，注意保暖';
  if (wind >= 39) return '风有点大，注意防风';
  if (tmax - tmin >= 12) return '早晚温差大，记得添衣';
  return '没什么要特别注意的';
}

/** 把 Open-Meteo 的 daily 数据拼成一句话 */
function buildSentence(place, data) {
  const daily = data && data.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) throw new Error('天气数据不完整');

  const code = pickNumber(daily.weather_code, 0);
  const tmax = pickNumber(daily.temperature_2m_max, 0);
  const tmin = pickNumber(daily.temperature_2m_min, 0);
  if (!Number.isFinite(code) || !Number.isFinite(tmax) || !Number.isFinite(tmin)) throw new Error('天气数据不完整');

  let probability = pickNumber(daily.precipitation_probability_max, 0);
  if (!Number.isFinite(probability)) probability = 0;
  probability = Math.max(0, Math.min(100, probability));

  let rain = pickNumber(daily.precipitation_sum, 0);
  if (!Number.isFinite(rain)) rain = 0;

  const uv = pickNumber(daily.uv_index_max, 0);
  const wind = pickNumber(daily.wind_speed_10m_max, 0);
  const desc = weatherText(code);
  const umbrella = umbrellaText({ code, probability, rain });
  const caution = cautionText({ code, tmax, tmin, uv, wind, rain });

  const low = Math.round(tmin);
  const high = Math.round(tmax);
  const range = low === high ? `${high}℃` : `${low}~${high}℃`;
  const name = place.name || '你所在的城市';

  return `${name}今天${desc}，${range}，${umbrella}；${caution}。`;
}

function cacheGet(key) {
  if (cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.text;
  return '';
}

/** 查询并生成一句话；任何失败都返回固定的失败台词 */
async function queryWeather(place) {
  const key = keyOf(place);
  const hit = cacheGet(key);
  if (hit) return hit;
  const gen = generation;
  try {
    const data = await getJson(forecastUrl(place));
    const text = buildSentence(place, data);
    if (gen === generation) cache = { key, at: Date.now(), text };
    return text;
  } catch (err) {
    if (api) api.warn('天气查询失败：' + errText(err));
    return FAIL_TEXT;
  }
}

/* ------------------------------------------------------------------ */
/* 聊天流程                                                            */
/* ------------------------------------------------------------------ */

/** 快速路径：1 秒内查到就当场回答；否则先应一声，查到后再补一句 */
async function answerWith(e, place) {
  const hit = cacheGet(keyOf(place));
  if (hit) {
    e.reply = hit;
    e.mood = 'calm';
    return;
  }
  if (inflight) {
    e.reply = '还在看呢，马上就好。';
    e.mood = 'calm';
    return;
  }

  const pending = queryWeather(place);
  inflight = pending;
  const done = await Promise.race([pending, sleep(REPLY_BUDGET_MS).then(() => null)]);

  if (done) {
    e.reply = done;
    e.mood = 'calm';
    inflight = null;
    return;
  }

  e.reply = '我看看今天的天气……';
  e.mood = 'calm';
  const gen = generation;
  pending
    .then((text) => { if (gen === generation && !disposed && api) api.pet.say(text, { mood: 'calm' }); })
    .catch(() => { if (gen === generation && !disposed && api) api.pet.say(FAIL_TEXT, { mood: 'calm' }); })
    .finally(() => { if (gen === generation) inflight = null; });
}

async function answerStored(e) {
  const place = readSavedPlace();
  if (!place) {
    awaitingCity = true;
    e.reply = ASK_CITY;
    e.mood = 'calm';
    return;
  }
  await answerWith(e, place);
}

/** 「/天气 杭州」这种一次性查询：先应一声，再慢慢查 */
function answerNamed(e, rawName) {
  const name = cleanCity(rawName);
  if (!name) {
    awaitingCity = true;
    e.reply = ASK_CITY;
    return;
  }
  if (inflight) {
    e.reply = '还在看呢，马上就好。';
    return;
  }
  e.reply = `我看看${name}的天气……`;
  e.mood = 'calm';

  const pending = (async () => {
    const place = await resolveCity(name);
    if (!place) return NOT_FOUND(name);
    return queryWeather(place);
  })();
  inflight = pending;
  const gen = generation;
  pending
    .then((text) => { if (gen === generation && !disposed && api) api.pet.say(text, { mood: 'calm' }); })
    .catch((err) => {
      if (gen !== generation || disposed || !api) return;
      api.warn('查询城市失败：' + errText(err));
      api.pet.say(FAIL_TEXT, { mood: 'calm' });
    })
    .finally(() => { if (gen === generation) inflight = null; });
}

/** 保存城市（或告诉用户没找到）。e 为空时用气泡说，否则写进 e.reply */
function finishCity(place, name, viaSay, e) {
  if (disposed) return;
  if (!place) {
    awaitingCity = true;
    const text = NOT_FOUND(name);
    if (viaSay) {
      if (!disposed && api) api.pet.say(text, { mood: 'calm' });
    } else {
      e.reply = text;
      e.mood = 'calm';
    }
    return;
  }

  if (api) api.storage.set('place', place);
  awaitingCity = false;
  const text = CONFIRM_CITY(placeLabel(place));
  if (viaSay) {
    if (!disposed && api) api.pet.say(text, { mood: 'calm' });
  } else {
    e.reply = text;
    e.mood = 'calm';
  }
}

/** 设置城市：1 秒内查到就当场确认，否则先应一声 */
async function setCity(e, rawName) {
  const name = cleanCity(rawName);
  if (!name) {
    awaitingCity = true;
    e.reply = ASK_CITY;
    e.mood = 'calm';
    return;
  }

  const pending = resolveCity(name);
  const gen = generation;
  const result = await Promise.race([
    pending.then((place) => ({ place })).catch((err) => ({ err })),
    sleep(REPLY_BUDGET_MS).then(() => null),
  ]);
  if (gen !== generation) return;

  if (!result) {
    e.reply = '我查一下这个地方……';
    e.mood = 'calm';
    pending
      .then((place) => { if (gen === generation) finishCity(place, name, true); })
      .catch((err) => {
        if (gen !== generation || disposed || !api) return;
        api.warn('查询城市失败：' + errText(err));
        awaitingCity = false;
        api.pet.say(FAIL_TEXT, { mood: 'calm' });
      });
    return;
  }

  if (result.err) {
    if (api) api.warn('查询城市失败：' + errText(result.err));
    awaitingCity = false;
    e.reply = FAIL_TEXT;
    e.mood = 'calm';
    return;
  }

  finishCity(result.place, name, false, e);
}

async function onChatBefore(e) {
  if (!e || e.proactive || e.image) return;
  const text = normalizeSpace(e.text);
  if (!text) return;

  // /城市 杭州、/设置城市、/所在地
  const cityCommand = text.match(/^\/(?:城市|设置城市|所在地)(?:\s+(.+))?$/);
  if (cityCommand) {
    e.cancel = true;
    await setCity(e, cityCommand[1] || '');
    return;
  }

  // /天气、/天气 杭州
  const weatherCommand = text.match(/^\/天气(?:\s+(.+))?$/);
  if (weatherCommand) {
    e.cancel = true;
    if (weatherCommand[1]) answerNamed(e, weatherCommand[1]);
    else await answerStored(e);
    return;
  }

  // 正在等城市名：下一条消息就当作城市
  if (awaitingCity) {
    if (isWeatherAsk(text)) {
      e.cancel = true;
      e.reply = ALSO_ASK_CITY;
      e.mood = 'calm';
      return;
    }
    if (/^(算了|不用了|取消|没事|不看了)/.test(text)) {
      awaitingCity = false;
      e.cancel = true;
      e.reply = '好，等你想看天气的时候再告诉我城市。';
      e.mood = 'calm';
      return;
    }
    e.cancel = true;
    await setCity(e, text);
    return;
  }

  // 日常询问
  if (isWeatherAsk(text)) {
    e.cancel = true;
    await answerStored(e);
  }
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

function menuNow() {
  if (!api) return;
  const place = readSavedPlace();
  if (!place) {
    awaitingCity = true;
    api.pet.openChat();
    api.pet.say(ASK_CITY, { mood: 'calm' });
    return;
  }
  const hit = cacheGet(keyOf(place));
  if (hit) {
    api.pet.say(hit, { mood: 'calm' });
    return;
  }
  api.pet.say('我看看今天的天气……', { mood: 'calm' });
  const gen = generation;
  queryWeather(place).then((text) => {
    if (gen === generation && !disposed && api) api.pet.say(text, { mood: 'calm' });
  });
}

function menuSetCity() {
  if (!api) return;
  awaitingCity = true;
  api.pet.openChat();
  api.pet.say('在聊天框里告诉我你在哪座城市吧，比如「杭州」。', { mood: 'calm' });
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

function activate(a) {
  api = a;
  disposed = false;
  generation += 1;
  awaitingCity = false;
  inflight = null;
  cache = { key: '', at: 0, text: '' };
  aborts.clear();

  api.events.on('chat:before', onChatBefore);

  api.menu.add({ label: '现在天气怎么样', click: () => menuNow() });
  api.menu.add({ label: '设置所在城市…', click: () => menuSetCity() });
  api.menu.add({
    label: '查看当前城市',
    click: () => {
      if (!api) return;
      const place = readSavedPlace();
      api.pet.say(place ? `你现在设的是${placeLabel(place)}。` : '还没设置城市呢。', { mood: 'calm' });
    },
  });
  api.menu.add({
    label: '清除城市设置',
    click: () => {
      if (!api) return;
      api.storage.delete('place');
      awaitingCity = false;
      api.pet.say('好，忘记你住在哪里了。下次看天气时再告诉我。', { mood: 'calm' });
    },
  });

  api.onDispose(() => {
    disposed = true;
    for (const controller of aborts) {
      try { controller.abort(); } catch (_) { /* 忽略 */ }
    }
    aborts.clear();
    inflight = null;
  });

  api.log('今日天气已启用；天气数据来自 Open-Meteo');
}

function deactivate() {
  disposed = true;
  generation += 1;
  for (const controller of aborts) {
    try { controller.abort(); } catch (_) { /* 忽略 */ }
  }
  aborts.clear();
  inflight = null;
  awaitingCity = false;
}

exports.activate = activate;
exports.deactivate = deactivate;

// 供本地测试使用；桌宠插件宿主不会用到这些导出
exports._test = {
  FAIL_TEXT,
  ASK_CITY,
  cleanCity,
  isWeatherAsk,
  buildSentence,
  weatherText,
  umbrellaText,
  cautionText,
  resolveCity,
  queryWeather,
  keyOf,
  placeLabel,
  WMO,
};
