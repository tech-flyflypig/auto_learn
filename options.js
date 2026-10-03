var $ = function (id) { return document.getElementById(id); };

var CONFIG_KEY = "cx_answer_config";
var BANK_KEY = "cx_bank";

function loadConfig() {
  chrome.storage.local.get([CONFIG_KEY, BANK_KEY], function (d) {
    var c = d[CONFIG_KEY] || {};
    $("aiBaseUrl").value = c.aiBaseUrl || "";
    $("aiApiKey").value = c.aiApiKey || "";
    $("aiModel").value = c.aiModel || "";
    $("autoSubmit").checked = c.autoSubmit !== false;
    $("minSubmitMinutes").value = isFinite(parseFloat(c.minSubmitMinutes)) ? c.minSubmitMinutes : 0;
    $("submitSafetyMinutes").value = isFinite(parseFloat(c.submitSafetyMinutes)) && parseFloat(c.submitSafetyMinutes) >= 1 ? c.submitSafetyMinutes : 3;
    var bank = d[BANK_KEY] || {};
    $("bankCount").textContent = Object.keys(bank).length + " 题";
  });
}

function showStatus(text, ok) {
  var el = $("status");
  el.textContent = text;
  el.className = ok ? "ok" : "err";
}

$("btnSave").addEventListener("click", function () {
  var config = {
    aiBaseUrl: $("aiBaseUrl").value.trim(),
    aiApiKey: $("aiApiKey").value.trim(),
    aiModel: $("aiModel").value.trim() || "gpt-4o-mini",
    autoSubmit: $("autoSubmit").checked,
    minSubmitMinutes: parseFloat($("minSubmitMinutes").value) || 0,
    submitSafetyMinutes: Math.max(1, parseFloat($("submitSafetyMinutes").value) || 3)
  };
  chrome.storage.local.set({ [CONFIG_KEY]: config }, function () {
    // 为自定义 AI 接口域名申请跨域权限(service worker fetch 需要)
    if (config.aiBaseUrl && /^https?:\/\//.test(config.aiBaseUrl)) {
      try {
        var origin = new URL(config.aiBaseUrl).origin + "/*";
        chrome.permissions.request({ origins: [origin] }).then(function () {
          showStatus("已保存", true);
        });
      } catch (e) {
        showStatus("已保存（接口地址格式异常，未申请跨域权限）", false);
      }
    } else {
      showStatus("已保存", true);
    }
    refreshBankCount();
  });
});

$("btnTest").addEventListener("click", function () {
  // 先保存再测试, 保证测试的是当前输入的配置
  $("btnTest").disabled = true;
  $("testResult").textContent = "测试中...";
  var config = {
    aiBaseUrl: $("aiBaseUrl").value.trim(),
    aiApiKey: $("aiApiKey").value.trim(),
    aiModel: $("aiModel").value.trim() || "gpt-4o-mini"
  };
  chrome.storage.local.set({ [CONFIG_KEY]: Object.assign(loadCurrent(), config) }, function () {
    chrome.runtime.sendMessage({ type: "AI_TEST" }, function (resp) {
      $("btnTest").disabled = false;
      if (chrome.runtime.lastError || !resp) {
        $("testResult").textContent = "失败: " + (chrome.runtime.lastError ? chrome.runtime.lastError.message : "无响应");
        return;
      }
      if (resp.ok) {
        $("testResult").textContent = "连接成功，示例答案: " + JSON.stringify(resp.sample);
      } else {
        $("testResult").textContent = "失败: " + (resp.error || "未知错误");
      }
    });
  });
});

function loadCurrent() {
  return {
    aiBaseUrl: $("aiBaseUrl").value.trim(),
    aiApiKey: $("aiApiKey").value.trim(),
    aiModel: $("aiModel").value.trim(),
    autoSubmit: $("autoSubmit").checked,
    minSubmitMinutes: parseFloat($("minSubmitMinutes").value) || 0,
    submitSafetyMinutes: Math.max(1, parseFloat($("submitSafetyMinutes").value) || 3)
  };
}

$("btnClear").addEventListener("click", function () {
  if (!confirm("确定清空本地题库？此操作不可恢复。")) return;
  chrome.runtime.sendMessage({ type: "BANK_CLEAR" }, function () {
    refreshBankCount();
    showStatus("题库已清空", true);
  });
});

$("btnExport").addEventListener("click", function () {
  chrome.runtime.sendMessage({ type: "BANK_EXPORT" }, function (resp) {
    if (!resp || !resp.bank) return;
    var blob = new Blob([JSON.stringify(resp.bank, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cx_bank_" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

$("btnImport").addEventListener("click", function () { $("fileImport").click(); });

$("fileImport").addEventListener("change", function () {
  var file = this.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var bank = JSON.parse(reader.result);
      var entries = Object.keys(bank).map(function (k) {
        return Object.assign({ key: k }, bank[k]);
      });
      chrome.runtime.sendMessage({ type: "BANK_SAVE", entries: entries }, function (resp) {
        refreshBankCount();
        showStatus("导入 " + (resp && resp.saved || 0) + " 题", true);
      });
    } catch (e) {
      showStatus("导入失败: 文件不是合法JSON", false);
    }
  };
  reader.readAsText(file);
});

function refreshBankCount() {
  chrome.runtime.sendMessage({ type: "BANK_STATS" }, function (resp) {
    if (resp) $("bankCount").textContent = resp.count + " 题";
  });
}

loadConfig();
