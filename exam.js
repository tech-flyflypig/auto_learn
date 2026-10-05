// 超星考试模块 —— 注入到考试页 (exam-ans)
// 流程: 考试答题页 -> 自动进入整卷预览(选项可直接点击并自动保存) -> 解析题目
//       -> 查题库/AI -> 逐题填充 -> (可选)自动交卷 -> 结果页收割
// 与 quiz.js 共用 background 的 ANSWER_QUERY/BANK_SAVE 协议和 autoAnswerEnabled 开关。
// 考试页无字体反爬(题干明文), decodeText 仅作无害兜底。
(function () {
  "use strict";

  var enabled = false;
  var autoSubmit = false;
  var minConfidence = 0.6;
  var minSubmitMinutes = 0;     // 最快交卷时间(分钟, 从开考算起), 0=按题数自动(每题15秒,最少3分钟)
  var submitSafetyMinutes = 3;  // 最晚交卷: 距考试结束剩余不足此分钟数时强制交卷
  var examStartAt = 0;          // 扩展加载时刻(兜底的开考时间)

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[CX Exam]");
    console.log.apply(console, args);
  }

  function decodeText(s) {
    if (!s || typeof CX_FONT_MAP === "undefined") return s || "";
    var out = "";
    for (var ch of String(s)) {
      out += CX_FONT_MAP[ch.codePointAt(0)] || ch;
    }
    return out;
  }

  // 去掉 "1. (单选题, 2.0 分)" 前缀后再归一化, 作为题库主键
  function normalizeStem(s) {
    return decodeText(s)
      .replace(/^\s*\d+\s*[\.、]\s*\([^)]*\)\s*/, "")
      .replace(/【.*?】/g, "")
      .replace(/[\s\u3000]/g, "")
      .replace(/[0-9]+[\.、]/g, "")
      .replace(/[。．.,，、;；:：?？!！()（）\[\]{}"'’‘“”\-—_\/\\·…]/g, "")
      .toLowerCase();
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  // ---------- 状态浮窗(考试页是独立顶层页面, 自带浮窗不依赖content.js) ----------
  function ensureStatusBar() {
    var bar = document.getElementById("cx-status-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "cx-status-bar";
      bar.style.cssText =
        "position:fixed;top:12px;right:12px;z-index:2147483647;" +
        "background:rgba(20,20,20,0.82);color:#fff;padding:9px 16px;border-radius:8px;" +
        "font-size:13px;font-family:'Microsoft YaHei',sans-serif;line-height:1.6;" +
        "max-width:320px;box-shadow:0 2px 12px rgba(0,0,0,0.35);" +
        "pointer-events:none;transition:opacity .4s;opacity:0;";
      document.body.appendChild(bar);
    }
    return bar;
  }

  var statusTimer = null;
  function showStatus(text, stickyMs) {
    try {
      var bar = ensureStatusBar();
      bar.textContent = "⚡ " + text;
      bar.style.opacity = "1";
      if (statusTimer) clearTimeout(statusTimer);
      if (stickyMs !== 0) {
        statusTimer = setTimeout(function () { bar.style.opacity = "0"; }, stickyMs || 6000);
      }
    } catch (e) {}
  }

  // 判断题答案归一化
  function normalizeJudge(s) {
    s = String(s == null ? "" : s).trim().toLowerCase();
    if (["对", "正确", "√", "true", "是", "a", "t"].indexOf(s) >= 0) return "对";
    if (["错", "错误", "×", "x", "false", "否", "b", "f"].indexOf(s) >= 0) return "错";
    return null;
  }

  function isExamStartPage() {
    return /\/exam-ans\/exam\/test\/(reVersionTestStartNew|testStart)/i.test(location.href);
  }
  function isExamPreviewPage() {
    return /\/exam-ans\/.*\/exam\/preview/i.test(location.href) || /\/exam-ans\/exam\/preview/i.test(location.href);
  }
  function isExamViewPage() {
    // 交卷后的成绩/查看页(具体URL待真实提交后核实)
    return /\/exam-ans\/.*(view|result|score|review)/i.test(location.href) && !isExamPreviewPage();
  }

  // ---------- 入口 ----------
  chrome.storage.local.get(["autoAnswerEnabled", "cx_answer_config"], function (cfg) {
    enabled = !!cfg.autoAnswerEnabled;
    var c = cfg.cx_answer_config || {};
    autoSubmit = c.autoSubmit !== false; // 默认自动提交, 配置页可关
    minSubmitMinutes = parseFloat(c.minSubmitMinutes) || 0;
    var safety = parseFloat(c.submitSafetyMinutes);
    submitSafetyMinutes = isFinite(safety) && safety >= 1 ? safety : 3;
    minConfidence = parseFloat(c.minConfidence);
    if (!isFinite(minConfidence)) minConfidence = 0.6;
    if (!enabled) return;

    if (isExamPreviewPage()) {
      log("检测到考试整卷预览页, 等待题目渲染...");
      showStatus("考试:等待题目加载...", 0);
      if (!examStartAt) examStartAt = Date.now();
      waitForQuestions(30).then(function () {
        var questions = parseQuestions();
        log("解析到 " + questions.length + " 道题");
        showStatus("考试:解析到 " + questions.length + " 题,查询答案...", 0);
        return queryAnswers(questions).then(function (resp) {
          var results = (resp && resp.results) || [];
          var fromBank = 0, fromAI = 0;
          results.forEach(function (r) {
            if (r.source === "bank") fromBank++;
            else if (r.source === "ai") fromAI++;
          });
          if (resp && resp.results && resp.results.aiConfigured === false && fromBank < questions.length) {
            showStatus("⚠ 题库未命中且AI接口未配置,无法自动作答(点扩展图标→答题设置)", 0);
          } else {
            showStatus("答案就绪:题库 " + fromBank + " 题 / AI " + fromAI + " 题", 0);
          }
          fillAll(questions, results);
        });
      }).catch(function (e) {
        log("流程失败:", e && e.message);
        showStatus("考试流程失败: " + (e && e.message || "未知"), 8000);
      });
    } else if (isExamStartPage()) {
      // 优先进入整卷预览(可一次填完); 若无预览按钮则逐题作答
      showStatus("检测到考试,准备进入整卷预览...", 0);
      waitForElement("a.completeBtn", 15).then(function (btn) {
        var text = (btn.textContent || "").replace(/\s/g, "");
        if (text.indexOf("整卷预览") >= 0 || text.indexOf("预览") >= 0) {
          log("进入整卷预览...");
          showStatus("进入整卷预览...", 0);
          btn.click();
        } else {
          answerCurrentPageQuestion();
        }
      }).catch(function () {
        answerCurrentPageQuestion();
      });
    } else if (isExamViewPage()) {
      showStatus("检测到考试结果页,收割答案中...", 0);
      harvestAnswers();
    }
  });

  // ---------- 等待工具 ----------
  function waitForElement(selector, seconds) {
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      var timer = setInterval(function () {
        attempts++;
        var el = document.querySelector(selector);
        if (el && el.offsetParent !== null) {
          clearInterval(timer);
          resolve(el);
          return;
        }
        if (attempts > seconds * 2) {
          clearInterval(timer);
          reject(new Error("等待 " + selector + " 超时"));
        }
      }, 500);
    });
  }

  function waitForQuestions(seconds) {
    return new Promise(function (resolve, reject) {
      var attempts = 0, lastCount = -1, stable = 0;
      var timer = setInterval(function () {
        attempts++;
        var count = document.querySelectorAll(".singleQuesId, .questionLi").length;
        if (count > 0 && count === lastCount) {
          stable++;
          if (stable >= 2) { clearInterval(timer); resolve(); return; }
        } else {
          stable = 0;
          lastCount = count;
        }
        if (attempts > seconds * 2) {
          clearInterval(timer);
          if (count > 0) resolve();
          else reject(new Error("题目未渲染"));
        }
      }, 500);
    });
  }

  // ---------- 解析 ----------
  function parseQuestions() {
    var qs = [];
    document.querySelectorAll(".singleQuesId, .questionLi").forEach(function (q) {
      var h3 = q.querySelector("h3.mark_name, .mark_name");
      var rawStem = h3 ? h3.textContent : "";
      var stem = decodeText(rawStem).replace(/\s+/g, " ").trim();
      var type = /判断/.test(stem) ? "judge" : (/多选/.test(stem) ? "multi" : "single");
      var options = [];
      q.querySelectorAll(".stem_answer .answerBg").forEach(function (div) {
        var span = div.querySelector(".num_option");
        var p = div.querySelector(".answer_p");
        if (!span && !p) return;
        options.push({
          letter: span ? (span.getAttribute("data") || span.textContent.trim()) : "",
          text: p ? decodeText(p.textContent).trim() : ""
        });
      });
      qs.push({
        id: q.getAttribute("data") || q.id,
        num: qs.length + 1,
        type: type,
        stem: stem,
        options: options,
        container: q
      });
    });
    return qs;
  }

  // ---------- 查询答案(background: 题库优先, 未命中走AI) ----------
  function queryAnswers(questions) {
    return new Promise(function (resolve) {
      var payload = questions.map(function (q) {
        return { id: q.id, num: q.num, type: q.type, stem: q.stem, options: q.options };
      });
      chrome.runtime.sendMessage({ type: "ANSWER_QUERY", questions: payload }, function (resp) {
        if (chrome.runtime.lastError || !resp) {
          log("查询答案失败:", chrome.runtime.lastError && chrome.runtime.lastError.message);
          resolve({ results: [] });
          return;
        }
        resolve(resp);
      });
    });
  }

  // ---------- 填充 ----------
  // 考试页选项点击即自动保存(saveSingleSelect/addChoice), 判断题 data 属性为 true/false
  // 策略: 有答案就填(不看置信度); 无答案/填充失败 -> 随机兜底, 不留空
  // 节奏: 逐题串行, 题间1.5~3秒随机, 同题选项间0.4~0.9秒;
  //       每次点击后验证选中状态(check_answer), 未更新自动重试一次(修复点击过快状态丢失)
  function fillOneAsync(q, answer, fast) {
    return new Promise(function (resolve) {
      var divs = Array.from(q.container.querySelectorAll(".stem_answer .answerBg"));
      var clicked = [];
      var i = 0;
      function step() {
        if (i >= divs.length) {
          if (clicked.length) log("Q" + q.num + " 填充: " + clicked.join(","));
          resolve();
          return;
        }
        var div = divs[i++];
        var span = div.querySelector(".num_option");
        var p = div.querySelector(".answer_p");
        var data = span ? (span.getAttribute("data") || "") : "";
        var text = p ? decodeText(p.textContent).trim() : "";
        var want = answer.some(function (ans) {
          var A = String(ans == null ? "" : ans).trim();
          if (!A) return false;
          if (A === data || A === text) return true;
          if (data === "true" && normalizeJudge(A) === "对") return true;
          if (data === "false" && normalizeJudge(A) === "错") return true;
          var normText = normalizeJudge(text);
          if (normText && normText === normalizeJudge(A)) return true;
          if (A.length > 1 && text.length > 1 && (text.indexOf(A) >= 0 || A.indexOf(text) >= 0)) return true;
          return false;
        });
        var has = !!(span && /check_answer/.test(span.className));
        if (want === has) {
          setTimeout(step, 30);
          return;
        }
        div.click();
        clicked.push(data || text);
        // 点击后验证选中状态是否更新, 未更新重试一次
        setTimeout(function () {
          var span2 = div.querySelector(".num_option");
          var hasNow = !!(span2 && /check_answer/.test(span2.className));
          if (want !== hasNow) {
            log("Q" + q.num + " 选项 " + (data || text) + " 状态未更新, 重试点击");
            div.click();
          }
          setTimeout(step, fast ? 80 : rand(400, 900));
        }, fast ? 80 : 300);
      }
      step();
    });
  }

  // ---------- 考试剩余时间 ----------
  // 优先解析页面可见倒计时("X' Y''"), 其次隐藏字段remainTime(秒); 无计时返回null
  function getRemainTime() {
    try {
      var m = (document.body.innerText || "").match(/(\d+)\s*'\s*(\d+)\s*''/);
      if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      m = (document.body.innerText || "").match(/(\d+)\s*分\s*(\d+)\s*秒/);
      if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      var el = document.getElementById("remainTime");
      if (el && el.value && isFinite(parseFloat(el.value))) return parseFloat(el.value);
    } catch (e) {}
    return null;
  }

  // ---------- 开考时间 ----------
  // 优先取考试页表单的enterPageTime(进入考试的毫秒时间戳), 取不到退回扩展加载时刻
  function getExamStartTime() {
    try {
      var el = document.getElementById("enterPageTime");
      if (el && el.value && isFinite(parseFloat(el.value)) && parseFloat(el.value) > 1e12) {
        return parseFloat(el.value);
      }
    } catch (e) {}
    return examStartAt || Date.now();
  }

  // 最晚交卷安全边际(秒): 距考试结束剩余不足此值时强制交卷
  function getSafetySec() {
    return Math.max(60, submitSafetyMinutes * 60);
  }

  function fmtSec(s) {
    if (s === null || s === undefined || !isFinite(s)) return "?";
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60);
    return m > 0 ? (m + "分" + (s % 60) + "秒") : (s + "秒");
  }

  // 最快交卷时间(秒, 从开考算起): 配置了固定分钟则用之, 否则按题数自动(每题15秒, 最少3分钟)
  function getMinSubmitSec(n) {
    if (minSubmitMinutes > 0) return minSubmitMinutes * 60;
    return Math.max(180, n * 15);
  }

  function fillAll(questions, results) {
    var notes = [];
    var idx = 0;
    function findResult(q) {
      for (var i = 0; i < results.length; i++) {
        if (String(results[i].id) === String(q.id)) return results[i];
      }
      return null;
    }
    function next() {
      if (idx >= questions.length) {
        afterFill(questions, notes);
        return;
      }
      var q = questions[idx];
      var r = findResult(q);
      var answer = (r && r.answer && r.answer.length) ? r.answer : null;
      // 时间紧张(剩余不足安全边际)时切换极速模式: 跳过题间延迟
      var remain = getRemainTime();
      var fast = (remain !== null && remain < getSafetySec());
      var delay = fast ? 50 : (idx === 0 ? 500 : rand(1500, 3000));
      setTimeout(function () {
        function proceed() {
          // 填充验证: 无任何选中 -> 随机兜底, 不留空
          var sel = Array.from(q.container.querySelectorAll(".stem_answer .num_option"))
            .filter(function (s) { return /check_answer/.test(s.className); });
          if (sel.length === 0) {
            var divs = Array.from(q.container.querySelectorAll(".stem_answer .answerBg"));
            var count = q.type === "multi" ? Math.min(2, divs.length) : 1;
            var shuffled = divs.slice().sort(function () { return Math.random() - 0.5; });
            for (var k = 0; k < count; k++) shuffled[k].click();
            notes.push("Q" + q.num + "(" + (answer ? "答案不匹配" : "AI无答案") + ",随机选择)");
          }
          idx++;
          showStatus("已作答 " + idx + "/" + questions.length + " 题" +
            (notes.length ? " " + notes.slice(0, 2).join("、") : "") +
            (fast ? " ⚠时间紧张,加速中" : ""), 0);
          next();
        }
        if (answer) {
          fillOneAsync(q, answer, fast).then(proceed);
        } else {
          proceed();
        }
      }, delay);
    }
    next();
  }

  function afterFill(questions, notes) {
    if (afterFill.done) return;
    afterFill.done = true;
    log("作答完成。备注: " + (notes.join("、") || "无"));
    showStatus("已作答 " + questions.length + "/" + questions.length + " 题" +
      (notes.length ? " " + notes.slice(0, 2).join("、") : ""), 0);
    if (autoSubmit) {
      scheduleSubmit(questions);
    } else {
      showStatus("答题完成,请手动交卷", 0);
      log("等待用户手动交卷");
    }
  }

  // ---------- 交卷时间控制 ----------
  // 最快: 距开考(enterPageTime)不足"最快交卷时间"则倒计时等待(模拟合理用时);
  // 最晚: 考试剩余时间不足安全边际(默认3分钟, 可配置)则立即交卷, 等待期间持续监控
  function scheduleSubmit(questions) {
    var elapsedSec = (Date.now() - getExamStartTime()) / 1000;
    var minSec = getMinSubmitSec(questions.length);
    var remain = getRemainTime();
    var safetySec = getSafetySec();

    if (remain !== null && remain < safetySec) {
      log("考试剩余仅 " + fmtSec(remain) + ", 立即交卷");
      showStatus("⚠ 考试剩余时间不足,立即交卷!", 0);
      triggerSubmit();
      return;
    }
    var waitSec = minSec - elapsedSec;
    if (waitSec > 5) {
      log("距开考 " + fmtSec(elapsedSec) + ", 最快交卷时间 " + fmtSec(minSec) +
        ", 等待 " + fmtSec(waitSec) + " 后交卷");
      waitAndSubmit(waitSec);
    } else {
      showStatus("答题完成,自动交卷中...", 0);
      setTimeout(triggerSubmit, 3000);
    }
  }

  function waitAndSubmit(waitSec) {
    var endAt = Date.now() + waitSec * 1000;
    var iv = setInterval(function () {
      var left = (endAt - Date.now()) / 1000;
      var remain = getRemainTime();
      // 剩余时间逼近安全边际 -> 立即交卷
      if (remain !== null && remain < getSafetySec()) {
        clearInterval(iv);
        log("等待期间考试剩余时间降至 " + fmtSec(remain) + ", 立即交卷");
        showStatus("⚠ 考试时间将尽,提前交卷!", 0);
        triggerSubmit();
        return;
      }
      if (left <= 0) {
        clearInterval(iv);
        showStatus("答题完成,自动交卷中...", 0);
        triggerSubmit();
        return;
      }
      showStatus("答题完成," + fmtSec(left) + "后自动交卷(考试剩余 " + fmtSec(remain) + ")", 0);
    }, 5000);
  }

  // ---------- 交卷 ----------
  function triggerSubmit() {
    // 整卷预览页/答题页的交卷按钮
    var btn = null;
    var all = document.querySelectorAll("a, button");
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || "").replace(/\s/g, "");
      if (t === "交卷" && all[i].offsetParent !== null) { btn = all[i]; break; }
    }
    if (!btn) { log("未找到交卷按钮"); showStatus("⚠ 未找到交卷按钮,请手动交卷", 0); return; }
    btn.click();
    log("已点击交卷, 等待确认弹窗...");
    showStatus("已点击交卷,处理确认弹窗...", 0);
    // 确认弹窗结构待真实交卷时核实, 先做通用处理
    setTimeout(function () {
      var ok = findConfirmOk();
      if (ok) {
        ok.click();
        log("已确认交卷");
        showStatus("考试已交卷 ✓", 10000);
      } else {
        log("未检测到确认弹窗(可能已直接交卷或需手动确认)");
        showStatus("未检测到确认弹窗,请检查是否需手动确认", 8000);
      }
    }, 1000);
  }

  function findConfirmOk() {
    var candidates = document.querySelectorAll(
      "#confirmSubWin a, .AlertCon a, .popDiv a, [class*=confirm] a, [class*=Confirm] a"
    );
    for (var i = 0; i < candidates.length; i++) {
      var t = (candidates[i].textContent || "").replace(/\s/g, "");
      if ((t === "确定" || t === "提交" || t === "确认") && candidates[i].offsetParent !== null) {
        return candidates[i];
      }
    }
    return null;
  }

  // ---------- 逐题模式兜底(无整卷预览按钮的考试) ----------
  function answerCurrentPageQuestion() {
    if (!examStartAt) examStartAt = Date.now();
    waitForQuestions(10).then(function () {
      var questions = parseQuestions();
      if (questions.length !== 1) return;
      var q = questions[0];
      log("逐题模式: Q" + q.num);
      return queryAnswers(questions).then(function (resp) {
        var r = (resp && resp.results || [])[0];
        if (r && r.answer && r.answer.length && (r.confidence || 0) >= minConfidence) {
          fillOne(q, r.answer);
          // 答案随"下一题"导航保存
          setTimeout(function () {
            var next = document.querySelector(".nextDiv .jb_btn_92, .jb_btn_92");
            if (next) next.click();
          }, 800);
        } else {
          log("本题无可用答案, 停止自动作答");
        }
      });
    }).catch(function () {});
  }

  // ---------- 结果页收割 ----------
  function harvestAnswers() {
    var entries = [];
    document.querySelectorAll(".singleQuesId, .questionLi").forEach(function (q) {
      var h3 = q.querySelector("h3.mark_name, .mark_name");
      var stem = h3 ? decodeText(h3.textContent).replace(/\s+/g, " ").trim() : "";
      var key = normalizeStem(stem);
      if (!key) return;

      var answerText = "";
      // 策略1: "正确答案: X" 文本
      q.querySelectorAll("*").forEach(function (el) {
        if (el.children.length > 0) return;
        var t = decodeText(el.textContent || "");
        var m = t.match(/正确答案[:：]\s*([A-Za-z\u5bf9\u9519]+)\s/);
        if (m && !answerText) answerText = m[1];
      });
      // 策略2: 标记为正确的选项
      if (!answerText) {
        var marked = [];
        q.querySelectorAll(".stem_answer .num_option").forEach(function (span) {
          if (/answer(right|Right)|right.*answer|ansright|correct/i.test(span.className)) {
            marked.push(span.getAttribute("data") || span.textContent.trim());
          }
        });
        if (marked.length) answerText = marked.join("");
      }
      if (answerText) {
        var answer = [];
        for (var ch of answerText) {
          if (/[A-D]/.test(ch)) answer.push(ch);
          else if (ch === "对" || ch === "true") answer.push("对");
          else if (ch === "错" || ch === "false") answer.push("错");
        }
        if (answer.length) {
          entries.push({
            key: key,
            question: {
              stem: stem,
              options: Array.from(q.querySelectorAll(".stem_answer .answer_p")).map(function (p) {
                return decodeText(p.textContent).trim();
              })
            },
            answer: answer,
            source: "harvest",
            confidence: 1
          });
        }
      }
    });

    if (entries.length) {
      chrome.runtime.sendMessage({ type: "BANK_SAVE", entries: entries }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          var reason = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (resp && resp.error) || "无响应";
          log("入库失败: " + reason);
          showStatus("题库入库失败: " + reason, 8000);
          return;
        }
        log("收割完成,入库 " + resp.saved + " 题");
        showStatus("收割完成,入库 " + resp.saved + " 题 ✓", 10000);
      });
    } else {
      log("结果页未解析出正确答案(可能未公布)");
      showStatus("结果页无可收割答案(可能未公布)", 8000);
    }
  }
})();
