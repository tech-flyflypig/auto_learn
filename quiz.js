// 超星自动答题模块 —— 注入到测验 iframe (doHomeWorkNew / viewHomeWorkNew)
// 流程: URL识别 -> 立即上报DETECTED(阻止顶层跳章) -> 等题目渲染 -> 解析+字体解码
//       -> 查题库/AI -> 填充 -> (可选)自动提交 -> 结果页收割 -> 上报DONE
(function () {
  "use strict";

  var enabled = false;
  var autoSubmit = false;
  var minConfidence = 0.6;
  var submitted = false;

  // ---------- 工具 ----------
  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[CX Quiz]");
    console.log.apply(console, args);
  }

  // 合并静态映射表(cxsecret_map.js)与运行时解码表(font_decode.js, 应对字体轮换)
  function decodeText(s) {
    if (!s) return "";
    var runtime = window.__CX_RUNTIME_MAP || {};
    var out = "";
    for (var ch of String(s)) {
      var cp = ch.codePointAt(0);
      out += CX_FONT_MAP[cp] || runtime[cp] || ch;
    }
    return out;
  }

  // 等待运行时字体解码就绪(最多20秒, 解码需渲染比对大量字形)
  function waitFontDecode() {
    if (!window.__CX_FONT_READY) return Promise.resolve();
    return Promise.race([
      window.__CX_FONT_READY,
      new Promise(function (r) { setTimeout(r, 20000); })
    ]);
  }

  // 题干归一化: 去题型标记/空白/标点, 作为题库主键
  function normalizeStem(s) {
    return decodeText(s)
      .replace(/【.*?】/g, "")
      .replace(/[\s\u3000]/g, "")
      .replace(/[0-9]+[\.、]/g, "")
      .replace(/[。．.,，、;；:：?？!！()（）\[\]{}"'’‘“”\-—_\/\\·…]/g, "")
      .toLowerCase();
  }

  function postTop(type, data) {
    try {
      window.top.postMessage(Object.assign({ type: type }, data || {}), "*");
    } catch (e) {}
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  // ---------- 页面识别 ----------
  function isWorkAnswerPage() {
    return /\/work\/doHomeWorkNew/i.test(location.href);
  }
  function isWorkViewPage() {
    // 提交后的结果/查看页
    return /\/work\/(viewHomeWorkNew|selectWorkQuestionYiPiYue|workDetail)/i.test(location.href);
  }

  // ---------- 入口 ----------
  if (isWorkAnswerPage()) {
    // 第一时间上报, 抢在顶层跳章定时器之前
    postTop("CX_QUIZ_DETECTED", { phase: "loading", url: location.href.slice(0, 120) });
    chrome.storage.local.get(["autoAnswerEnabled", "cx_answer_config"], function (cfg) {
      enabled = !!cfg.autoAnswerEnabled;
      var c = cfg.cx_answer_config || {};
      autoSubmit = c.autoSubmit !== false; // 默认自动提交, 配置页可关
      minConfidence = parseFloat(c.minConfidence);
      if (!isFinite(minConfidence)) minConfidence = 0.6;
      if (enabled) {
        log("自动答题已启用, 等待题目渲染...");
        postTop("CX_QUIZ_PROGRESS", { phase: "decoding" });
        waitForQuestionsAndAnswer();
      } else {
        log("自动答题未启用, 仅上报测验存在");
      }
    });
  } else if (/\/ananas\/modules\/work\//i.test(location.href)) {
    // work包装层: 测验即将加载, 提前让顶层停止跳章计时(争取加载时间)
    postTop("CX_QUIZ_DETECTED", { phase: "wrapper" });
  } else if (isWorkViewPage()) {
    // 结果页: 收割正确答案
    chrome.storage.local.get(["autoAnswerEnabled"], function (cfg) {
      if (cfg.autoAnswerEnabled) {
        postTop("CX_QUIZ_DETECTED", { phase: "viewing" });
        waitForQuestions().then(harvestAnswers).catch(function (e) {
          log("收割失败:", e);
          postTop("CX_QUIZ_DONE");
        });
      }
    });
  }

  // ---------- 等待题目渲染 ----------
  function waitForQuestions() {
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      var lastCount = -1;
      var stable = 0;
      var timer = setInterval(function () {
        attempts++;
        var count = document.querySelectorAll(".singleQuesId").length;
        if (count > 0 && count === lastCount) {
          stable++;
          if (stable >= 2) { // 数量稳定两轮, 视为渲染完成
            clearInterval(timer);
            resolve();
            return;
          }
        } else {
          stable = 0;
          lastCount = count;
        }
        if (attempts > 40) { // 20秒超时
          clearInterval(timer);
          if (count > 0) resolve();
          else reject(new Error("题目未渲染"));
        }
      }, 500);
    });
  }

  // ---------- 解析题目 ----------
  function parseQuestions() {
    var qs = [];
    document.querySelectorAll(".singleQuesId").forEach(function (q) {
      var tiMu = q.querySelector(".TiMu");
      if (!tiMu) return;
      var fontLabel = tiMu.querySelector(".fontLabel");
      var rawStem = fontLabel ? fontLabel.textContent : "";
      var typeMark = (decodeText(rawStem).match(/【(.*?)】/) || [])[1] || "";
      var qtypeEl = q.querySelector("li[qtype]");
      var qtype = qtypeEl ? qtypeEl.getAttribute("qtype") : "";
      var type = qtype === "1" ? "multi" : (qtype === "3" ? "judge" : "single");
      var options = [];
      q.querySelectorAll("ul li").forEach(function (li) {
        var span = li.querySelector(".num_option_dx, .num_option");
        var a = li.querySelector("a.fl.after") || li.querySelector("a");
        if (!span && !a) return;
        options.push({
          letter: span ? (span.getAttribute("data") || span.textContent.trim()) : "",
          text: a ? decodeText(a.textContent).trim() : ""
        });
      });
      qs.push({
        id: q.getAttribute("data") || q.id,
        num: qs.length + 1,
        type: type,
        typeMark: typeMark,
        stem: decodeText(rawStem).replace(/【.*?】/, "").trim(),
        options: options,
        container: q
      });
    });
    return qs;
  }

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

  // 查询结果里带 aiConfigured=false 时, 提示用户配置AI
  function checkAIConfig(resp) {
    if (resp && resp.results && resp.results.aiConfigured === false) {
      postTop("CX_QUIZ_PROGRESS", { phase: "no-ai" });
      log("题库未命中且AI接口未配置, 无法自动作答");
    }
  }

  // ---------- 填充 ----------
  // 判断题答案归一化: 对/正确/√/true/是/A -> "对"; 错/×/x/false/否/B -> "错"
  function normalizeJudge(s) {
    s = String(s == null ? "" : s).trim().toLowerCase();
    if (["对", "正确", "√", "true", "是", "a", "t"].indexOf(s) >= 0) return "对";
    if (["错", "错误", "×", "x", "false", "否", "b", "f"].indexOf(s) >= 0) return "错";
    return null;
  }

  // 展开连写字母答案: ["ABC"] -> ["A","B","C"] (AI偶发的多选连写格式)
  function expandAnswers(answer) {
    var expanded = [];
    answer.forEach(function (ans) {
      var A = String(ans == null ? "" : ans).trim();
      if (/^[A-Da-d]{2,}$/.test(A)) {
        for (var ch of A.toUpperCase()) expanded.push(ch);
      } else {
        expanded.push(A);
      }
    });
    return expanded;
  }

  function fillOne(q, answer) {
    var clicked = [];
    var answers = expandAnswers(answer);
    q.container.querySelectorAll("ul li").forEach(function (li) {
      var span = li.querySelector(".num_option_dx, .num_option");
      var a = li.querySelector("a.fl.after");
      var dataAttr = span ? (span.getAttribute("data") || "") : "";
      var visibleLetter = span ? span.textContent.trim() : "";
      var text = a ? decodeText(a.textContent).trim() : "";
      var want = answers.some(function (ans) {
        var A = String(ans == null ? "" : ans).trim();
        if (!A) return false;
        if (A === dataAttr || A === visibleLetter || A === text) return true;
        // 判断题: 选项文本为"对/错"时, 各种答案写法互认
        var normText = normalizeJudge(text);
        if (normText && normText === normalizeJudge(A)) return true;
        if (A.length > 1 && text.length > 1 && (text.indexOf(A) >= 0 || A.indexOf(text) >= 0)) return true;
        return false;
      });
      var has = !!(span && (span.classList.contains("check_answer") ||
        span.classList.contains("check_answer_dx")));
      if (want !== has) {
        li.click();
        clicked.push(visibleLetter || dataAttr || text);
      }
    });
    if (clicked.length) log("Q" + q.num + " 填充: " + clicked.join(","));
    return clicked.length;
  }

  function getSelectionState(q) {
    var sel = [];
    q.container.querySelectorAll("ul li").forEach(function (li) {
      var span = li.querySelector(".num_option_dx, .num_option");
      if (span && (span.classList.contains("check_answer") ||
        span.classList.contains("check_answer_dx"))) {
        sel.push(span.getAttribute("data") || span.textContent.trim());
      }
    });
    return sel;
  }

  function fillAll(questions, results) {
    var filled = 0;
    var notes = []; // 记录低置信度/随机兜底的题(信息展示, 不再跳过)
    questions.forEach(function (q) {
      var r = null;
      for (var i = 0; i < results.length; i++) {
        if (String(results[i].id) === String(q.id)) { r = results[i]; break; }
      }
      var answer = (r && r.answer && r.answer.length) ? r.answer : null;
      var lowConf = !!(answer && (r.confidence || 0) < 0.6);
      // 题间随机延迟, 模拟人工作答节奏
      setTimeout(function (q, r, answer, lowConf) {
        if (answer) {
          fillOne(q, answer);
          if (lowConf) notes.push("Q" + q.num + "(低置信度" + (r.confidence || 0).toFixed(2) + ",按猜测作答)");
        }
        // 无答案 / 填充失败(答案与选项不匹配) -> 随机兜底, 不留空
        if (getSelectionState(q).length === 0) {
          randomFill(q);
          notes.push("Q" + q.num + "(" + (answer ? "答案不匹配" : "AI无答案") + ",随机选择)");
        }
        filled++;
        if (filled === questions.length) afterFill(questions, notes);
      }.bind(null, q, r, answer, lowConf), (q.num - 1) * rand(800, 2000));
    });
    // 兜底: 计数异常时也要收尾
    setTimeout(function () {
      if (filled === questions.length && !afterFill.done) {
        afterFill(questions, notes);
      }
    }, questions.length * 2200 + 500);
  }

  // 随机兜底: 单选/判断随机选1项, 多选随机选2项(保证可提交, 对错交给收割与重做)
  function randomFill(q) {
    var lis = Array.from(q.container.querySelectorAll("ul li"));
    if (!lis.length) return;
    var count = q.type === "multi" ? Math.min(2, lis.length) : 1;
    var shuffled = lis.slice().sort(function () { return Math.random() - 0.5; });
    for (var i = 0; i < count; i++) shuffled[i].click();
    log("Q" + q.num + " 随机兜底选择 " + count + " 项");
  }

  function afterFill(questions, notes) {
    if (afterFill.done) return;
    afterFill.done = true;
    log("作答完成。备注: " + (notes.join("、") || "无"));
    postTop("CX_QUIZ_PROGRESS", {
      phase: "filled", total: questions.length,
      detail: notes.slice(0, 3).join("、")
    });

    if (autoSubmit) {
      log("自动提交已开启, 3秒后提交...");
      postTop("CX_QUIZ_PROGRESS", { phase: "submitting" });
      setTimeout(triggerSubmit, 3000);
    } else {
      log("自动提交未开启, 等待用户手动提交");
    }
  }

  // ---------- 提交 ----------
  // 提交链路: 点.btnSubmit -> AJAX校验 -> toadd -> 顶层页面 workPop 弹窗(#popok=提交/#popno=取消)
  // 部分旧版页面弹窗在测验iframe内(#confirmSubWin), 两种都兼容
  function triggerSubmit() {
    if (submitted) return;
    var btn = document.querySelector(".btnSubmit.workBtnIndex") ||
      document.querySelector(".btnSubmit");
    if (!btn) { log("未找到提交按钮"); return; }
    btn.click();
    log("已点击提交, 等待确认弹窗...");
    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      var target = findConfirmButton();
      if (target) {
        clearInterval(timer);
        target.btn.click();
        submitted = true;
        log("已在" + target.scope + "层确认提交");
        postTop("CX_QUIZ_DONE", { phase: "submitted" });
        return;
      }
      if (attempts > 20) { // 10秒
        clearInterval(timer);
        log("确认弹窗未出现, 请手动提交");
      }
    }, 500);
  }

  function findConfirmButton() {
    // 优先: 顶层页面的 workPop 弹窗
    try {
      var topDoc = window.top.document;
      var pop = topDoc.getElementById("workpop");
      if (pop && pop.style.display !== "none" &&
        (pop.offsetParent !== null || pop.offsetHeight > 0)) {
        var ok = topDoc.getElementById("popok");
        if (ok) return { btn: ok, scope: "顶层" };
      }
    } catch (e) { /* 跨域时忽略 */ }
    // 兜底: 测验iframe内的确认弹窗
    var dlg = document.getElementById("confirmSubWin");
    if (dlg && dlg.offsetParent !== null) {
      var okBtn = findButtonByText(dlg, "确定") || findButtonByText(dlg, "确 定");
      if (okBtn) return { btn: okBtn, scope: "测验页" };
    }
    return null;
  }

  function findButtonByText(root, text) {
    var els = root.querySelectorAll("a, button, div, span");
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || "").replace(/\s/g, "");
      if (t === text && els[i].offsetParent !== null) return els[i];
    }
    return null;
  }

  // ---------- 结果页收割 ----------
  // 结果页结构(实测): .singleQuesId > .fontLabel(题干) + .myAnswer .answerCon(我的答案)
  //   + .CorrectOrNot .marking_dui(对勾) + .newAnswerScore .scoreNum(得分)
  // 得分为正/有对勾 => 我的答案即正确答案, 入库; 部分课程另显示"正确答案: X"文本
  function harvestAnswers() {
    var entries = [];
    document.querySelectorAll(".singleQuesId").forEach(function (q) {
      var fontLabel = q.querySelector(".fontLabel");
      if (!fontLabel) return;
      var stem = decodeText(fontLabel.textContent).replace(/【.*?】/, "").trim();
      var key = normalizeStem(stem);
      if (!key) return;

      var options = Array.from(q.querySelectorAll("ul li a.fl.after, .answerList a")).map(function (a) {
        return decodeText(a.textContent).trim();
      }).filter(Boolean);

      var answer = null;

      // 策略1: 我的答案 + 对勾/正得分 => 正确答案
      var answerCon = q.querySelector(".myAnswer .answerCon");
      var markingDui = q.querySelector(".CorrectOrNot .marking_dui");
      var scoreNum = q.querySelector(".newAnswerScore .scoreNum, .scoreNum");
      var score = scoreNum ? (parseFloat(scoreNum.textContent) || 0) : 0;
      if (answerCon && (markingDui || score > 0)) {
        var ansText = decodeText(answerCon.textContent).trim();
        answer = [];
        for (var ch of ansText) {
          if (/[A-D]/.test(ch)) answer.push(ch);
          else if (ch === "对" || ch === "√" || ch === "true") answer.push("对");
          else if (ch === "错" || ch === "×" || ch === "false") answer.push("错");
        }
      }

      // 策略2: 页面显式公布"正确答案: X"(答错时部分课程显示)
      if (!answer || !answer.length) {
        q.querySelectorAll("*").forEach(function (el) {
          if (el.children.length > 0 || answer) return;
          var t = decodeText(el.textContent || "");
          var m = t.match(/正确答案[:：]\s*([A-Za-z\u5bf9\u9519]+)/);
          if (m) {
            answer = [];
            for (var c of m[1]) {
              if (/[A-D]/.test(c)) answer.push(c);
              else if (c === "对" || c === "true") answer.push("对");
              else if (c === "错" || c === "false") answer.push("错");
            }
          }
        });
      }

      if (answer && answer.length) {
        entries.push({
          key: key,
          question: { stem: stem, options: options },
          answer: answer,
          source: "harvest",
          confidence: 1
        });
      }
    });

    if (entries.length) {
      chrome.runtime.sendMessage({ type: "BANK_SAVE", entries: entries }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          var reason = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (resp && resp.error) || "无响应";
          log("入库失败: " + reason);
          return;
        }
        log("收割完成, 入库 " + resp.saved + " 题");
      });
    } else {
      log("结果页未解析出可入库的答案");
    }
  }

  // ---------- 主流程 ----------
  function waitForQuestionsAndAnswer() {
    return waitFontDecode().then(function () {
      return waitForQuestions();
    }).then(function () {
      var questions = parseQuestions();
      log("解析到 " + questions.length + " 道题");
      postTop("CX_QUIZ_PROGRESS", { phase: "parsed", total: questions.length });
      return queryAnswers(questions).then(function (resp) {
        checkAIConfig(resp);
        var results = (resp && resp.results) || [];
        var fromBank = 0, fromAI = 0;
        results.forEach(function (r) {
          if (r.source === "bank") fromBank++;
          else if (r.source === "ai") fromAI++;
        });
        postTop("CX_QUIZ_PROGRESS", { phase: "answering", fromBank: fromBank, fromAI: fromAI });
        log("答案返回: " + JSON.stringify(results.map(function (r) {
          return { id: r.id, answer: r.answer, src: r.source, conf: r.confidence };
        })));
        fillAll(questions, results);
      });
    }).catch(function (e) {
      log("流程失败:", e && e.message);
      postTop("CX_QUIZ_DONE", { phase: "error", error: e && e.message });
    });
  }
})();
