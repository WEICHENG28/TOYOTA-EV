/**
 * TCO 規則引擎 — 轉電劇場 EV Drama Studio
 *
 * 設計原則（對應簡報 P12）：「算數字的用確定性演算法，說人話的用生成式 AI。」
 * 本檔案不含任何 LLM 呼叫。所有輸出皆為純函式計算，同樣輸入必得同樣結果，
 * 每個常數都標註來源與性質，供評審逐項稽核。
 *
 * 常數性質標籤：
 *   [CDP]  — 由主辦方 CDP 資料實證，重現腳本見 analysis/cdp_profile.py
 *   [法規]  — 政府公告數值
 *   [規格]  — 車輛原廠規格（交件前須經 TOYOTA 官網核對，見 README 待核對清單）
 *   [假設]  — 團隊推估值，簡報須說明推估邏輯
 */

const TCO = (() => {
  'use strict';

  const C = {
    // --- 能源價格 ---
    fuelPricePerL:   { value: 29.5, tag: '假設', label: '95 無鉛每公升', unit: '元' },
    elecHomePerKwh:  { value: 2.1,  tag: '假設', label: '家用離峰電價每度', unit: '元' },
    elecPublicPerKwh:{ value: 10.0, tag: '假設', label: '公共快充每度', unit: '元' },

    // --- bZ4X 規格 ---
    battery:      { value: 71.4, tag: '規格', label: '電池容量', unit: 'kWh' },
    kmPerKwh:     { value: 5.5,  tag: '規格', label: '實測能耗', unit: 'km/kWh' },
    dcAvgKw:      { value: 100,  tag: '規格', label: '快充平均功率', unit: 'kW' },
    acKw:         { value: 6.6,  tag: '規格', label: '家用交流充電功率', unit: 'kW' },

    // --- 保養 ---
    gasMaintAnnual: { value: 12000, tag: '假設', label: '燃油車年均定保支出', unit: '元' },
    // 682 / 1332 = 0.512。控制車齡後（0.5–4 年車）CDP 實際消費紀錄之比值。
    evMaintRatio:   { value: 0.512, tag: 'CDP',  label: 'bZ4X 定保費用為燃油車之比例', unit: '' },

    // --- 用車型態換算 ---
    annualDays:   { value: 365, tag: '假設', label: '日常里程年化天數', unit: '天' },

    // --- 充電區間 ---
    reserveSoc:   { value: 0.10, tag: '假設', label: '長途抵達保留電量', unit: '' },
    dcWindow:     { value: 0.65, tag: '規格', label: '單次快充區間（15%→80%）', unit: '' },
  };

  /** 燃油車年度牌照稅 + 燃料費，依排氣量。[法規] */
  const TAX_BY_CC = [
    { max: 1200, licence: 4320,  fuel: 2160 },
    { max: 1800, licence: 7120,  fuel: 4800 },
    { max: 2400, licence: 11230, fuel: 6180 },
    { max: 3000, licence: 15210, fuel: 7200 },
  ];

  /** 換購黃金池主力車款（CDP 前四名），油耗為原廠公告值 [規格] */
  const VEHICLES = {
    ALTIS:  { label: 'ALTIS 1.8',    kmPerL: 14.6, cc: 1798 },
    RAV4:   { label: 'RAV4 2.0',     kmPerL: 13.7, cc: 1987 },
    YARIS:  { label: 'YARIS 1.5',    kmPerL: 16.8, cc: 1496 },
    SIENTA: { label: 'SIENTA 1.5',   kmPerL: 16.5, cc: 1496 },
    VIOS:   { label: 'VIOS 1.5',     kmPerL: 17.0, cc: 1496 },
    CHR:    { label: 'C-HR 1.8 HV',  kmPerL: 21.5, cc: 1798 },
  };

  /** 常見長途目的地與單程距離（自北部出發概估）[假設] */
  const DESTINATIONS = {
    yilan:    { label: '宜蘭',      km: 90  },
    taichung: { label: '台中',      km: 170 },
    hualien:  { label: '花蓮',      km: 220 },
    tainan:   { label: '台南',      km: 300 },
    kaohsiung:{ label: '高雄',      km: 350 },
    kenting:  { label: '墾丁',      km: 420 },
  };

  const annualTaxOf = (cc) => {
    const row = TAX_BY_CC.find((r) => cc <= r.max) || TAX_BY_CC[TAX_BY_CC.length - 1];
    return row.licence + row.fuel;
  };

  /**
   * 電價混合費率：有家充者以家充為主，無家充者以公共快充為主。
   * 比例為 [假設]，但拆解方式公開可調。
   */
  const blendedElecRate = (homeCharging) => {
    const mix = homeCharging ? { home: 0.85, pub: 0.15 } : { home: 0.20, pub: 0.80 };
    return {
      rate: mix.home * C.elecHomePerKwh.value + mix.pub * C.elecPublicPerKwh.value,
      mix,
    };
  };

  /**
   * 主計算：三年總持有成本對照。
   * @param {{model:string, dailyKm:number, homeCharging:boolean,
   *          longTripsPerYear:number, destination:string}} input
   */
  function calculate(input) {
    const v = VEHICLES[input.model] || VEHICLES.ALTIS;
    const dest = DESTINATIONS[input.destination] || DESTINATIONS.tainan;

    const dailyAnnualKm = input.dailyKm * C.annualDays.value;
    const longTripKm = input.longTripsPerYear * dest.km * 2;
    const annualKm = dailyAnnualKm + longTripKm;

    const { rate: elecRate, mix } = blendedElecRate(input.homeCharging);

    const gas = {
      energy: (annualKm / v.kmPerL) * C.fuelPricePerL.value,
      maint:  C.gasMaintAnnual.value,
      tax:    annualTaxOf(v.cc),
    };
    const ev = {
      energy: (annualKm / C.kmPerKwh.value) * elecRate,
      maint:  C.gasMaintAnnual.value * C.evMaintRatio.value,
      // 電動車目前依主管機關公告免徵牌照稅與燃料費，適用年度須逐年確認。[法規]
      tax:    0,
    };
    gas.total = gas.energy + gas.maint + gas.tax;
    ev.total  = ev.energy + ev.maint + ev.tax;

    return {
      input, vehicle: v, destination: dest,
      annualKm: Math.round(annualKm),
      dailyAnnualKm: Math.round(dailyAnnualKm),
      longTripKm: Math.round(longTripKm),
      elecRate: Number(elecRate.toFixed(2)),
      elecMix: mix,
      annual: { gas: round(gas), ev: round(ev) },
      threeYear: { gas: round(scale(gas, 3)), ev: round(scale(ev, 3)) },
      savingAnnual: Math.round(gas.total - ev.total),
      savingThreeYear: Math.round((gas.total - ev.total) * 3),
      savingPct: Number(((1 - ev.total / gas.total) * 100).toFixed(1)),
      // 本試算為「營運持有成本」，涵蓋燃料／能源、定期保養、牌照稅與燃料費三項。
      // 不含車輛售價、折舊、保險與充電樁建置費 — UI 必須顯示此範圍，否則構成誤導。
      scopeNote: '涵蓋能源、保養、稅費三項營運成本；不含車價、折舊、保險與充電樁建置費用。',
    };
  }

  /** 充電行事曆：把「一週充幾次」算清楚，而不是問「附近有幾支樁」。 */
  function chargingCalendar(input) {
    const sessionKm = C.battery.value * C.dcWindow.value * C.kmPerKwh.value; // 15%→80%
    const weeklyKm = input.dailyKm * 7;
    const sessions = weeklyKm / sessionKm;
    const kwhPerSession = C.battery.value * C.dcWindow.value;
    const acHours = kwhPerSession / C.acKw.value;

    // 把每週充電次數攤到一週七天，標記出需要充電的日子（示意用）。
    // 不足一次者仍標一天，代表「平均而言每週會有一天需要充」。
    const days = ['一', '二', '三', '四', '五', '六', '日'];
    const nDays = Math.min(7, Math.max(1, Math.round(sessions)));
    const marked = new Set();
    for (let i = 0; i < nDays; i++) {
      marked.add(Math.min(6, Math.round((i + 1) * (7 / nDays)) - 1));
    }

    return {
      weeklyKm: Math.round(weeklyKm),
      sessionKm: Math.round(sessionKm),
      sessionsPerWeek: Number(sessions.toFixed(1)),
      kwhPerSession: Number(kwhPerSession.toFixed(1)),
      acHours: Number(acHours.toFixed(1)),
      homeCharging: input.homeCharging,
      week: days.map((d, i) => ({ day: d, charge: marked.has(i) })),
      verdict: input.homeCharging
        ? `約每週充 ${sessions.toFixed(1)} 次，每次於夜間家充約 ${acHours.toFixed(1)} 小時，全數可在睡眠時間內完成。`
        : `約每週充 ${sessions.toFixed(1)} 次。無自宅充電時需使用公共充電，單次快充約 ${Math.round(kwhPerSession / C.dcAvgKw.value * 60)} 分鐘。`,
    };
  }

  /** 長途劇本：把「會不會卡住」換算成「要停幾次、停多久」。 */
  function longTripPlan(input) {
    const dest = DESTINATIONS[input.destination] || DESTINATIONS.tainan;
    const usableRangeKm = C.battery.value * (1 - C.reserveSoc.value) * C.kmPerKwh.value;
    const oneWay = dest.km;
    const kwhNeeded = oneWay / C.kmPerKwh.value;
    const arrivalSoc = (1 - kwhNeeded / C.battery.value) * 100;

    let stops = 0, stopMinutes = 0, deficitKwh = 0;
    if (oneWay > usableRangeKm) {
      // 補到「抵達時仍保留 reserveSoc」所需的電量
      deficitKwh = kwhNeeded + C.battery.value * C.reserveSoc.value - C.battery.value;
      stops = 1;
      stopMinutes = Math.max(15, Math.round((deficitKwh / C.dcAvgKw.value) * 60));
    }

    return {
      destination: dest,
      oneWayKm: oneWay,
      usableRangeKm: Math.round(usableRangeKm),
      kwhNeeded: Number(kwhNeeded.toFixed(1)),
      arrivalSoc: Math.round(Math.max(arrivalSoc, 0)),
      stops, stopMinutes,
      deficitKwh: Number(deficitKwh.toFixed(1)),
      verdict: stops === 0
        ? `滿電出發，單程 ${oneWay} 公里無須中途充電，抵達時約剩 ${Math.round(arrivalSoc)}% 電量。`
        : `單程 ${oneWay} 公里，建議於途中服務區快充一次，約 ${stopMinutes} 分鐘 — 與一次用餐停留相當。`,
    };
  }

  /** 供 UI 顯示的假設清單，讓每個數字都能被追問。 */
  function assumptions() {
    const list = Object.values(C).map((c) => ({
      label: c.label, value: c.value, unit: c.unit, tag: c.tag,
    }));
    list.push({ label: '電動車牌照稅與燃料費', value: 0, unit: '元', tag: '法規' });
    return list;
  }

  const scale = (o, k) => Object.fromEntries(Object.entries(o).map(([a, b]) => [a, b * k]));
  const round = (o) => Object.fromEntries(Object.entries(o).map(([a, b]) => [a, Math.round(b)]));

  return { calculate, chargingCalendar, longTripPlan, assumptions, VEHICLES, DESTINATIONS, CONSTANTS: C };
})();

if (typeof module !== 'undefined') module.exports = TCO;
