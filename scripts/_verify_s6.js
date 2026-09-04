const fs = require('fs');
const path = require('path');
const dir = 'e:/Job/ComputerKnowlodge/04.AI/dm_send/data/s6_mzc00200c24ypkp';

const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
console.log('剧集数:', index.length);

// 验证所有文件存在且可解析
let total = 0, missing = 0;
for (const ep of index) {
  const f = path.join(dir, 'danmaku', ep.file);
  if (!fs.existsSync(f)) { console.log('缺失:', ep.file); missing++; continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  total += d.length;
  // 抽查第一条
  if (ep === index[0]) console.log('样本:', JSON.stringify(d[0]));
  if (ep === index[0]) console.log('time范围:', d[0].time, '->', d[d.length - 1].time);
}
console.log('文件缺失:', missing, '| 弹幕总计:', total);

// 确认 raw 目录
const rawCount = fs.readdirSync(path.join(dir, 'raw')).filter(f => f.endsWith('.json')).length;
console.log('raw 文件数:', rawCount);
