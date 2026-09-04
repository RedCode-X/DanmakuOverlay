/**
 * _prepare_s6.js - 准备第6季第7期及以后的剧集列表
 * 从 fetch_episodes 结果中筛选"第7期"开始的所有视频，移动到 s6 目录
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'data', 's5_mzc00200c24ypkp', 'episodes.json');
const dstDir = path.join(__dirname, '..', 'data', 's6_mzc00200c24ypkp');
const all = JSON.parse(fs.readFileSync(src, 'utf8'));

// 找到第一个标题含"第7期"的索引，取其后（含）所有视频
let startIdx = all.findIndex(e => (e.title || '').includes('第7期'));
if (startIdx < 0) {
  console.error('未找到第7期');
  process.exit(1);
}
const selected = all.slice(startIdx);
console.log(`共 ${all.length} 个视频，第7期及以后 ${selected.length} 个:`);
selected.forEach((e, i) => console.log(`${String(i + 1).padStart(3)}. ${e.vid}  ${e.title}`));

fs.mkdirSync(dstDir, { recursive: true });
fs.writeFileSync(path.join(dstDir, 'episodes.json'), JSON.stringify(selected, null, 2), 'utf8');
console.log(`\n已保存到 ${path.join(dstDir, 'episodes.json')}`);
