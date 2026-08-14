/**
 * 轉電劇場 EV Drama Studio — 原型主程式
 *
 * 三幕之間共用同一份 state，這是本方案最關鍵的體驗設計：
 * 使用者在第一幕點的選擇，會決定第二幕的開場白、第三幕的焦慮消除卡、第四幕的建議話術。
 * 觀眾不需要重新自我介紹 — 敘事連續性即由此 state 保證。
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nt = (n) => 'NT$ ' + Math.round(n).toLocaleString('zh-TW');

  let KB = null, DRAMA = null;

  /** 跨三幕共享的使用者狀態 —— 即簡報 P11「產出數據」欄位的實作 */
  const state = {
    startedAt: Date.now(),
    choice: null,          // 第一幕互動選擇（零方數據）
    persona: 'ahao',
    framesWatched: 0,
    turns: 0,
    citeCount: 0,
    concerns: new Map(),   // concern -> { count, emotion }
    profile: null,
    sim: null,
  };

  /* ================= 啟動 ================= */
  async function boot() {
    try {
      const [kb, dr] = await Promise.all([
        fetch('data/knowledge.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch('data/drama.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      ]);
      KB = kb; DRAMA = dr;
    } catch (e) {
      $('#boot').innerHTML = `<div class="err-banner">
        <b>資料載入失敗</b><br>
        瀏覽器的同源政策不允許以 <code>file://</code> 直接讀取 JSON。
        請改以本機伺服器開啟：<br><br>
        <code>cd docs &amp;&amp; python -m http.server 8000</code><br><br>
        然後瀏覽 <code>http://localhost:8000</code>。線上版本則不受此限制。
      </div>`;
      return;
    }

    RAG.index(KB.chunks);
    $('#app').hidden = false;
    initNav(); initReel(); initChat(); initSim(); initDrawers();
    renderObserver();
  }

  /* ================= 幕次切換 ================= */
  function initNav() {
    $$('#acts .act-tab').forEach((b) => b.addEventListener('click', () => goAct(+b.dataset.act)));
  }
  function goAct(i) {
    $$('#acts .act-tab').forEach((b) => b.classList.toggle('active', +b.dataset.act === i));
    $$('.act').forEach((s) => s.classList.toggle('active', +s.dataset.act === i));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ================= 第一幕：短劇播放器 ================= */
  let reelTimer = null, reelIdx = 0;

  function initReel() {
    const ep = DRAMA.episode;
    $('#epTitle').textContent = `EP1《${ep.title}》分鏡`;
    $('#epConcern').textContent = ep.concern;
    $('#hookQ').textContent = ep.hook;

    $('#segs').innerHTML = ep.frames.map(() => '<div class="seg"><i></i></div>').join('');
    $('#epFrames').innerHTML = ep.frames.map((f, i) =>
      `<li data-i="${i}"><b>${String(i + 1).padStart(2, '0')}</b><span>${esc(f.scene)}｜${esc(f.line)}</span></li>`).join('');

    $('#hookChoices').innerHTML = DRAMA.choices.map((c) =>
      `<button class="choice" data-id="${c.id}">${esc(c.label)}</button>`).join('');
    $$('#hookChoices .choice').forEach((b) =>
      b.addEventListener('click', () => pickChoice(b.dataset.id)));

    $('#btnReplay').addEventListener('click', () => playReel(0));
    $('#btnSkip').addEventListener('click', () => { stopReel(); showFrame(ep.frames.length - 1); showHook(); });

    playReel(0);
  }

  function stopReel() { clearTimeout(reelTimer); }

  function playReel(i) {
    stopReel();
    $('#reelHook').classList.remove('show');
    showFrame(i);
    const total = DRAMA.episode.frames.length;
    if (i >= total - 1) { showHook(); return; }
    reelTimer = setTimeout(() => playReel(i + 1), 3800);
  }

  function showFrame(i) {
    reelIdx = i;
    const f = DRAMA.episode.frames[i];
    $('#reelScene').textContent = f.scene;
    $('#reelSpeaker').textContent = f.speaker;
    $('#reelLine').textContent = f.line;
    $('#reelNote').textContent = f.note ? `（${f.note}）` : '';
    $('#reelIdx').textContent = `${i + 1} / ${DRAMA.episode.frames.length}`;

    $$('#segs .seg').forEach((s, k) => {
      s.classList.toggle('done', k <= i);
      s.classList.toggle('live', k === i);
    });
    $$('#epFrames li').forEach((li) => li.classList.toggle('on', +li.dataset.i === i));

    state.framesWatched = Math.max(state.framesWatched, i + 1);
    renderObserver();
  }

  function showHook() { $('#reelHook').classList.add('show'); }

  /** 劇末互動選擇 = 第一個零方數據，同時決定第二幕的開場 */
  function pickChoice(id) {
    const c = DRAMA.choices.find((x) => x.id === id);
    state.choice = c;
    bumpConcern(c.concern, 0.6);
    renderObserver();
    goAct(1);
    resetChat(c);
  }

  /* ================= 第二幕：角色顧問 ================= */
  function initChat() {
    $('#personaList').innerHTML = Object.entries(DRAMA.personas).map(([k, p]) => `
      <button class="persona ${k === state.persona ? 'on' : ''}" data-k="${k}">
        <span class="av">${esc(p.avatar)}</span>
        <span><span class="nm">${esc(p.name)}</span><span class="rl">${esc(p.role)}</span></span>
      </button>`).join('');
    $$('#personaList .persona').forEach((b) => b.addEventListener('click', () => {
      state.persona = b.dataset.k;
      $$('#personaList .persona').forEach((x) => x.classList.toggle('on', x === b));
      resetChat(state.choice, true);
    }));

    $('#quicks').innerHTML = DRAMA.questions.map((q) =>
      `<button class="quick" data-id="${q.id}">${esc(q.label)}</button>`).join('');
    $$('#quicks .quick').forEach((b) => b.addEventListener('click', () => {
      const q = DRAMA.questions.find((x) => x.id === b.dataset.id);
      pushMe(q.label); answerQuestion(q);
    }));

    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#chatInput').value.trim();
      if (!v) return;
      $('#chatInput').value = '';
      pushMe(v); askFreeText(v);
    });

    resetChat(null);
  }

  function resetChat(choice, keepScroll) {
    const p = DRAMA.personas[state.persona];
    const key = choice ? choice.id : 'charging';
    $('#chatLog').innerHTML = '';
    pushBot(p.openings[key], [], { instant: true });
    if (!keepScroll) $('#chatLog').scrollTop = 0;
  }

  function pushMe(text) {
    $('#chatLog').insertAdjacentHTML('beforeend',
      `<div class="msg me"><div class="bubble">${esc(text)}</div></div>`);
    scrollChat();
  }

  function pushBot(text, cites = [], opt = {}) {
    const p = DRAMA.personas[state.persona];
    const citeHtml = cites.length
      ? `<div class="cites">${cites.map((id) => {
          const c = RAG.getById(id);
          return c ? `<button class="cite" data-kb="${id}">📎 ${esc(c.title)}</button>` : '';
        }).join('')}</div>`
      : '';
    const cls = opt.refuse ? 'msg bot refuse' : 'msg bot';
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = `<div class="who">${esc(p.name)}</div>
      <div class="bubble">${opt.instant ? esc(text) + citeHtml : '<div class="typing"><i></i><i></i><i></i></div>'}</div>`;
    $('#chatLog').appendChild(el);
    scrollChat();

    if (!opt.instant) {
      setTimeout(() => {
        el.querySelector('.bubble').innerHTML = esc(text) + citeHtml;
        bindCites(el);
        scrollChat();
      }, 620);
    } else {
      bindCites(el);
    }
    state.citeCount += cites.length;
  }

  function bindCites(root) {
    root.querySelectorAll('.cite').forEach((b) =>
      b.addEventListener('click', () => openKb(b.dataset.kb)));
  }

  const scrollChat = () => { const l = $('#chatLog'); l.scrollTop = l.scrollHeight; };

  function answerQuestion(q) {
    const text = q.answers[state.persona];
    pushBot(text, q.cites);
    state.turns++;
    bumpConcern(q.concern, q.emotion);
    renderObserver();
  }

  /**
   * 自由提問：先以檢索層找出最相關的知識庫內容，
   * 再判斷是否落在已知問題範圍內。分數過低即拒答 —— 對應簡報 P15 風險因應
   * 「顧問回答限定於 RAG 知識庫範圍，拒答範圍外問題」。
   */
  function askFreeText(query) {
    const hits = RAG.retrieve(query, 3);
    const top = hits[0];

    if (!top || top.score < 3) {
      pushBot('這個問題超出我手上的資料範圍了，我不想隨口給你一個不確定的答案。'
            + '要不要我幫你轉給展間的業務？他手上有最新的型錄跟報價。', [], { refuse: true });
      state.turns++;
      renderObserver();
      return;
    }

    // 找出引用了該 chunk 的既有問題，沿用其人設化答案；找不到則直接引述知識庫內容
    const q = DRAMA.questions.find((x) => x.cites.includes(top.chunk.id));
    if (q) { answerQuestion(q); return; }

    pushBot(`${top.chunk.text}`, hits.map((h) => h.chunk.id));
    state.turns++;
    bumpConcern(top.chunk.category, 0.5);
    renderObserver();
  }

  function bumpConcern(name, emotion) {
    const cur = state.concerns.get(name) || { count: 0, emotion: 0 };
    state.concerns.set(name, { count: cur.count + 1, emotion: Math.max(cur.emotion, emotion) });
  }

  /* ================= 第三幕：數位分身 ================= */
  function initSim() {
    $('#fModel').innerHTML = Object.entries(TCO.VEHICLES).map(([k, v]) =>
      `<option value="${k}">${esc(v.label)}</option>`).join('');
    $('#fDest').innerHTML = Object.entries(TCO.DESTINATIONS).map(([k, v]) =>
      `<option value="${k}" ${k === 'tainan' ? 'selected' : ''}>${esc(v.label)}（單程 ${v.km} 公里）</option>`).join('');

    $('#fKm').addEventListener('input', (e) => $('#fKmVal').textContent = e.target.value);
    $('#fTrip').addEventListener('input', (e) => $('#fTripVal').textContent = e.target.value);
    $$('#fHome button').forEach((b) => b.addEventListener('click', () => {
      $$('#fHome button').forEach((x) => x.classList.toggle('on', x === b));
    }));

    $('#btnSim').addEventListener('click', runSim);
    $('#btnHandoff').addEventListener('click', () => { renderSheet(); goAct(3); });
  }

  function readForm() {
    return {
      model: $('#fModel').value,
      dailyKm: +$('#fKm').value,
      homeCharging: $('#fHome button.on').dataset.v === '1',
      longTripsPerYear: +$('#fTrip').value,
      destination: $('#fDest').value,
    };
  }

  function runSim() {
    const input = readForm();
    const r = TCO.calculate(input);
    const cal = TCO.chargingCalendar(input);
    const trip = TCO.longTripPlan(input);
    state.profile = input;
    state.sim = { r, cal, trip };

    $('#saveNum').textContent = nt(r.savingThreeYear);
    $('#savePct').textContent = `三年降低 ${r.savingPct}%｜年均省 ${nt(r.savingAnnual)}｜年里程 ${r.annualKm.toLocaleString()} 公里`;
    $('#scopeNote').textContent = r.scopeNote;
    $('#chart').innerHTML = renderChart(r);

    $('#wkGrid').innerHTML = cal.week.map((d) =>
      `<div class="${d.charge ? 'c' : ''}">${d.day}</div>`).join('');
    $('#wkVerdict').textContent = cal.verdict
      + `（單次充電可行駛約 ${cal.sessionKm} 公里，每週里程 ${cal.weeklyKm} 公里）`;

    $('#tripDest').textContent = `抵達 ${trip.destination.label}・剩 ${trip.arrivalSoc}%`;
    $('#tripVerdict').textContent = trip.verdict
      + `　滿電可用里程約 ${trip.usableRangeKm} 公里（已保留 10% 抵達餘裕）。`;

    $('#relief').innerHTML = buildRelief(r, cal, trip);
    $('#report').classList.add('show');
    renderObserver();
    $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** 三年成本結構堆疊圖（手繪 SVG，無外部圖表函式庫） */
  function renderChart(r) {
    const rows = [
      { label: `${r.vehicle.label}（燃油）`, d: r.threeYear.gas },
      { label: 'bZ4X（純電）', d: r.threeYear.ev },
    ];
    const max = Math.max(...rows.map((x) => x.d.total)) || 1;
    const W = 600, PAD = 4, BW = W - PAD * 2;
    const parts = [
      { k: 'energy', c: '#4aa8ff', n: '能源' },
      { k: 'maint',  c: '#ffb547', n: '保養' },
      { k: 'tax',    c: '#98a2ad', n: '稅費' },
    ];

    let svg = `<svg viewBox="0 0 ${W} 190" style="width:100%;height:auto" role="img" aria-label="三年成本結構對照">`;
    rows.forEach((row, i) => {
      const y = 26 + i * 78;
      svg += `<text x="${PAD}" y="${y - 8}" fill="#e8eaed" font-size="13" font-weight="700">${esc(row.label)}</text>`;
      svg += `<text x="${W - PAD}" y="${y - 8}" fill="#e8eaed" font-size="14" font-weight="800" text-anchor="end">${nt(row.d.total)}</text>`;
      let x = PAD;
      parts.forEach((p) => {
        const w = (row.d[p.k] / max) * BW;
        if (w > 0) {
          svg += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="34" fill="${p.c}" rx="3"/>`;
          if (w > 62) svg += `<text x="${(x + w / 2).toFixed(1)}" y="${y + 22}" fill="#0b0d10" font-size="11.5" font-weight="800" text-anchor="middle">${nt(row.d[p.k]).replace('NT$ ', '')}</text>`;
        }
        x += w;
      });
    });
    parts.forEach((p, i) => {
      const lx = PAD + i * 92;
      svg += `<rect x="${lx}" y="172" width="11" height="11" fill="${p.c}" rx="2"/>`;
      svg += `<text x="${lx + 17}" y="182" fill="#98a2ad" font-size="11.5">${p.n}</text>`;
    });
    return svg + '</svg>';
  }

  /** 焦慮消除卡：只回應「使用者實際表達過」的顧慮，不是通用清單 */
  function buildRelief(r, cal, trip) {
    const items = [];
    const has = (n) => state.concerns.has(n);

    if (has('充電便利性') || has('充電') || cal) {
      items.push({ lb: '充電便利性', tx: cal.verdict });
    }
    if (has('里程焦慮') || trip.stops === 0) {
      items.push({ lb: '里程焦慮', tx: trip.verdict });
    }
    if (has('持有成本') || has('成本')) {
      items.push({ lb: '持有成本', tx: `以你的用車型態，三年營運成本可降低 ${r.savingPct}%（${nt(r.savingThreeYear)}）。其中定保費用差距來自 CDP 同車齡層實際消費紀錄。` });
    }
    if (has('電池壽命') || has('電池更換費用') || has('電池')) {
      items.push({ lb: '電池', tx: '動力電池保固 10 年或 20 萬公里，容量門檻 70%；保固期內低於門檻由原廠依條款處理。' });
    }
    if (!items.length) {
      items.push({ lb: '尚未取得顧慮標籤', tx: '回到第一幕選擇你在意的問題，或在第二幕與角色顧問對話，這張卡會依你實際表達過的顧慮生成。' });
    }
    return items.map((it) => `<div class="relief-item"><span class="tick">✓</span>
      <span><span class="lb">${esc(it.lb)}</span><span class="tx">${esc(it.tx)}</span></span></div>`).join('');
  }

  /* ================= 第四幕：交接單 ================= */
  const TALK_TRACK = {
    '電池更換費用': '優先提供電池保固條款正本與原廠認證中古車回購方案，用書面條款回應，不要用口頭保證。',
    '電池壽命': '帶客戶看電池健康度報告與 10 年 / 20 萬公里保固條款，強調容量門檻 70% 的定義。',
    '里程焦慮': '直接調出客戶的長途路線試算，現場演示服務區充電時間，並安排一次長途試乘。',
    '充電便利性': '先確認自宅／社區充電可行性，若不可行則提供公司與生活圈周邊充電點盤點。',
    '持有成本': '用 CDP 同車齡層定保費用對照切入，強調這是和泰自有資料庫的實際紀錄而非推估。',
    '技術成熟度': '從保固條款反推技術信心，補充 TOYOTA 在非豪華品牌 BEV 評價第一的市調結果。',
  };

  function renderSheet() {
    const p = state.profile;
    const sorted = [...state.concerns.entries()].sort((a, b) => b[1].emotion - a[1].emotion);
    // 未解決 = 情緒強度最高者；其餘視為已於線上被回應
    const unresolved = sorted[0] || null;
    const resolved = sorted.slice(1);
    const mins = Math.max(1, Math.round((Date.now() - state.startedAt) / 60000));
    const id = 'EV-' + String(Math.abs(hash(JSON.stringify(p) + state.choice?.id)) % 10000).padStart(4, '0');

    $('#sheet').innerHTML = `
      <div class="sheet-top">
        <div>
          <h3>油轉電顧慮交接單</h3>
          <div style="font-size:12px;color:#6b7480">系統自動生成・轉電劇場 EV Drama Studio</div>
        </div>
        <span class="tag">${esc(id)}</span>
      </div>
      <dl>
        <dt>線上識別</dt><dd>${esc(id)}（未綁定會員，尚未取得個資）</dd>
        <dt>現有車款</dt><dd>${p ? esc(TCO.VEHICLES[p.model].label) : '未取得（客戶未完成試算）'}</dd>
        <dt>用車型態</dt><dd>${p ? `每日 ${p.dailyKm} 公里・${p.homeCharging ? '有自宅充電' : '無自宅充電'}・一年 ${p.longTripsPerYear} 趟長途（${TCO.DESTINATIONS[p.destination].label}）` : '未取得'}</dd>
        <dt>進入來源</dt><dd>${state.choice ? `短劇 EP1《${esc(DRAMA.episode.title)}》劇末互動 →「${esc(state.choice.label)}」` : '直接進入官網'}</dd>
      </dl>
      <dl>
        <dt>已解決顧慮</dt>
        <dd class="ok">${resolved.length ? resolved.map(([k]) => '✅ ' + esc(k)).join('　') : '（尚無）'}</dd>
        <dt>未解決顧慮</dt>
        <dd class="warn">${unresolved
            ? `⚠ ${esc(unresolved[0])}（追問 ${unresolved[1].count} 次，情緒強度 ${(unresolved[1].emotion * 100).toFixed(0)}%）`
            : '（尚無）'}</dd>
      </dl>
      <div class="script">
        <b>建議話術</b><br>
        ${unresolved ? esc(TALK_TRACK[unresolved[0]] || '依客戶未解決顧慮，優先提供可查證的書面資料而非口頭保證。')
                     : '客戶尚未表達明確顧慮，建議從長途用車情境切入建立對話。'}
      </div>
      <div class="trace">
        <b>互動軌跡</b>　看完 EP1 第 ${state.framesWatched} / ${DRAMA.episode.frames.length} 個分鏡
        ・對話 ${state.turns} 輪、引用來源 ${state.citeCount} 次
        ・${state.sim ? `完成 TCO 試算（三年差額 ${nt(state.sim.r.savingThreeYear)}）` : '未完成 TCO 試算'}
        ・停留 ${mins} 分鐘
      </div>
      <div class="trace" style="border:0;padding-top:6px">
        <b>資料界線</b>　本單僅含使用者主動提供之零方數據與站上行為軌跡，未串接任何個資欄位。
        正式版與 CDP 綁定後，此處另帶入車齡、回廠紀錄與定保金額指數。
      </div>`;
  }

  const hash = (s) => s.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);

  /* ================= 右側觀測面板 ================= */
  function renderObserver() {
    const total = DRAMA.episode.frames.length;
    $('#obConcern').textContent = state.choice ? state.choice.concern : '尚未取得';
    $('#obConcern').classList.toggle('empty', !state.choice);
    $('#obWatch').textContent = `${state.framesWatched} / ${total}`;
    $('#obWatchBar').style.width = (state.framesWatched / total * 100) + '%';

    const emo = Math.max(0, ...[...state.concerns.values()].map((v) => v.emotion));
    $('#obEmo').textContent = emo ? `${(emo * 100).toFixed(0)}%` : '—';
    $('#obEmoBar').style.width = (emo * 100) + '%';

    const tags = [...state.concerns.keys()];
    $('#obTags').innerHTML = tags.length
      ? tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')
      : '<span class="v empty" style="font-size:12px">尚未取得</span>';

    $('#obTurns').textContent = `${state.turns} / ${state.citeCount}`;
    const p = state.profile;
    $('#obProfile').textContent = p
      ? `${TCO.VEHICLES[p.model].label}・每日 ${p.dailyKm}km・${p.homeCharging ? '有家充' : '無家充'}`
      : '尚未試算';
    $('#obProfile').classList.toggle('empty', !p);
  }

  /* ================= 抽屜 ================= */
  function initDrawers() {
    $('#btnKb').addEventListener('click', openKbAll);
    $('#btnAssume').addEventListener('click', openAssumptions);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  }

  function showDrawer(title, html) {
    $('#drawerTitle').textContent = title;
    $('#drawerBody').innerHTML = html;
    $('#drawer').classList.add('open');
    $('#scrim').classList.add('open');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#scrim').classList.remove('open');
  }

  const kbCard = (c) => `<div class="kb-item">
      <div class="id">${esc(c.id)}
        <span class="badge ${c.verified ? 'ok' : 'pending'}">${c.verified ? '已核實' : '待官網核對'}</span>
      </div>
      <h5>${esc(c.title)}</h5>
      <p>${esc(c.text)}</p>
      <div class="src">來源：${esc(c.source)}</div>
    </div>`;

  function openKb(id) {
    const c = RAG.getById(id);
    if (c) showDrawer('引用來源', kbCard(c) + `<p style="font-size:11.5px;color:var(--muted);line-height:1.7">
      面對 58% 擔心換電池費用的人，唯一有效的說服是「可以自己去查證」的答案，不是「請放心」。
      顧問的每一句回答都綁定知識庫條目，來源可展開、可追問。</p>`);
  }

  function openKbAll() {
    const n = RAG.all().length;
    showDrawer(`RAG 知識庫（${n} 則）`,
      `<p style="font-size:12px;color:var(--muted);line-height:1.7;margin-top:0">
        初賽版檢索層為中文 bigram 詞彙檢索，離線可執行；決賽版替換為向量資料庫，
        對外介面不變。標示「待官網核對」者為引用公開資料但尚未逐項核對之規格數字。</p>`
      + RAG.all().map(kbCard).join(''));
  }

  function openAssumptions() {
    const rows = TCO.assumptions().map((a) => `<tr>
        <td>${esc(a.label)}<span class="t-tag t-${esc(a.tag)}">${esc(a.tag)}</span></td>
        <td>${a.value}${esc(a.unit)}</td></tr>`).join('');
    showDrawer('計算假設與常數',
      `<p style="font-size:12px;color:var(--muted);line-height:1.7;margin-top:0">
        「算數字的用確定性演算法，說人話的用生成式 AI。」<br>
        第三幕的所有金額皆由 <code>docs/js/tco.js</code> 的純函式計算，同樣輸入必得同樣結果，
        不經過任何 LLM。以下為全部常數與其性質標籤。</p>
      <table class="assume-tbl">${rows}</table>
      <p style="font-size:11.5px;color:var(--muted);line-height:1.7;margin-top:16px">
        <b>標籤說明</b><br>
        <span class="t-tag t-CDP">CDP</span> 由主辦方資料實證，重現腳本 <code>analysis/cdp_profile.py</code><br>
        <span class="t-tag t-法規">法規</span> 政府公告數值<br>
        <span class="t-tag t-規格">規格</span> 車輛原廠規格，交件前須經官網核對<br>
        <span class="t-tag t-假設">假設</span> 團隊推估值，簡報須說明推估邏輯</p>`);
  }

  boot();
})();
