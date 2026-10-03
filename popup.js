var toggle = document.getElementById("toggle");
var speed = document.getElementById("speed");
var answerToggle = document.getElementById("answerToggle");
var statusEl = document.getElementById("status");

function refreshStatus() {
  chrome.storage.local.get(["autoPlayEnabled", "autoAnswerEnabled", "cx_answer_config"], function (r) {
    var play = !!r.autoPlayEnabled;
    var answer = !!r.autoAnswerEnabled;
    var cfg = r.cx_answer_config || {};
    var aiReady = !!(cfg.aiBaseUrl && cfg.aiApiKey);
    var parts = [];
    parts.push(play ? "播放:开" : "播放:关");
    if (answer) {
      parts.push("答题:开" + (aiReady ? "(AI已配置)" : "(AI未配置,仅题库)"));
    } else {
      parts.push("答题:关");
    }
    parts.push("测验+考试");
    statusEl.textContent = parts.join(" ");
  });
}

chrome.storage.local.get(["autoPlayEnabled", "playbackSpeed", "autoAnswerEnabled"], function (result) {
  toggle.checked = !!result.autoPlayEnabled;
  speed.value = result.playbackSpeed || "1";
  answerToggle.checked = !!result.autoAnswerEnabled;
  refreshStatus();
});

toggle.addEventListener("change", function () {
  chrome.storage.local.set({ autoPlayEnabled: toggle.checked });
  refreshStatus();
});

speed.addEventListener("change", function () {
  chrome.storage.local.set({ playbackSpeed: speed.value });
});

answerToggle.addEventListener("change", function () {
  chrome.storage.local.set({ autoAnswerEnabled: answerToggle.checked });
  if (answerToggle.checked) {
    chrome.storage.local.get(["cx_answer_config"], function (r) {
      var cfg = r.cx_answer_config || {};
      if (!cfg.aiBaseUrl || !cfg.aiApiKey) {
        statusEl.textContent = "答题:开(AI未配置,请点下方设置)";
        chrome.runtime.openOptionsPage();
      } else {
        refreshStatus();
      }
    });
  } else {
    refreshStatus();
  }
});

document.getElementById("openOptions").addEventListener("click", function () {
  chrome.runtime.openOptionsPage();
});
