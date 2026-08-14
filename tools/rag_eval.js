/**
 * 檢索層邊界校準 — AI 劇場 EV Drama Studio
 *
 * 角色顧問只能回答知識庫涵蓋的問題，超出範圍必須拒答（簡報 P15 風險因應）。
 * 這支腳本用一組標註過的提問，檢查 RAG.isAnswerable() 的門檻是否同時做到：
 *   1. 職域內提問全部答得出來（不能過度保守而變成什麼都不回答）
 *   2. 離題提問全部擋下來（不能為了看起來聰明而硬答）
 *
 * 執行：node tools/rag_eval.js
 */
const path = require('path');
const RAG = require(path.join(__dirname, '..', 'docs', 'js', 'rag.js'));
const KB = require(path.join(__dirname, '..', 'docs', 'data', 'knowledge.json'));

RAG.index(KB.chunks);

/** 職域內：使用者真的會問、知識庫也答得出來的問題 */
const IN_DOMAIN = [
  '過年回南部會不會卡在充電站',
  '一週要充幾次電',
  '換一顆電池要多少錢',
  '電池會不會衰退',
  '電池容量多大',
  '保養費真的比較便宜嗎',
  '充電要充多久',
  '外面有幾個充電站可以用',
  '家裡沒有充電樁怎麼辦',
  '電動車要繳牌照稅嗎',
  'TOYOTA 有在賣電動車嗎',
  'TOYOTA 的電車技術跟得上嗎',
  '一年到底可以省多少錢',
  '續航里程有多少',
  '快充要多少錢一度',
  '為什麼那麼多人不買電動車',
];

/** 離題：知識庫沒有涵蓋，必須拒答並轉真人 */
const OUT_OF_DOMAIN = [
  '你們有賣機車嗎',
  '今天天氣如何',
  '幫我訂一個便當',
  '你可以幫我寫程式嗎',
  '總統是誰',
  '推薦台南好吃的牛肉湯',
  '我想買房子貸款怎麼算',
  '幫我翻譯這句英文',
];

let pass = 0, fail = 0;
const rows = [];

const check = (q, shouldAnswer) => {
  const hits = RAG.retrieve(q, 3);
  const ok = RAG.isAnswerable(hits) === shouldAnswer;
  const top = hits[0];
  rows.push({
    q,
    期望: shouldAnswer ? '回答' : '拒答',
    實際: RAG.isAnswerable(hits) ? '回答' : '拒答',
    分數: top ? top.score : 0,
    覆蓋率: top ? top.coverage : 0,
    命中: top ? top.chunk.id : '—',
    結果: ok ? '✓' : '✗',
  });
  ok ? pass++ : fail++;
};

IN_DOMAIN.forEach((q) => check(q, true));
OUT_OF_DOMAIN.forEach((q) => check(q, false));

console.table(rows);
console.log(`\n知識庫 ${KB.chunks.length} 則｜測試 ${pass + fail} 題｜通過 ${pass}｜失敗 ${fail}`);

if (fail > 0) {
  console.error('\n門檻未通過校準，請調整 rag.js 的 isAnswerable()。');
  process.exit(1);
}
console.log('邊界校準通過：職域內全數作答，離題全數拒答。');
