// 超星反爬字体运行时解码器
// 超星的 font-cxsecret 字体会轮换(不同课程/时期用不同映射), 静态表无法覆盖。
// 本模块在测验页运行时: 提取页面内嵌的 base64 TTF -> 解析cmap得到乱码码点
// -> 用canvas渲染每个字形 -> 与参考字体的常用字渲染做相似度匹配 -> 生成映射表。
// 生成的映射写入 window.__CX_RUNTIME_MAP, quiz.js 的 decodeText 会合并使用。
// 高置信度(>=0.6)的映射才启用, 低分保持原字(部分解码仍大幅提升AI可读性)。
(function () {
  "use strict";

  var MIN_SCORE = 0.55;

  // 常用汉字候选集(约2100字, 覆盖日常与课程高频字, 含两代反爬字体已验证的真实字)
  var COMMON_CHARS = (
    "的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失满战远格士音轻目条呢病始达深完今提求清王化空业思切怎非找片罗钱语元喜曾离飞科言干流欢约各即指合反题必该论交终林请医晚制球决传画保读运及则房早院量苦火布品近坐产答星精视五连司巴管类未朋且婚台夜青北队久乎越观落尽形影红爸百令周吧识步希亚术留市半热送兴造谈容极随演收首根讲整式取照办强石古华拿计您装似足双妻尼转诉米称丽客南领节衣站黑刻统断福城故历惊脸选包紧争另建维绝树系伤示愿持千史谁准联妇纪基买志静诗独复痛消社算义竟确酒需单治卡幸兰念举仅钟怕共毛句息功官待究跟穿室易游程号居考突皮哪费倒价图具刚脑永歌响商礼细专黄块脚味灵改据般破引食仍存众注笔甚某沉血备习校默务土微娘须试怀料调察梦丝协央哭卖罪哈按警括舞宜府害索普朝刘群坏虽冷盖迷露顺富险灾宽顿壮夹扩铁轮孟临段胡迭择塞善埃烟康坚虎鸟呼瑞貌栽森梁模载丰击范杰杨杯禁射犯祝景玩盾玉划餐逸夫荣致赖赞蓄播置锦筑勤街忠冲卫彻唯误蒙陷冒映疯减页烈欧脉幕诸蓝墙填幅项座庄搞朗荡枉核检镇涉免恢谐镜惨聪个型号码点时候什么这样那样还是因为所以如果但是而且或者以及各种不同情况问题方面式方法过程状态结果可能存在开始结束之间关系作用影响意义价值目标任务要求条件环境工具技术数据信息知识理论实践应用领域系统结构功能特点性质特征规律原理规则标准模式类型分类层次级别阶段步骤措施策略方案计划组织管理部门服务业务经营活动市场竞争价格成本效益收入利润资金财产资源能源材料产品质量数量效率速度能力水平质量增长发展变化提高降低增加减少扩大缩小前后左右上下内外中间周围全部整体局部具体抽象简单复杂容易困难重要关键主要次要直接间接长期短期暂时永远经常通常偶尔总是可能必然肯定否定正确错误成功失败优缺点强弱好坏大小高低快慢新旧多少有无得失输赢胜负真假虚实深浅厚薄宽窄长短粗细远近高低疏密");

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[CX FontDecode]");
    console.log.apply(console, args);
  }

  // ---------- 入口: 有 font-cxsecret 的页面才解码 ----------
  function hasCxsecretFont() {
    if (document.querySelector(".font-cxsecret")) return true;
    for (var i = 0; i < document.styleSheets.length; i++) {
      try {
        var rules = document.styleSheets[i].cssRules;
        for (var j = 0; j < rules.length; j++) {
          if (rules[j].cssText && rules[j].cssText.indexOf("font-cxsecret") >= 0) return true;
        }
      } catch (e) {}
    }
    return false;
  }

  function extractFontBytes() {
    var styles = document.querySelectorAll("style");
    for (var i = 0; i < styles.length; i++) {
      var m = styles[i].textContent.match(/base64,([A-Za-z0-9+/=]+)/);
      if (m) {
        try {
          var bin = atob(m[1]);
          var bytes = new Uint8Array(bin.length);
          for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          return bytes;
        } catch (e) { return null; }
      }
    }
    return null;
  }

  // ---------- 最小TTF cmap解析(支持format 4/12) ----------
  function parseCmap(bytes) {
    if (bytes.length < 12) return null;
    var numTables = (bytes[4] << 8) | bytes[5];
    var cmapOffset = -1;
    for (var i = 0; i < numTables; i++) {
      var off = 12 + i * 16;
      var tag = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      if (tag === "cmap") { cmapOffset = (bytes[off + 8] << 24) | (bytes[off + 9] << 16) | (bytes[off + 10] << 8) | bytes[off + 11]; break; }
    }
    if (cmapOffset < 0) return null;
    var numSub = (bytes[cmapOffset + 2] << 8) | bytes[cmapOffset + 3];
    var codepoints = [];
    for (var s = 0; s < numSub; s++) {
      var so = cmapOffset + 4 + s * 8;
      var subOff = cmapOffset + ((bytes[so + 4] << 24) | (bytes[so + 5] << 16) | (bytes[so + 6] << 8) | bytes[so + 7]);
      var format = (bytes[subOff] << 8) | bytes[subOff + 1];
      if (format === 4) {
        var segCountX2 = (bytes[subOff + 6] << 8) | bytes[subOff + 7];
        var segCount = segCountX2 / 2;
        var endBase = subOff + 14, startBase = endBase + segCountX2 + 2,
            deltaBase = startBase + segCountX2, rangeBase = deltaBase + segCountX2;
        for (var seg = 0; seg < segCount; seg++) {
          var endCode = (bytes[endBase + seg * 2] << 8) | bytes[endBase + seg * 2 + 1];
          var startCode = (bytes[startBase + seg * 2] << 8) | bytes[startBase + seg * 2 + 1];
          if (startCode === 0xffff) continue;
          for (var cp = startCode; cp <= endCode && cp !== 0xffff; cp++) {
            var idDelta = (bytes[deltaBase + seg * 2] << 8) | bytes[deltaBase + seg * 2 + 1];
            var idRangeOffset = (bytes[rangeBase + seg * 2] << 8) | bytes[rangeBase + seg * 2 + 1];
            var gid = 0;
            if (idRangeOffset === 0) gid = (cp + idDelta) & 0xffff;
            else {
              var addr = rangeBase + seg * 2 + idRangeOffset + (cp - startCode) * 2;
              if (addr + 1 < bytes.length) {
                gid = (bytes[addr] << 8) | bytes[addr + 1];
                if (gid !== 0) gid = (gid + idDelta) & 0xffff;
              }
            }
            if (gid !== 0 && codepoints.indexOf(cp) < 0) codepoints.push(cp);
          }
        }
      } else if (format === 12) {
        var nGroups = ((bytes[subOff + 12] << 24) | (bytes[subOff + 13] << 16) | (bytes[subOff + 14] << 8) | bytes[subOff + 15]) >>> 0;
        for (var g = 0; g < nGroups; g++) {
          var go = subOff + 16 + g * 12;
          var gs = ((bytes[go] << 24) | (bytes[go + 1] << 16) | (bytes[go + 2] << 8) | bytes[go + 3]) >>> 0;
          var ge = ((bytes[go + 4] << 24) | (bytes[go + 5] << 16) | (bytes[go + 6] << 8) | bytes[go + 7]) >>> 0;
          for (var cp2 = gs; cp2 <= ge && cp2 - gs < 1000; cp2++) {
            if (codepoints.indexOf(cp2) < 0) codepoints.push(cp2);
          }
        }
      }
    }
    return codepoints;
  }

  // ---------- canvas字形匹配 ----------
  var S = 24; // 归一化比较尺寸(24比20对形近字区分更好)
  var R = 40; // 渲染画布尺寸(40比64快约2.5倍, 精度足够)

  function makeCanvas() {
    var c = document.createElement("canvas");
    c.width = R; c.height = R;
    return c;
  }

  function getBitmap(ctx, ch, font) {
    ctx.clearRect(0, 0, R, R);
    ctx.font = "34px " + font;
    ctx.textBaseline = "top";
    ctx.fillStyle = "#000";
    ctx.fillText(ch, 3, 3);
    var img = ctx.getImageData(0, 0, R, R).data;
    var minX = R, minY = R, maxX = -1, maxY = -1;
    var ink = new Uint8Array(R * R);
    for (var y = 0; y < R; y++) {
      for (var x = 0; x < R; x++) {
        var i = (y * R + x) * 4;
        var on = img[i + 3] > 40 && (img[i] + img[i + 1] + img[i + 2]) / 3 < 128;
        if (on) {
          ink[y * R + x] = 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    var w = maxX - minX + 1, h = maxY - minY + 1;
    var bm = new Uint8Array(S * S);
    for (var gy = 0; gy < S; gy++) {
      for (var gx = 0; gx < S; gx++) {
        var sx = minX + Math.floor((gx * w) / S);
        var sy = minY + Math.floor((gy * h) / S);
        bm[gy * S + gx] = ink[Math.min(sy, R - 1) * R + Math.min(sx, R - 1)];
      }
    }
    return bm;
  }

  function similarity(a, b) {
    var inter = 0, union = 0;
    for (var i = 0; i < S * S; i++) {
      if (a[i] && b[i]) inter++;
      if (a[i] || b[i]) union++;
    }
    return union ? inter / union : 0;
  }

  // 参考字体: 多字体交叉提高稳健性(不同字形风格各有命中机会)
  var REF_FONTS = ["Microsoft YaHei", "SimSun", "SimHei", "KaiTi"];

  function buildRuntimeMap() {
    try {
      if (!hasCxsecretFont()) return;
      var bytes = extractFontBytes();
      if (!bytes) { log("未找到内嵌字体"); return; }
      var codepoints = parseCmap(bytes);
      if (!codepoints || !codepoints.length) { log("cmap解析失败"); return; }
      log("字体码点数: " + codepoints.length + ", 开始字形匹配...");

      var canvas = makeCanvas();
      var ctx = canvas.getContext("2d", { willReadFrequently: true });

      // 参考位图缓存
      var candSet = [];
      for (var ch of COMMON_CHARS) {
        if (candSet.indexOf(ch) < 0) candSet.push(ch);
      }
      var refBitmaps = []; // [{c, bm}]
      for (var f = 0; f < REF_FONTS.length; f++) {
        for (var c = 0; c < candSet.length; c++) {
          var bm = getBitmap(ctx, candSet[c], REF_FONTS[f]);
          if (bm) refBitmaps.push({ c: candSet[c], bm: bm });
        }
      }

      var map = {};
      var solved = 0;
      for (var i = 0; i < codepoints.length; i++) {
        var cp = codepoints[i];
        var glyph = String.fromCodePoint(cp);
        var gbm = getBitmap(ctx, glyph, "font-cxsecret");
        if (!gbm) continue;
        var best = null, bestScore = 0;
        for (var r = 0; r < refBitmaps.length; r++) {
          var s = similarity(gbm, refBitmaps[r].bm);
          if (s > bestScore) { bestScore = s; best = refBitmaps[r].c; }
        }
        if (best && bestScore >= MIN_SCORE) {
          map[cp] = best;
          solved++;
        }
      }
      window.__CX_RUNTIME_MAP = map;
      log("解码完成: " + solved + "/" + codepoints.length + " 个字形 (阈值" + MIN_SCORE + ")");
    } catch (e) {
      log("解码异常:", e && e.message);
    } finally {
      if (window.__CX_FONT_READY_RESOLVE) window.__CX_FONT_READY_RESOLVE();
    }
  }

  // 就绪Promise: quiz.js 等待它(最多8秒)
  window.__CX_FONT_READY = new Promise(function (resolve) {
    window.__CX_FONT_READY_RESOLVE = resolve;
    // 字体解码需要样式已加载, document_idle时机执行
    if (document.readyState === "complete" || document.readyState === "interactive") {
      setTimeout(buildRuntimeMap, 300);
    } else {
      document.addEventListener("DOMContentLoaded", function () {
        setTimeout(buildRuntimeMap, 300);
      });
    }
    // 兜底超时
    setTimeout(resolve, 10000);
  });
})();
