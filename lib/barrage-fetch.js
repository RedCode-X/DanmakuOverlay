/* barrage-fetch.js — 主进程：腾讯视频弹幕在线采集模块
 *
 * 移植自 scripts/collect_danmaku.js 的核心逻辑（纯 Node https，不依赖 playwright）：
 *   - 弹幕接口：https://dm.video.qq.com/barrage/segment/{vid}/t/v1/{start_ms}/{end_ms}
 *   - 从 0 起每 2 分钟一段线性扫描，连续空段自动停止，请求间隔 60ms，失败重试
 *   - 支持中途取消；完成后自动转换为播放器精简格式并落盘 userData/collected/
 *
 * 用法（main.js IPC handler 调用）：
 *   const { startCollect, cancelCollect, listCollected, extractVidFromUrl } =
 *     require('./lib/barrage-fetch');
 *   startCollect({ vid, title, dataDir, onProgress });
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const SEG_MS = 120000;        // 每段 2 分钟
const EMPTY_STOP = 5;         // 连续 5 段空（10 分钟无弹幕）视为结束
const MAX_SEG = 200;          // 上限 400 分钟
const DELAY_MS = 60;          // 请求间隔，避免对平台造成压力
const RETRIES = 4;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://v.qq.com/',
  'Accept': 'application/json, text/plain, */*'
};

let _cancelRequested = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 请求一段弹幕（带重试）；成功返回数组；始终失败返回 null（跳过不中断） */
async function fetchSegment(vid, startMs) {
  const url = `https://dm.video.qq.com/barrage/segment/${vid}/t/v1/${startMs}/${startMs + SEG_MS}`;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    if (_cancelRequested) return null;
    try {
      const data = await getJson(url);
      return data.barrage_list || [];
    } catch (e) {
      if (attempt === RETRIES) return null;
      await sleep(400 * attempt);
    }
  }
  return null;
}

/** 腾讯原始弹幕 → 播放器精简格式 */
function normalizeBarrage(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || !d.content) continue;
    const item = { time: Math.round(Number(d.time_offset) || 0) / 1000, type: 'scroll', text: String(d.content).trim() };
    if (!item.text) continue;
    if (typeof d.content_style === 'string') {
      const m = d.content_style.match(/([0-9a-fA-F]{6})/);
      if (m) item.color = `#${m[1]}`;
    }
    out.push(item);
  }
  return out;
}

// ---------------- vid / 链接解析 ----------------

// 腾讯 vid 形态：1 个字母 + 10 位左右数字/字母（如 b4101hnrvpz、o4101m0n4y0）
const RE_VID = /^[a-zA-Z][a-zA-Z0-9]{7,12}$/;
// 腾讯专辑 cid 形态：明显更长（如 mzc002005od4txd）
const RE_CID = /^[a-zA-Z][a-zA-Z0-9]{13,20}$/;

const looksLikeVid = (s) => RE_VID.test(String(s || ''));

/**
 * 从用户输入中识别腾讯 vid。兼容：
 *   - 裸 vid：b4101hnrvpz
 *   - 播放页：v.qq.com/x/cover/<cid>/<vid>.html、v.qq.com/x/page/<vid>.html
 *   - 带参数：?vid= / &tvid= / video_id= / #vid=
 *   - 移动端：m.v.qq.com/x/m/play?cid=...&vid=...
 *   - 复制的整段分享文案（其中含腾讯链接即可）
 * 返回 null 表示未能识别（例如只给了专辑 cid，未指向具体某集）。
 */
