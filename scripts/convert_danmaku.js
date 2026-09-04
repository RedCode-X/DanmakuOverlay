/**
 * convert_danmaku.js - 将采集的原始弹幕转换为弹幕发射器可加载的精简格式
 *
 * 输出格式（与 renderer/danmaku-data.js 兼容）:
 *   [ { "time": 秒, "type": "scroll", "text": "弹幕文本", "color": "#RRGGBB" } ]
 *
 * 用法:
 *   node scripts/convert_danmaku.js                          # 默认第5季数据目录
 *   node scripts/convert_danmaku.js --dir=s6_mzc00200c24ypkp # 指定数据目录
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dataDirName = args.find(a => a.startsWith('--dir='))?.split('=')[1] || 's5_mzc002005od4txd';
const DATA_DIR = path.join(__dirname, '..', 'data', dataDirName);
const EPISODES_FILE = path.join(DATA_DIR, 'episodes.json');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const OUT_DIR = path.join(DATA_DIR, 'danmaku');

const BAD_CHARS = /[\\/:*?"<>|]/g;

function parseColor(style) {
  // 腾讯弹幕 content_style 形如 "0:FFFFFF:0:0:0"（前段可能含颜色 hex），未知则留白
  if (!style) return undefined;
  const m = style.match(/([0-9a-fA-F]{6})/);
  return m ? `#${m[1]}` : undefined;
}

function main() {
  if (!fs.existsSync(EPISODES_FILE) || !fs.existsSync(RAW_DIR)) {
    console.error('缺少 episodes.json 或 raw 目录');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const episodes = JSON.parse(fs.readFileSync(EPISODES_FILE, 'utf8'));
  const index = [];
  let totalBarrage = 0;

  for (const ep of episodes) {
    const rawFile = path.join(RAW_DIR, `${ep.vid}.json`);
    if (!fs.existsSync(rawFile)) {
      console.log(`${ep.vid} 缺少原始数据，跳过`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    const list = raw.map((d) => {
      const color = parseColor(d.content_style);
      const item = {
        time: Math.round((Number(d.time_offset) || 0)) / 1000,
        type: 'scroll',
        text: (d.content || '').trim(),
      };
      if (color) item.color = color;
      return item;
    }).filter(d => d.text.length > 0);

    const safeTitle = (ep.title || ep.vid).replace(BAD_CHARS, '_');
    const outFile = path.join(OUT_DIR, `${safeTitle}.json`);
    fs.writeFileSync(outFile, JSON.stringify(list), 'utf8');

    index.push({ vid: ep.vid, title: ep.title, file: `${safeTitle}.json`, count: list.length });
    totalBarrage += list.length;
    console.log(`${safeTitle}.json   ${list.length} 条`);
  }

  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  console.log(`\n共 ${index.length} 集，${totalBarrage} 条弹幕`);
  console.log(`输出目录: ${OUT_DIR}`);
  console.log(`剧集索引: ${path.join(DATA_DIR, 'index.json')}`);
}

main();
