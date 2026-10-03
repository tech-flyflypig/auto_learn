// 验证考试倒计时解析与交卷时间计算
var tests = ["117' 55''", "94' 49''", "3' 05''", "剩余 12分34秒", "无时间"];
tests.forEach(function (t) {
  var m = t.match(/(\d+)\s*'\s*(\d+)\s*''/);
  if (m) { console.log(JSON.stringify(t), "->", parseInt(m[1]) * 60 + parseInt(m[2]), "秒"); return; }
  m = t.match(/(\d+)\s*分\s*(\d+)\s*秒/);
  if (m) { console.log(JSON.stringify(t), "->", parseInt(m[1]) * 60 + parseInt(m[2]), "秒"); return; }
  console.log(JSON.stringify(t), "-> null");
});

function getMin(n, cfg) { if (cfg > 0) return cfg * 60; return Math.max(180, n * 15); }
console.log("50题自动:", getMin(50, 0) / 60, "分钟");
console.log("4题自动:", getMin(4, 0) / 60, "分钟");
console.log("50题固定5分:", getMin(50, 5) / 60, "分钟");

// 交卷决策模拟
function decide(elapsed, remain, minSec, SAFETY) {
  if (remain !== null && remain < SAFETY) return "立即交卷(时间不足)";
  var wait = minSec - elapsed;
  if (wait > 5) return "等待" + Math.round(wait) + "秒后交卷";
  return "3秒后交卷";
}
console.log("场景1(1分钟做完,剩余充足):", decide(60, 7000, 750, 180));
console.log("场景2(做完,剩余150秒):", decide(60, 150, 750, 180));
console.log("场景3(等了足够久):", decide(800, 6000, 750, 180));
console.log("场景4(无计时器):", decide(60, null, 750, 180));
