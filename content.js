(function () {
  var enabled = false;
  var monitoring = false;
  var playbackSpeed = 1;

  chrome.storage.local.get(["autoPlayEnabled", "playbackSpeed"], function (result) {
    enabled = !!result.autoPlayEnabled;
    playbackSpeed = parseFloat(result.playbackSpeed) || 1;
    if (enabled) startWork();
  });

  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.autoPlayEnabled) {
      enabled = !!changes.autoPlayEnabled.newValue;
      if (enabled && !monitoring) startWork();
    }
    if (changes.playbackSpeed) {
      playbackSpeed = parseFloat(changes.playbackSpeed.newValue) || 1;
      applySpeedToAll();
    }
  });

  function applySpeedToAll() {
    var videos = document.querySelectorAll("video, audio");
    videos.forEach(function (el) {
      el.playbackRate = playbackSpeed;
      el.defaultPlaybackRate = playbackSpeed;
    });
    window.postMessage({ type: "CX_SET_SPEED", speed: playbackSpeed }, "*");
  }

  function startWork() {
    monitoring = true;
    var isTop = false;
    try { isTop = (window.self === window.top); } catch (e) {}
    if (isTop) {
      initTopFrame();
    } else {
      initIframe();
    }
  }

  function initTopFrame() {
    var quizBusy = false;
    var quizTimeout = null;
    var QUIZ_TIMEOUT_MS = 3 * 60 * 1000; // 测验最长等待3分钟, 防卡死

    // ---------- 活动看门狗 ----------
    // 视频心跳(每5秒)/测验消息/CX_NEXT 都会刷新 lastActivity;
    // 只有连续12秒无任何活动才跳下一节。 修复: 视频中途弹窗重置一次性
    // videoFound 标志导致 12 秒后误跳的 bug。
    var lastActivity = 0;
    var lastVideoT = -1;
    var lastVideoTTime = 0;
    var watchdog = null;
    var lastNavAt = 0;

    function markActivity() {
      lastActivity = Date.now();
    }

    function startWatchdog() {
      if (watchdog) return;
      watchdog = setInterval(function () {
        if (!enabled || quizBusy) return;
        var idleMs = Date.now() - lastActivity;
        if (idleMs < 12000) return;
        // 视频心跳持续但进度冻结超过180秒(卡死), 也跳过
        var frozenMs = Date.now() - lastVideoTTime;
        if (lastVideoT >= 0 && frozenMs > 180000) {
          console.log("[CX Auto] Video stalled (no progress 180s), moving on...");
          lastVideoT = -1;
          goToNextSection();
          markActivity();
          return;
        }
        console.log("[CX Auto] No activity for " + Math.floor(idleMs / 1000) + "s, attempting skip...");
        goToNextSection();
        markActivity();
      }, 3000);
    }

    // ---------- 状态浮窗(右上角, 实时显示扩展在做什么) ----------
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
      var bar = ensureStatusBar();
      bar.textContent = "⚡ " + text;
      bar.style.opacity = "1";
      if (statusTimer) clearTimeout(statusTimer);
      if (stickyMs !== 0) {
        statusTimer = setTimeout(function () { bar.style.opacity = "0"; }, stickyMs || 6000);
      }
    }

    function scheduleSkipCheck() {
      // 兼容旧调用点: 重置活动时间, 由看门狗统一判定
      markActivity();
    }

    function enterQuizMode() {
      quizBusy = true;
      markActivity();
      if (quizTimeout) clearTimeout(quizTimeout);
      quizTimeout = setTimeout(function () {
        if (quizBusy) {
          console.log("[CX Auto] Quiz timeout, moving on...");
          quizBusy = false;
          goToNextSection();
          markActivity();
        }
      }, QUIZ_TIMEOUT_MS);
    }

    function leaveQuizMode() {
      quizBusy = false;
      if (quizTimeout) clearTimeout(quizTimeout);
      // 延迟跳转: 留时间给提交的表单POST完成, 避免销毁iframe中断提交
      setTimeout(function () {
        if (enabled) goToNextSection();
      }, 5000);
      markActivity();
    }

    window.addEventListener("message", function (event) {
      if (!event.data) return;
      var t = event.data.type;
      if (t === "CX_NEXT" && enabled) {
        // 去重: 8秒内的重复CX_NEXT忽略(修复视频结束双发导致连跳两节)
        if (Date.now() - lastNavAt < 8000) {
          console.log("[CX Auto] Duplicate CX_NEXT ignored.");
          return;
        }
        lastNavAt = Date.now();
        console.log("[CX Auto] Received CX_NEXT, navigating...");
        goToNextSection();
        markActivity();
      }
      if (t === "CX_VIDEO_FOUND") {
        markActivity();
        // 视频心跳: 携带播放进度, 用于卡死检测
        if (typeof event.data.t === "number") {
          if (event.data.t !== lastVideoT) {
            lastVideoT = event.data.t;
            lastVideoTTime = Date.now();
          }
        } else {
          lastVideoT = -1; // 无进度信息时不做卡死检测
        }
        showStatus("视频播放中" + (playbackSpeed > 1 ? "(" + playbackSpeed + "x)" : ""), 0);
      }
      if (t === "CX_QUIZ_DETECTED" && enabled) {
        console.log("[CX Auto] Quiz detected, holding navigation...");
        showStatus("检测到测验,准备答题...", 0);
        markActivity();
        enterQuizMode();
      }
      if (t === "CX_QUIZ_DONE" && enabled) {
        console.log("[CX Auto] Quiz finished, navigating...");
        showStatus(event.data.phase === "submitted" ? "测验已提交 ✓" : "测验完成", 8000);
        leaveQuizMode();
      }
      if (t === "CX_QUIZ_PROGRESS") {
        markActivity();
        var p = event.data;
        var text = "";
        if (p.phase === "decoding") text = "破解反爬字体中...";
        else if (p.phase === "parsed") text = "测验:解析到 " + p.total + " 题,查询答案...";
        else if (p.phase === "answering") text = "答案就绪:题库 " + (p.fromBank || 0) + " 题 / AI " + (p.fromAI || 0) + " 题";
        else if (p.phase === "filled") text = "已作答 " + p.total + "/" + p.total + " 题" + (p.detail ? " " + p.detail : "");
        else if (p.phase === "submitting") text = "答题完成,自动提交中...";
        else if (p.phase === "wait-manual") text = "⚠ 有题未答已暂停提交: " + (p.detail || "请手动检查");
        else if (p.phase === "no-ai") text = "⚠ 题库未命中且AI接口未配置,无法自动作答(点扩展图标→答题设置)";
        if (text) showStatus(text, 0);
        console.log("[CX Auto] Quiz progress:", p.phase, p.total || "");
      }
    });

    new MutationObserver(function () {
      if (!enabled) return;
      var popNext = document.querySelector(".popDiv .nextChapter");
      if (popNext && popNext.offsetParent !== null) {
        console.log("[CX Auto] Pop dialog detected, clicking next...");
        popNext.click();
        markActivity();
      }
    }).observe(document.body, { childList: true, subtree: true });

    markActivity();
    startWatchdog();
    console.log("[CX Auto] Top frame ready (watchdog mode).");
  }

  function initIframe() {
    // 测验页由 quiz.js 接管, 这里只处理视频/文档类小节
    if (/\/work\//i.test(location.href)) {
      console.log("[CX Auto] Iframe is a work page, quiz.js will handle it.");
      return;
    }
    // 视频模块iframe: 加载即上报, 让顶层提前知道有视频在加载(慢加载保护)
    var isVideoModule = /\/ananas\/modules\/video\//i.test(location.href);
    if (isVideoModule) {
      window.top.postMessage({ type: "CX_VIDEO_FOUND" }, "*");
    }
    console.log("[CX Auto] Iframe: looking for video...");
    var attempts = 0;
    var finder = setInterval(function () {
      attempts++;
      var video = document.querySelector("video");
      if (video) {
        clearInterval(finder);
        console.log("[CX Auto] Video found, monitoring...");
        window.top.postMessage({ type: "CX_VIDEO_FOUND" }, "*");
        handleVideo(video);
      } else if (attempts > 30) { // 30秒: 慢加载视频保护
        clearInterval(finder);
        tryClickNext();
      }
    }, 1000);
  }

  function tryClickNext() {
    if (!enabled) return;
    var btn = document.getElementById("prevNextFocusNext") ||
      document.querySelector(".nextChapter") ||
      document.querySelector(".orientationright") ||
      document.querySelector(".next_btn");
    if (btn) {
      console.log("[CX Auto] No video found, clicking next button in iframe...");
      btn.click();
    }
  }

  function handleVideo(video) {
    if (video.ended) {
      notifyNext();
      return;
    }
    function tryPlay() {
      if (enabled && video.paused && !video.ended) {
        video.muted = true;
        video.play().catch(function () {});
      }
    }
    // 心跳: 每5秒向顶层报告存在+进度(顶层据此判断视频仍在播放, 不会误跳)
    var heartbeat = setInterval(function () {
      if (!video.isConnected) {
        clearInterval(heartbeat);
        return;
      }
      if (video.ended) {
        clearInterval(heartbeat);
        return;
      }
      try {
        window.top.postMessage({ type: "CX_VIDEO_FOUND", t: video.currentTime }, "*");
      } catch (e) {}
    }, 5000);
    tryPlay();
    setTimeout(tryPlay, 1000);
    setTimeout(tryPlay, 3000);
    setTimeout(applySpeedToAll, 500);
    video.addEventListener("ended", function () {
      if (heartbeat) clearInterval(heartbeat);
      if (enabled) {
        console.log("[CX Auto] Video ended");
        notifyNext();
      }
    });
    // 加载失败也视为完成, 避免卡死
    video.addEventListener("error", function () {
      if (heartbeat) clearInterval(heartbeat);
      if (enabled) {
        console.log("[CX Auto] Video error, moving on...");
        notifyNext();
      }
    });
    video.addEventListener("play", function () {
      setTimeout(applySpeedToAll, 200);
    });
    video.addEventListener("pause", function () {
      setTimeout(tryPlay, 500);
    });
  }

  function notifyNext() {
    window.top.postMessage({ type: "CX_NEXT" }, "*");
  }

  // ---------- 章节导航 ----------
  // 两级导航: ①卡片级(.prev_ul的学习目标/视频/章节测验标签, 部分课程的测验是卡片而非独立小节)
  //           ②小节级(#coursetree的.posCatalog_select, 点击span.posCatalog_name触发getTeacherAjax)
  function goToNextSection() {
    if (!enabled) return;
    // ① 卡片级: 当前小节内还有下一张卡片(如 视频 -> 章节测验)
    var prevUl = document.querySelector(".prev_ul");
    if (prevUl) {
      var lis = Array.from(prevUl.querySelectorAll("li"));
      var activeIdx = -1;
      lis.forEach(function (li, i) {
        if (/active/.test(li.className || "")) activeIdx = i;
      });
      if (activeIdx >= 0 && activeIdx < lis.length - 1) {
        var nextCard = lis[activeIdx + 1];
        var cardLink = nextCard.querySelector(".prev_white") || nextCard.querySelector("span") || nextCard;
        console.log("[CX Auto] Going to next card:", (nextCard.textContent || "").trim().slice(0, 20));
        cardLink.click();
        return;
      }
    }
    // ② 小节级
    var tree = document.querySelector("#coursetree");
    var iframe = document.querySelector("iframe#iframe");
    if (tree && iframe) {
      var m = (iframe.src || "").match(/knowledgeid=(\d+)/i);
      var currentId = m ? m[1] : null;
      var items = Array.from(tree.querySelectorAll(".posCatalog_select")).filter(function (div) {
        return /^cur\d+$/.test(div.id || "");
      });
      var idx = -1;
      if (currentId) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].id === "cur" + currentId) { idx = i; break; }
        }
      }
      if (idx === -1) {
        goToNextChapter();
        return;
      }
      if (idx >= 0 && idx < items.length - 1) {
        var next = items[idx + 1];
        var link = next.querySelector(".posCatalog_name") || next.querySelector("span");
        if (link) {
          console.log("[CX Auto] Going to next section:", (next.textContent || "").trim().slice(0, 30));
          link.click();
          return;
        }
      }
      console.log("[CX Auto] Already at last section of visible tree.");
    }
    goToNextChapter();
  }

  // 旧版页面兜底逻辑(保留原有实现)
  function goToNextChapter() {
    var current =
      document.querySelector(".curChapter") ||
      document.querySelector(".currents") ||
      document.querySelector(".pomark");
    if (current) {
      var items = Array.from(
        document.querySelectorAll(".chapter_unit .chapter_small li, .prev_ul li, .chapter_item")
      );
      var currentItem = current.closest("li") || current;
      var idx = items.indexOf(currentItem);
      if (idx >= 0 && idx < items.length - 1) {
        var next = items[idx + 1];
        var link = next.querySelector("a") || next;
        link.click();
        return;
      }
    }
    var nextBtn =
      document.querySelector(".orientationright") ||
      document.querySelector(".next_btn") ||
      document.querySelector("#prevNextFocusNext");
    if (nextBtn) {
      nextBtn.click();
    }
  }
})();
