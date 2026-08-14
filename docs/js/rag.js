/**
 * 檢索層 — AI 劇場 EV Drama Studio
 *
 * 角色顧問的每一句回答都必須綁定知識庫來源，這一層負責「找出該引用哪幾則」。
 *
 * 初賽版採用中文字元 bigram + 關鍵字加權的詞彙檢索（BM25 精神的簡化版），
 * 不依賴任何外部服務，離線即可執行，評審可自行驗證檢索結果。
 * 決賽版將此層替換為向量檢索（pgvector / Pinecone），對外介面 retrieve() 不變。
 *
 * 對外介面：
 *   RAG.index(chunks)               建立索引
 *   RAG.retrieve(query, topK)       回傳 [{chunk, score, matched}]
 *   RAG.getById(id)                 取單一 chunk（供 UI 展開來源）
 */

const RAG = (() => {
  'use strict';

  let CHUNKS = [];
  let INDEX = [];          // [{id, terms: Map<term, tf>, len}]
  let DF = new Map();      // term -> document frequency

  const STOPWORDS = new Set([
    '的', '了', '是', '在', '我', '你', '他', '會', '要', '有', '和', '就',
    '不', '也', '很', '嗎', '呢', '吧', '啊', '喔', '欸', '這', '那', '個',
    '一', '請問', '請', '可以', '什麼', '怎麼', '如果',
  ]);

  /** 中文以字元 bigram 切詞，英數以單字切詞。兩者合併作為檢索詞。 */
  function tokenize(text) {
    const terms = [];
    const cleaned = String(text).replace(/[\s,，。、；：！？「」（）()]+/g, '');

    // 英數與百分比數字（如 bZ4X、150kW、71.4、66%）
    const latin = String(text).toLowerCase().match(/[a-z0-9][a-z0-9.%]*/g) || [];
    terms.push(...latin);

    // 中文 unigram + bigram
    const han = cleaned.match(/[一-鿿]/g) || [];
    for (let i = 0; i < han.length; i++) {
      if (!STOPWORDS.has(han[i])) terms.push(han[i]);
      if (i < han.length - 1) terms.push(han[i] + han[i + 1]);
    }
    return terms;
  }

  function termFreq(terms) {
    const m = new Map();
    terms.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
    return m;
  }

  /** 建立索引。keywords 欄位權重加倍，因為那是人工標註的主題詞。 */
  function index(chunks) {
    CHUNKS = chunks;
    DF = new Map();
    INDEX = chunks.map((c) => {
      const body = tokenize(`${c.title} ${c.text} ${c.category}`);
      const kw = (c.keywords || []).flatMap((k) => tokenize(k));
      const terms = termFreq([...body, ...kw, ...kw]); // keywords 計兩次
      terms.forEach((_, t) => DF.set(t, (DF.get(t) || 0) + 1));
      return { id: c.id, terms, len: body.length + kw.length * 2 };
    });
    return INDEX.length;
  }

  /**
   * 檢索。分數 = Σ over 查詢詞 [ tf 正規化 × idf ]，長度以平均長度校正。
   * 回傳的 matched 供 UI 顯示「命中了哪些詞」，讓檢索過程可解釋。
   */
  function retrieve(query, topK = 3) {
    if (!INDEX.length) return [];
    const qTerms = [...new Set(tokenize(query))];
    const N = INDEX.length;
    const avgLen = INDEX.reduce((s, d) => s + d.len, 0) / N;

    const scored = INDEX.map((doc) => {
      let score = 0;
      const matched = [];
      qTerms.forEach((t) => {
        const tf = doc.terms.get(t);
        if (!tf) return;
        const idf = Math.log(1 + (N - (DF.get(t) || 0) + 0.5) / ((DF.get(t) || 0) + 0.5));
        // 長詞（bigram）較能代表語意，給予額外權重
        const lenBoost = t.length > 1 ? 1.6 : 1;
        score += (tf / (tf + 1.2 * (0.25 + 0.75 * doc.len / avgLen))) * idf * lenBoost;
        matched.push(t);
      });
      return { chunk: CHUNKS.find((c) => c.id === doc.id), score, matched };
    });

    // 覆蓋率＝查詢詞被整個知識庫命中的比例（對語料整體，不是對單一 chunk）。
    // 單看分數不足以判斷該不該回答：「你們有賣機車嗎」會因為「有賣」命中而拿到不低的
    // 分數，但「機車」完全不在語料裡。分數負責排序，覆蓋率負責守邊界，兩者並用。
    const known = qTerms.filter((t) => DF.has(t)).length;
    const coverage = Number((known / Math.max(1, qTerms.length)).toFixed(3));

    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((r) => ({ ...r, score: Number(r.score.toFixed(3)), coverage }));
  }

  /**
   * 是否有足夠依據回答。門檻由 tools/rag_eval.js 的 24 題標註集校準：
   *   職域內 16 題：分數最低 6.43、覆蓋率最低 0.59
   *   離題   8 題：分數最高 6.46、覆蓋率最高 0.50
   * 分數本身無法分離兩者（6.43 < 6.46），覆蓋率才是有效的判別條件。
   *
   * 覆蓋率門檻 0.55 落在 0.50 與 0.59 之間，間距不寬。詞彙檢索的邊界本來就只能做到
   * 這個程度；決賽版改用向量檢索後，語意相似度可取代這組經驗門檻。
   * 修改知識庫後務必重跑 rag_eval.js 確認門檻仍成立。
   */
  function isAnswerable(hits) {
    const top = hits[0];
    if (!top) return false;
    return top.score >= 6 && top.coverage >= 0.55;
  }

  const getById = (id) => CHUNKS.find((c) => c.id === id) || null;
  const all = () => CHUNKS;

  return { index, retrieve, isAnswerable, getById, all, tokenize };
})();

if (typeof module !== 'undefined') module.exports = RAG;