function extractVidFromUrl(rawUrl) {
  if (!rawUrl) return null;
  const input = String(rawUrl).trim();
  if (!input) return null;

  // 0) 直接粘贴裸 vid / 裸 cid
  if (/^[a-zA-Z0-9]{6,20}$/.test(input)) return looksLikeVid(input) ? input : null;

  let url = input;
  if (/^[\w.+-]+:\/\//i.test(url)) {
    try { url = new URL(url).href; } catch (_) { /* 保留原串继续匹配 */ }
  }

  const candidates = [];
  // 1) query / hash 参数
  const m1 = url.match(/[?&#](?:vid|tvid|video_id|videoId)=([a-zA-Z0-9]{6,20})/i);
  if (m1) candidates.push(m1[1]);
  // 2) /<vid>.html —— 覆盖 /x/cover/<cid>/<vid>.html 与 /x/page/<vid>.html
  //    结尾放宽到空白/引号，兼容"整段分享文案"粘贴
  const m2 = url.match(/\/([a-zA-Z][a-zA-Z0-9]{5,19})\.html(?:[?#\s"'<>]|$)/);
  if (m2) candidates.push(m2[1]);
  // 3) 路径独立段（无扩展名）
  const m3 = url.match(/\/([a-zA-Z][a-zA-Z0-9]{7,19})(?:[?#/\s"'<>]|$)/);
  if (m3) candidates.push(m3[1]);
  // 4) 任意文本里的 vid 字段（整段分享文案场景）
  const m4 = url.match(/["'\s](?:vid|tvid|video_id)["'\s:=]+([a-zA-Z0-9]{6,20})/i);
  if (m4) candidates.push(m4[1]);

  return candidates.find((c) => looksLikeVid(c)) || null;
}

/** 从输入中提取腾讯专辑 cid（仅用于给出更准确的失败提示） */
function extractCidFromUrl(rawUrl) {
  if (!rawUrl) return null;
  const input = String(rawUrl).trim();
  if (/^[a-zA-Z0-9]{6,20}$/.test(input)) return RE_CID.test(input) ? input : null;
  const m = input.match(/\/([a-zA-Z][a-zA-Z0-9]{13,20})(?:\.html|[?#/]|$)/);
  return m ? m[1] : null;
}

/** 从页面 HTML 文本中精确提取 vid（只认腾讯链接参数 / JSON 字段 / 腾讯播放页路径） */
function extractVidFromHtml(html) {
  const s = String(html || '');
  const patterns = [
    /[?&#](?:vid|tvid|video_id)=([a-zA-Z0-9]{6,20})/i,
    /["'](?:vid|tvid|video_id)["']\s*[:=]\s*["']([a-zA-Z0-9]{6,20})["']/i,
    /v\.qq\.com\/[^\s"'<>]*?\/([a-zA-Z][a-zA-Z0-9]{7,12})\.html/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && looksLikeVid(m[1])) return m[1];
  }
  return null;
}

/** 简易 GET 文本（跟随有限次重定向；超时/失败返回 null，不抛错） */
function fetchText(url, redirects = 3) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let target;
    try { target = new URL(url); } catch (_) { return finish(null); }
    if (!/^https?:$/.test(target.protocol)) return finish(null);
    const mod = target.protocol === 'https:' ? https : require('http');
    const req = mod.get(target.href, {
      headers: { ...HEADERS, Referer: `${target.origin}/` },
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, target.href).href; } catch (_) { return finish(null); }
        fetchText(next, redirects - 1).then(finish);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return finish(null); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        // 防止超大页面拖垮内存（弹幕相关线索都在首屏 HTML 内）
        if (data.length > 2 * 1024 * 1024) { req.destroy(); finish(data); }
      });
      res.on('end', () => finish(data));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(null));
  });
}

/** 从 HTML 取 <title> 作为标题候选 */
function pickPageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]{1,160}?)<\/title>/i);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * 解析用户粘贴的目标（vid 或链接）→ vid。
 *  1) 本地规则直接解析（腾讯链接、裸 vid）
 *  2) 兜底：抓取页面 HTML，跟随一层 iframe / v.qq.com 链接继续找 vid，并回传页面标题
 * @returns {Promise<{vid:(string|null), title?:string, source?:string, error?:string}>}
 */
async function resolveVid(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) return { vid: null, error: '未填写 vid 或链接' };

  const direct = extractVidFromUrl(input);
  if (direct) return { vid: direct, source: 'input' };

  if (!/^https?:\/\//i.test(input)) {
    const cid = extractCidFromUrl(input);
    return {
      vid: null,
      error: cid
        ? `识别到专辑号 ${cid}，但未定位到具体某一集，请在腾讯视频打开该集后复制其链接`
        : '既不是 vid，也不是可访问的链接'
    };
  }

  // 腾讯自家页面不做 HTML 抓取：专辑页由 JS 渲染，页面里抓到的 vid 多为推荐位，会导致误采
  let host = '';
  try { host = new URL(input).hostname.toLowerCase(); } catch (_) { /* ignore */ }
  if (/(^|\.)(v|m|film|vv)\.qq\.com$/.test(host)) {
    const cid = extractCidFromUrl(input);
    return {
      vid: null,
      error: cid
        ? `识别到专辑号 ${cid}，但未定位到具体某一集，请在腾讯视频打开该集后复制其链接`
        : '未能从该腾讯链接识别出具体某一集，请打开该集后复制其链接'
    };
  }

  const queue = [input];
  const seen = new Set();
  for (let depth = 0; depth < 2 && queue.length; depth++) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const html = await fetchText(url);
    if (!html) continue;

    const vid = extractVidFromHtml(html);
    if (vid) return { vid, source: 'page', title: pickPageTitle(html) };

    // 收集下一层候选：iframe 与 v.qq.com 链接
    const links = [];
    const reIframe = /<iframe[^>]+src=["']([^"']+)["']/gi;
    let mm;
    while ((mm = reIframe.exec(html))) links.push(mm[1]);
    const reVqq = /https?:\/\/[^\s"'<>]*v\.qq\.com[^\s"'<>]*/gi;
    while ((mm = reVqq.exec(html))) links.push(mm[0]);
    for (const l of links.slice(0, 5)) {
      try { queue.push(new URL(l, url).href); } catch (_) { /* 忽略非法链接 */ }
    }
  }

  return { vid: null, error: '该链接未找到腾讯视频 vid（可能是第三方解析源，请改用腾讯视频播放页链接）' };
}

/**
 * 采集单集弹幕
 * @param {object} opts
 * @param {string} opts.vid      腾讯视频 vid
 * @param {string} [opts.title]  节目标题（写入索引）
 * @param {string} opts.dataDir  落盘目录（userData/collected）
 * @param {(p:{phase:string,fetched:number,currentMin:number,done:boolean}) => void} [opts.onProgress]
 * @returns {Promise<{ok:boolean, cancelled?:boolean, error?:string, filePath?:string, count?:number, vid:string, title:string}>}
 */
async function startCollect(opts) {
  const input = String((opts && (opts.vid || opts.input)) || '').trim();
  let vid = input;
  let title = String((opts && opts.title) || '').trim();

  // 支持直接传链接：本地规则解析不出 vid 时，再联网解析（第三方页面 / 专辑页兜底）
  if (!looksLikeVid(vid)) {
    const r = (await resolveVid(input)) || {};
    if (!r.vid) {
      return { ok: false, error: r.error || 'vid 格式不正确（应为字母+数字，约 11 位）', vid: input, title };
    }
    vid = r.vid;
    if (!title && r.title) title = r.title;
  }
  if (!title) title = vid;
  const dataDir = opts.dataDir;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  if (!dataDir) return { ok: false, error: '未指定数据目录', vid, title };
  fs.mkdirSync(dataDir, { recursive: true });

  _cancelRequested = false;
  const raw = [];
  let emptyRun = 0;
  let lastNonEmptyMin = 0;

  onProgress({ phase: 'fetching', fetched: 0, currentMin: 0, done: false });

  // 段数上限（默认全量；传入 maxSegments 可做部分采集/测试）
  const maxSeg = Math.max(1, Math.min(MAX_SEG, Number(opts.maxSegments) || MAX_SEG));
  for (let i = 0; i < maxSeg; i++) {
    if (_cancelRequested) {
      return { ok: false, cancelled: true, vid, title, partial: normalizeBarrage(raw).length };
    }
    const start = i * SEG_MS;
    const list = await fetchSegment(vid, start);
    if (list && list.length) {
      emptyRun = 0;
      lastNonEmptyMin = Math.round(start / 60000);
      raw.push(...list);
    } else {
      emptyRun++;
    }
    if (emptyRun >= EMPTY_STOP) break;
    await sleep(DELAY_MS);
    // 节流上报进度（约每 4 段一次）
    if (i % 4 === 3) {
      onProgress({ phase: 'fetching', fetched: raw.length, currentMin: Math.round(start / 60000), done: false });
    }
  }

  if (_cancelRequested) {
    return { ok: false, cancelled: true, vid, title, partial: normalizeBarrage(raw).length };
  }

  raw.sort((a, b) => Number(a.time_offset) - Number(b.time_offset));
  const list = normalizeBarrage(raw);

  onProgress({ phase: 'converting', fetched: raw.length, currentMin: lastNonEmptyMin, done: false });

  const filePath = path.join(dataDir, `${vid}.json`);
  fs.writeFileSync(filePath, JSON.stringify(list), 'utf8');

  // 维护索引 collected/index.json
  const indexPath = path.join(dataDir, 'index.json');
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (_) { index = []; }
  const idx = index.findIndex((e) => e.vid === vid);
  const record = {
    vid,
    title,
    file: `${vid}.json`,
    count: list.length,
    coverMin: lastNonEmptyMin,
    createdAt: new Date().toISOString()
  };
  if (idx >= 0) index[idx] = record; else index.push(record);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

  onProgress({ phase: 'done', fetched: raw.length, currentMin: lastNonEmptyMin, done: true, count: list.length });
  return { ok: true, filePath, count: list.length, vid, title, coverMin: lastNonEmptyMin };
}

function cancelCollect() {
  _cancelRequested = true;
}

/** 列出已采集数据（供 UI 的“已采集”列表展示） */
function listCollected(dataDir) {
  const indexPath = path.join(dataDir, 'index.json');
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (_) { index = []; }
  return index
    .filter((e) => e && e.vid)
    .map((e) => ({
      vid: e.vid,
      title: e.title || e.vid,
      file: e.file || `${e.vid}.json`,
      count: Number(e.count) || 0,
      coverMin: Number(e.coverMin) || 0,
      createdAt: e.createdAt || '',
      filePath: path.join(dataDir, e.file || `${e.vid}.json`)
    }));
}

module.exports = {
  startCollect,
  cancelCollect,
  listCollected,
  extractVidFromUrl,
  extractCidFromUrl,
  resolveVid,
  normalizeBarrage
};
