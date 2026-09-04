/**
 * DanmakuDataLoader - 弹幕数据加载器
 *
 * 统一输出格式：
 *   { time: number,       // 弹幕相对时间（秒）
 *     type: 'scroll'|'top'|'bottom',
 *     text: string,
 *     color?: string }    // 可选，默认白色
 *
 * 接口预留：后续接入真实采集数据时，只需新增一个 loader 方法
 * （如 loadFromBiliXml），返回相同结构即可，渲染引擎无需改动。
 */
const DEMO_DANMAKU = [
  { "time": 0.5, "type": "scroll", "text": "来了来了" },
  { "time": 1.2, "type": "scroll", "text": "第一！" },
  { "time": 1.8, "type": "top", "text": "弹幕护体", "color": "#00D68F" },
  { "time": 2.5, "type": "scroll", "text": "前排围观", "color": "#FF7EB3" },
  { "time": 3.2, "type": "scroll", "text": "这部剧我等好久了" },
  { "time": 4.0, "type": "bottom", "text": "前方高能预警", "color": "#FF5C5C" },
  { "time": 5.0, "type": "scroll", "text": "准备好截图了吗", "color": "#FFB400" },
  { "time": 6.2, "type": "scroll", "text": "画质绝了" },
  { "time": 7.5, "type": "top", "text": "主角要出场了", "color": "#00AEEC" },
  { "time": 8.3, "type": "scroll", "text": "这配乐太带感了", "color": "#B388FF" },
  { "time": 9.6, "type": "scroll", "text": "弹幕别刷屏，认真看" },
  { "time": 10.8, "type": "scroll", "text": "前方名场面预定", "color": "#FF5C5C" },
  { "time": 12.0, "type": "scroll", "text": "这气质，绝了", "color": "#FF7EB3" },
  { "time": 13.4, "type": "top", "text": "帅到我窒息", "color": "#FF7EB3" },
  { "time": 14.2, "type": "scroll", "text": "导演很会拍人" },
  { "time": 15.6, "type": "scroll", "text": "镜头语言满分", "color": "#00D68F" },
  { "time": 16.8, "type": "scroll", "text": "这段剧情在铺垫什么" },
  { "time": 18.0, "type": "bottom", "text": "注意细节！后面会回收", "color": "#FFB400" },
  { "time": 19.2, "type": "scroll", "text": "编剧的伏笔很到位", "color": "#B388FF" },
  { "time": 20.5, "type": "scroll", "text": "哈哈哈哈哈" },
  { "time": 21.8, "type": "scroll", "text": "笑死我了这段", "color": "#FFB400" },
  { "time": 23.0, "type": "top", "text": "名场面打卡", "color": "#FF5C5C" },
  { "time": 24.2, "type": "scroll", "text": "演技在线" },
  { "time": 25.6, "type": "scroll", "text": "这台词写得太好了", "color": "#00D68F" },
  { "time": 26.8, "type": "scroll", "text": "弹幕走一波666" },
  { "time": 28.0, "type": "scroll", "text": "眼神戏细节拉满", "color": "#00AEEC" },
  { "time": 29.4, "type": "scroll", "text": "就冲这段我也要追下去" },
  { "time": 30.6, "type": "bottom", "text": "前方高能，非战斗人员请撤离", "color": "#FF5C5C" },
  { "time": 31.8, "type": "scroll", "text": "高能预警！", "color": "#FF5C5C" },
  { "time": 33.0, "type": "scroll", "text": "卧槽这转折", "color": "#FFB400" },
  { "time": 34.2, "type": "top", "text": "编剧你是魔鬼吗", "color": "#FF5C5C" },
  { "time": 35.6, "type": "scroll", "text": "我人麻了" },
  { "time": 36.8, "type": "scroll", "text": "这反转来得太突然", "color": "#B388FF" },
  { "time": 38.0, "type": "scroll", "text": "心脏受不了了", "color": "#FF7EB3" },
  { "time": 39.4, "type": "scroll", "text": "全程高能" },
  { "time": 40.6, "type": "bottom", "text": "稳住，我们能赢", "color": "#00D68F" },
  { "time": 41.8, "type": "scroll", "text": "这段配乐燃起来了", "color": "#FFB400" },
  { "time": 43.0, "type": "scroll", "text": "画面构图太美了", "color": "#00AEEC" },
  { "time": 44.2, "type": "scroll", "text": "每一帧都是壁纸" },
  { "time": 45.6, "type": "top", "text": "绝美画面", "color": "#00D68F" },
  { "time": 46.8, "type": "scroll", "text": "摄影师加鸡腿", "color": "#FFB400" },
  { "time": 48.0, "type": "scroll", "text": "这光影运用绝了", "color": "#B388FF" },
  { "time": 49.2, "type": "scroll", "text": "泪目了这段", "color": "#00AEEC" },
  { "time": 50.6, "type": "bottom", "text": "纸巾不够用了", "color": "#FF7EB3" },
  { "time": 52.0, "type": "scroll", "text": "这段感情戏演得真好" },
  { "time": 53.4, "type": "scroll", "text": "眼泪不争气地流了下来", "color": "#00AEEC" },
  { "time": 54.6, "type": "scroll", "text": "弹幕都安静了" },
  { "time": 56.0, "type": "scroll", "text": "大家都不说话了，太投入了", "color": "#B388FF" },
  { "time": 57.4, "type": "top", "text": "本集最佳片段", "color": "#FFB400" },
  { "time": 58.8, "type": "scroll", "text": "回去再看一遍这段" },
  { "time": 60.0, "type": "scroll", "text": "剧情开始推进了", "color": "#00D68F" },
  { "time": 61.4, "type": "scroll", "text": "大场面来了" },
  { "time": 62.6, "type": "scroll", "text": "这特效是真金白银", "color": "#FFB400" },
  { "time": 64.0, "type": "top", "text": "前方核能", "color": "#FF5C5C" },
  { "time": 65.2, "type": "scroll", "text": "经费在燃烧" },
  { "time": 66.8, "type": "scroll", "text": "打戏行云流水", "color": "#00D68F" },
  { "time": 68.0, "type": "scroll", "text": "这个镜头调度绝了", "color": "#B388FF" },
  { "time": 69.4, "type": "scroll", "text": "太燃了！" },
  { "time": 70.6, "type": "bottom", "text": "弹幕护体，特效免疫", "color": "#00AEEC" },
  { "time": 72.0, "type": "scroll", "text": "我愿称之为年度神作", "color": "#FFB400" },
  { "time": 73.4, "type": "scroll", "text": "已经三刷了", "color": "#FF7EB3" },
  { "time": 74.6, "type": "scroll", "text": "每次看都有新发现" },
  { "time": 76.0, "type": "top", "text": "细节控狂喜", "color": "#00D68F" },
  { "time": 77.4, "type": "scroll", "text": "这个伏笔回收了！", "color": "#00AEEC" },
  { "time": 78.6, "type": "scroll", "text": "果然前面不是白铺垫的", "color": "#B388FF" },
  { "time": 80.0, "type": "scroll", "text": "编剧布局真深", "color": "#FFB400" },
  { "time": 81.4, "type": "scroll", "text": "细思极恐" },
  { "time": 82.8, "type": "bottom", "text": "前方大型打脸现场", "color": "#FF5C5C" },
  { "time": 84.0, "type": "scroll", "text": "打脸来得太快", "color": "#FFB400" },
  { "time": 85.4, "type": "scroll", "text": "我收回刚才说的话", "color": "#00AEEC" },
  { "time": 86.6, "type": "scroll", "text": "哈哈哈哈被自己蠢哭" },
  { "time": 88.0, "type": "top", "text": "笑不活了", "color": "#FF7EB3" },
  { "time": 89.4, "type": "scroll", "text": "这剧的弹幕比剧还好看" },
  { "time": 90.6, "type": "scroll", "text": "弹幕人均段子手", "color": "#B388FF" },
  { "time": 92.0, "type": "scroll", "text": "剧情进入最后阶段了", "color": "#00D68F" },
  { "time": 93.4, "type": "scroll", "text": "高潮来了！" },
  { "time": 94.6, "type": "bottom", "text": "全员演技炸裂", "color": "#FF5C5C" },
  { "time": 96.0, "type": "scroll", "text": "这对手戏看得头皮发麻", "color": "#FF7EB3" },
  { "time": 97.4, "type": "scroll", "text": "台词句句是刀" },
  { "time": 98.6, "type": "top", "text": "刀死我了", "color": "#FF5C5C" },
  { "time": 100.0, "type": "scroll", "text": "太震撼了这段" },
  { "time": 101.4, "type": "scroll", "text": "我要缓缓", "color": "#B388FF" },
  { "time": 102.6, "type": "scroll", "text": "这结尾留得妙", "color": "#00AEEC" },
  { "time": 104.0, "type": "bottom", "text": "求下一集！", "color": "#FFB400" },
  { "time": 105.4, "type": "scroll", "text": "卡在这里我睡不着了", "color": "#FF7EB3" },
  { "time": 106.6, "type": "scroll", "text": "每周等更新的日子太难了" },
  { "time": 108.0, "type": "scroll", "text": "最后一幕太戳人了", "color": "#00AEEC" },
  { "time": 109.4, "type": "top", "text": "愿所有善良都被温柔以待", "color": "#00D68F" },
  { "time": 110.6, "type": "scroll", "text": "下一集见！" },
  { "time": 112.0, "type": "scroll", "text": "本集完，撒花", "color": "#FFB400" },
  { "time": 113.4, "type": "scroll", "text": "感谢陪伴", "color": "#00D68F" },
  { "time": 115.0, "type": "bottom", "text": "弹幕有你们真好", "color": "#FF7EB3" },
  { "time": 116.8, "type": "scroll", "text": "片尾曲好听" },
  { "time": 118.2, "type": "scroll", "text": "舍不得结束", "color": "#B388FF" },
  { "time": 120.0, "type": "top", "text": "下集预告：更大的风暴", "color": "#FF5C5C" }
];

