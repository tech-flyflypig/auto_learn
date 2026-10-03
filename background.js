// 超星自动答题 background service worker
// 职责: 1) 代理 AI 接口调用(规避CORS, key不进页面) 2) 本地题库读写 3) 配置连通性测试
"use strict";

var BANK_KEY = "cx_bank";
var CONFIG_KEY = "cx_answer_config";

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === "ANSWER_QUERY") {
    handleAnswerQuery(msg.questions || [])
      .then(sendResponse)
      .catch(function (e) { sendResponse({ results: [], error: e.message }); });
    return true; // 异步响应
  }

  if (msg.type === "BANK_SAVE") {
    saveToBank(msg.entries || [])
      .then(function (n) { sendResponse({ ok: true, saved: n }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  if (msg.type === "BANK_STATS") {
    chrome.storage.local.get(BANK_KEY, function (d) {
      var bank = d[BANK_KEY] || {};
      sendResponse({ count: Object.keys(bank).length });
    });
    return true;
  }

  if (msg.type === "BANK_CLEAR") {
    chrome.storage.local.remove(BANK_KEY, function () { sendResponse({ ok: true }); });
    return true;
  }

  if (msg.type === "BANK_EXPORT") {
    chrome.storage.local.get(BANK_KEY, function (d) {
      sendResponse({ bank: d[BANK_KEY] || {} });
    });
    return true;
  }

  if (msg.type === "AI_TEST") {
    testAIConnection()
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
});

// ---------- 题库 ----------
function normalizeStem(s) {
  return String(s || "")
    .replace(/【.*?】/g, "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[0-9]+[\.、]/g, "")
    .replace(/[。．.,，、;；:：?？!！()（）\[\]{}"'’‘“”\-—_\/\\·…]/g, "")
    .toLowerCase();
}

async function saveToBank(entries) {
  var d = await chrome.storage.local.get(BANK_KEY);
  var bank = d[BANK_KEY] || {};
  var n = 0;
  for (var e of entries) {
    if (!e.key) e.key = normalizeStem(e.question && e.question.stem);
    if (!e.key || !e.answer || !e.answer.length) continue;
    var old = bank[e.key];
    // 收割来的真实答案优先级最高, 不被 AI 答案覆盖
    if (old && old.source === "harvest" && e.source !== "harvest") continue;
    bank[e.key] = {
      question: e.question,
      answer: e.answer,
      source: e.source || "unknown",
      confidence: e.confidence || 1,
      updated: Date.now()
    };
    n++;
  }
  await chrome.storage.local.set({ [BANK_KEY]: bank });
  return n;
}

// ---------- 答案查询: 题库优先, 未命中走 AI ----------
async function handleAnswerQuery(questions) {
  var results = [];
  var d = await chrome.storage.local.get([BANK_KEY, CONFIG_KEY]);
  var bank = d[BANK_KEY] || {};
  var config = d[CONFIG_KEY] || {};
  var misses = [];

  for (var q of questions) {
    var key = normalizeStem(q.stem);
    var hit = key ? bank[key] : null;
    if (hit) {
      results.push({ id: q.id, answer: hit.answer, source: "bank", confidence: 1 });
    } else {
      misses.push(q);
      results.push({ id: q.id, answer: [], source: "pending", confidence: 0 });
    }
  }

  if (misses.length && config.aiBaseUrl && config.aiApiKey) {
    try {
      var ai = await queryAI(misses, config);
      var byId = {};
      (ai.answers || []).forEach(function (a) { byId[String(a.id)] = a; });
      results.forEach(function (r) {
        var a = byId[String(r.id)];
        if (a && a.answer && a.answer.length) {
          r.answer = a.answer;
          r.source = "ai";
          r.confidence = typeof a.confidence === "number" ? a.confidence : 0.5;
        }
      });
    } catch (e) {
      console.warn("[CX BG] AI查询失败:", e && e.message);
    }
  } else if (misses.length && (!config.aiBaseUrl || !config.aiApiKey)) {
    console.warn("[CX BG] 有 " + misses.length + " 题未命中题库, 但AI接口未配置");
    results.aiConfigured = false;
  }

  return { results: results };
}

// ---------- AI 调用 (OpenAI 兼容格式) ----------
var AI_SYSTEM_PROMPT = "你是专业的课程答题助手。用户给出题目列表,你选出正确答案。" +
  "严格只返回JSON,不要任何解释、markdown代码块或其他文字。" +
  "single=单选题,answer为1个选项字母如[\"A\"];multi=多选题,answer为多个字母;" +
  "judge=判断题,answer为[\"对\"]或[\"错\"]。" +
  "返回格式:{\"answers\":[{\"id\":题目id,\"answer\":[\"A\"],\"confidence\":0.95}]}。" +
  "id必须原样返回。confidence为0到1的把握值。即使没有把握,也必须给出你认为最可能的答案并如实降低confidence,严禁返回空答案。";

async function queryAI(questions, config) {
  var payload = questions.map(function (q) {
    return {
      id: q.id,
      type: q.type,
      stem: q.stem,
      options: q.options.map(function (o) { return o.letter + "." + o.text; })
    };
  });
  var url = String(config.aiBaseUrl).replace(/\/+$/, "") + "/chat/completions";
  var res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + config.aiApiKey
    },
    body: JSON.stringify({
      model: config.aiModel || "gpt-4o-mini",
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: "题目列表:\n" + JSON.stringify(payload) }
      ],
      temperature: 0.2
    })
  });
  if (!res.ok) {
    var t = await res.text().catch(function () { return ""; });
    throw new Error("AI接口HTTP " + res.status + ": " + t.slice(0, 200));
  }
  var data = await res.json();
  var text = (data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content) || "";
  // 剥掉可能的 markdown 代码块包裹
  text = text.replace(/```(?:json)?/g, "").trim();
  var parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.answers)) throw new Error("AI返回格式异常");
  return parsed;
}

async function testAIConnection() {
  var d = await chrome.storage.local.get(CONFIG_KEY);
  var config = d[CONFIG_KEY] || {};
  if (!config.aiBaseUrl || !config.aiApiKey) {
    return { ok: false, error: "请先填写接口地址和API Key" };
  }
  var probe = [{ id: "test", type: "judge", stem: "测试连接:1+1=2,对吗?", options: [{ letter: "A", text: "对" }, { letter: "B", text: "错" }] }];
  var r = await queryAI(probe, config);
  var a = (r.answers || [])[0];
  if (a && a.answer && a.answer.length) return { ok: true, sample: a.answer };
  return { ok: false, error: "AI返回了空答案" };
}
