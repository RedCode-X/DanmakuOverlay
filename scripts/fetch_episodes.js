/**
 * fetch_episodes.js - 从腾讯视频播放页提取剧集列表（vid 列表）
 *
 * 用法: node scripts/fetch_episodes.js [cid] [firstVid] [--headful]
 *   默认 cid: mzc002005od4txd（五十公里桃花坞 第5季）
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const CID_REG = /^[a-z]\d{4}[a-z0-9]{3,8}$/;

async function main() {
  const args = process.argv.slice(2);
  const cid = args.find(a => !a.startsWith('--') && !/^[a-z]\d{4}/.test(a)) || 'mzc002005od4txd';
  const firstVid = args.find(a => CID_REG.test(a));
  const headful = args.includes('--headful');
  const executablePath = fs.existsSync(CHROME) ? CHROME : EDGE;

  const browser = await chromium.launch({
    executablePath,
    headless: !headful,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  const firstVidUrl = firstVid
    ? `https://v.qq.com/x/cover/${cid}/${firstVid}.html`
    : `https://v.qq.com/x/cover/${cid}.html`;
  console.log(`[fetch_episodes] 打开 ${firstVidUrl} ...`);
  await page.goto(firstVidUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);

  // 展开选集面板
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.player-playlist__btn, [class*="playlist__btn"]')]
      .find(el => el.offsetParent !== null);
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (clicked) {
    console.log('[fetch_episodes] 已展开选集面板');
    await page.waitForTimeout(3000);
  }

  // 提取当前所有 mine
  const extract = () => page.evaluate((cid) => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('.video-item[dt-params]').forEach((el) => {
      const p = el.getAttribute('dt-params') || '';
      if (!p.includes(`cid=${cid}`)) return;
      const vm = p.match(/vid=([a-z0-9]+)/);
      if (!vm) return;
      const vid = vm[1].toLowerCase();
      if (seen.has(vid)) return;
      seen.add(vid);
      const titleEl = el.querySelector('[class*="right-main"]');
      const title = (titleEl?.getAttribute('title') || titleEl?.textContent ||
        el.querySelector('img')?.alt || '').trim();
      const mod = (p.match(/mod_id=(\w+)/) || [])[1] || '';
      out.push({ vid, title, mod });
    });
    return out;
  }, cid);

  // 分步滚动并持续收集，覆盖虚拟列表全部节点
  const all = new Map();
  const addAll = (list) => list.forEach(e => all.set(e.vid, e));

  // 找到列表滚动容器并回到顶部
  const viewInfo = await page.evaluate(() => {
    const views = [...document.querySelectorAll('.player-playlist .scroll-view, .episode-module-container .scroll-view')]
      .filter(el => el.scrollHeight > el.clientHeight + 5);
    views.forEach(v => { v.scrollTop = 0; });
    return { n: views.length, heights: views.map(v => `${v.clientHeight}/${v.scrollHeight}`) };
  });
  console.log('[fetch_episodes] 滚动容器:', viewInfo.n, viewInfo.heights.join(', '));
  await page.waitForTimeout(1500);
  addAll(await extract());

  // 顶部->底部 逐段滚动
  for (let i = 0; i < 80; i++) {
    const r = await page.evaluate(() => {
      const views = [...document.querySelectorAll('.player-playlist .scroll-view, .episode-module-container .scroll-view')]
        .filter(el => el.scrollHeight > el.clientHeight + 5);
      if (!views.length) return { status: 'none' };
      let anyChanged = false;
      for (const v of views) {
        const before = v.scrollTop;
        v.scrollTop += 500;
        if (v.scrollTop !== before) anyChanged = true;
      }
      const tops = views.map(v => `${v.scrollTop}/${v.scrollHeight}`);
      return { status: 'scrolled', changed: anyChanged, tops };
    });
    await page.waitForTimeout(900);
    addAll(await extract());
    if (r.status === 'none') break;
    if (!r.changed) break;
    if (i % 8 === 7) console.log(`[fetch_episodes] 滚动 ${i + 1} 次，已收集 ${all.size} 集`);
  }

  // 回到顶部再扫一遍（防止遗漏中间段）
  await page.evaluate(() => {
    document.querySelectorAll('.player-playlist .scroll-view').forEach(v => { v.scrollTop = 0; });
  });
  await page.waitForTimeout(1200);
  addAll(await extract());

  const episodes = [...all.values()];
  console.log(`[fetch_episodes] 共收集到 ${episodes.length} 集（cid=${cid}）:`);
  episodes.forEach((e, i) => console.log(`${String(i + 1).padStart(3)}. ${e.vid} [${e.mod}] ${e.title}`));

  const dir = path.join(__dirname, '..', 'data', `s5_${cid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'episodes.json'), JSON.stringify(episodes, null, 2), 'utf8');
  console.log(`[fetch_episodes] 已保存到 ${path.join(dir, 'episodes.json')}`);

  await browser.close();
}

main().catch((e) => { console.error('[fetch_episodes] 失败:', e); process.exit(1); });