const DanmakuDataLoader = {
  /** 内置演示数据（mock） */
  async loadBuiltin() {
    return DEMO_DANMAKU.slice();
  },

  /**
   * 从本地 JSON 文件加载弹幕。
   * 支持两种结构：JSON 数组，或 { danmaku: [...] }
   */
  async loadFile(filePath) {
    const res = await window.danmaku.loadFile(filePath);
    if (!res.ok) throw new Error(res.error);
    return DanmakuDataLoader._normalize(res.data);
  },

  /**
   * 预留：B 站 XML 弹幕解析接口。
   * 后续实现采集时，把 <d p="..."> 节点解析为统一结构即可。
   */
  async loadFromBiliXml(xmlText) {
    // TODO: 接入真实采集数据时实现
    throw new Error('B 站 XML 解析暂未实现，后续接入采集数据时补充');
  },

  /** 兜底：数据格式错误时回退到内置演示数据 */
  async loadWithFallback(source) {
    try {
      if (source === 'builtin') return await this.loadBuiltin();
      if (source && source.startsWith('file:')) {
        return await this.loadFile(source.slice(5));
      }
      return await this.loadBuiltin();
    } catch (_) {
      return await this.loadBuiltin();
    }
  },

  /** 将任意输入规范化为统一弹幕结构 */
  _normalize(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((d) => {
        if (typeof d !== 'object' || d === null) return null;
        const type = ['scroll', 'top', 'bottom'].includes(d.type) ? d.type : 'scroll';
        const time = Number(d.time);
        if (!Number.isFinite(time) || time < 0) return null;
        return {
          time,
          type,
          text: String(d.text || '').trim(),
          color: typeof d.color === 'string' ? d.color : undefined
        };
      })
      .filter((d) => d !== null && d.text.length > 0);
  }
};
