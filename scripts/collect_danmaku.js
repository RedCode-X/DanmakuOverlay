/**
 * collect_danmaku.js - 采集腾讯视频弹幕数据
 *
 * 弹幕接口: https://dm.video.qq.com/barrage/segment/{vid}/t/v1/{start_ms}/{end_ms}
 * 已验证段跨度上限为 120000ms（2 分钟），返回 JSON { barrage_list: [...] }
 *
 * 用法:
 *   node scripts/collect_danmaku.js                          # 采集所有集（默认第5季数据目录）
 *   node scripts/collect_danmaku.js --vid=d4101xpgdbn        # 只采某集
 *   node scripts/collect_danmaku.js --dir=s6_mzc00200c24ypkp # 指定数据目录（对应某季）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SEG_MS = 120000;            // 每段 2 分钟
const EMPTY_STOP = 5;             // 连续空段数达到该值则视为视频结束（10分钟无弹幕）
const MAX_SEG = 200;              // 单集最大段数（200*2min=400min，足够长）
const DELAY_MS = 60;              // 请求间隔
const RETRIES = 4;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://v.qq.com/',
  'Accept': 'application/json, text/plain, */*',
};

const args = process.argv.slice(2);
const onlyVid = args.find(a => a.startsWith('--vid='))?.split('=')[1];
const dataDirName = args.find(a => a.startsWith('--dir='))?.split('=')[1] || 's5_mzc002005od4txd';

const DATA_DIR = path.join(__dirname, '..', 'data', dataDirName);
const EPISODES_FILE = path.join(DATA_DIR, 'episodes.json');
const RAW_DIR = path.join(DATA_DIR, 'raw');

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 请求一段弹幕（带重试），成功返回数组，最终失败返回 null */
async function fetchSegment(vid, startMs, endMs) {
  const url = `https://dm.video.qq.com/barrage/segment/${vid}/t/v1/${startMs}/${endMs}`;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const data = await getJson(url);
      return data.barrage_list || [];
    } catch (e) {
      if (attempt === RETRIES) {
        console.error(`    [err] ${Math.round(startMs / 60000)}min: ${e.message}`);
        return null;
      }
      await sleep(400 * attempt);
    }
  }
  return null;
}

/** 采集一集：从 0 开始每 2 分钟一段线性扫描，连续空段则停止 */
async function collectEpisode(ep, index, total) {
  const rawFile = path.join(RAW_DIR, `${ep.vid}.json`);
  if (fs.existsSync(rawFile)) {
    const existed = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    console.log(`[${index}/${total}] ${ep.vid} ${ep.title} —— 已完成（${existed.length} 条），跳过`);
    return existed.length;
  }

  console.log(`[${index}/${total}] ${ep.vid} ${ep.title}`);

  const danmaku = [];
  let emptyRun = 0;
  let lastNonEmptyMin = 0;

  for (let i = 0; i < MAX_SEG; i++) {
    const start = i * SEG_MS;
    const list = await fetchSegment(ep.vid, start, start + SEG_MS);
    if (list && list.length) {
      emptyRun = 0;
      lastNonEmptyMin = Math.round(start / 60000);
      danmaku.push(...list);
    } else {
      emptyRun++;
    }
    if (emptyRun >= EMPTY_STOP) break;
    await sleep(DELAY_MS);
  }

  danmaku.sort((a, b) => Number(a.time_offset) - Number(b.time_offset));
  fs.writeFileSync(rawFile, JSON.stringify(danmaku, null, 1), 'utf8');
  console.log(`    覆盖至 ${lastNonEmptyMin} 分钟，共 ${danmaku.length} 条弹幕`);
  return danmaku.length;
}

async function main() {
  if (!fs.existsSync(EPISODES_FILE)) {
    console.error('未找到 episodes.json，请先运行 fetch_episodes.js');
    process.exit(1);
  }
  fs.mkdirSync(RAW_DIR, { recursive: true });
  let episodes = JSON.parse(fs.readFileSync(EPISODES_FILE, 'utf8'));
  if (onlyVid) episodes = episodes.filter(e => e.vid === onlyVid);
  if (!episodes.length) { console.error('没有匹配的剧集'); process.exit(1); }

  console.log(`开始采集 ${episodes.length} 集弹幕 ...\n`);
  const t0 = Date.now();
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const start = Date.now();
    try {
      const count = await collectEpisode(ep, i + 1, episodes.length);
      const used = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`    用时 ${used}s\n`);
    } catch (e) {
      console.error(`    [失败] ${ep.vid}: ${e.message}\n`);
    }
  }
  console.log(`全部完成，总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
}

main().catch(e => { console.error('采集失败:', e); process.exit(1); });
