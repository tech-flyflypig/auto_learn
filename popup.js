var $ = function (id) { return document.getElementById(id); };

var CONFIG_KEY = "cx_answer_config";

var toggle = $("toggle");
var speed = $("speed");
var answerToggle = $("answerToggle");
var statusEl = $("status");
var cfgCache = {};

function refreshStatus() {
  var play = toggle.checked;
  var answer = answerToggle.checked;
  var aiReady = !!(cfgCache.aiBaseUrl && cfgCache.aiApiKey);
  var parts = [];
  parts.push(play ? "播放:开" : "播放:关");
  if (answer) {
    parts.push("答题:开" + (aiReady ? "(AI已配置)" : "(AI未配置,仅题库)"));
  } else {
    parts.push("答题:关");
  }
  parts.push("测验+考试");
  statusEl.textContent = parts.join(" ");
}

chrome.storage.local.get(
  ["autoPlayEnabled", "playbackSpeed", "autoAnswerEnabled", CONFIG_KEY],
  function (result) {
    toggle.checked = !!result.autoPlayEnabled;
    speed.value = result.playbackSpeed || "1";
    answerToggle.checked = !!result.autoAnswerEnabled;
    cfgCache = result[CONFIG_KEY] || {};
    refreshStatus();
  }
);

// 设置窗口保存后,实时刷新弹窗里的状态显示
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes[CONFIG_KEY]) {
    cfgCache = changes[CONFIG_KEY].newValue || {};
    refreshStatus();
  }
});

function openSettings() {
  chrome.windows.create({
    url: "settings.html",
    type: "popup",
    width: 500,
    height: 680
  });
}

toggle.addEventListener("change", function () {
  chrome.storage.local.set({ autoPlayEnabled: toggle.checked });
  refreshStatus();
});

speed.addEventListener("change", function () {
  chrome.storage.local.set({ playbackSpeed: speed.value });
});

answerToggle.addEventListener("change", function () {
  chrome.storage.local.set({ autoAnswerEnabled: answerToggle.checked });
  if (answerToggle.checked && !(cfgCache.aiBaseUrl && cfgCache.aiApiKey)) {
    statusEl.textContent = "答题:开(AI未配置,请填写接口并保存)";
    openSettings();
  } else {
    refreshStatus();
  }
});

$("openSettings").addEventListener("click", openSettings);
