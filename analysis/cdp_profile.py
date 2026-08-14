# -*- coding: utf-8 -*-
"""
CDP 車主輪廓分析 — 轉電劇場 EV Drama Studio

用途：重現初賽簡報中所有引用 `[資料]` 的 CDP 數字，並輸出圖表與統計 JSON。

資料來源（主辦方提供，含個資，**不隨本 repo 上傳**）：
  - 2026 AI黑客松CDP資料 (T車輛).csv                    n = 1,048,575
  - 2026 AI黑客松CDP 電動車主補充資料資料 (T車輛).csv    n = 3,037（全為 bZ4X）

資料基準日：2026-06-01
  推導方式：以「現保有車交車日期_T」最大值為 2026-05-09，逐日試算車齡分組人數，
  於 2026-06-01 時四組人數與主辦方口徑完全一致（誤差 0），故採為基準日。

用法：
    python analysis/cdp_profile.py --data-dir "D:/黑客松競賽"

輸出：
    analysis/output/stats.json          所有統計數字（供簡報與原型引用）
    analysis/output/fig_return_rate.png 零回廠比例 vs 車齡（簡報 P5）
    analysis/output/fig_maint_cost.png  同車齡層定保金額對照（簡報 P10）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

# Windows 終端機預設 cp950，強制 UTF-8 以免中文與符號輸出失敗
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 資料基準日（見檔頭說明）
REF_DATE = pd.Timestamp("2026-06-01")

# 車齡分組（左閉右開，單位：年）
AGE_BINS = [("0–3", 0, 3), ("3–7", 3, 7), ("7–12", 7, 12), ("12+", 12, 999)]

# 六都
SIX_CITIES = ["臺北市", "台北市", "新北市", "桃園市", "臺中市", "台中市", "臺南市", "台南市", "高雄市"]
SIX_PLUS_HSINCHU = SIX_CITIES + ["新竹市", "新竹縣"]

COL_DATE = "現保有車交車日期_T"
COL_SEX = "性別"
COL_AGE = "年齡"
COL_CITY = "居住縣市"
COL_MODEL = "現保有車款_T"


def load_csv(path: Path) -> pd.DataFrame:
    """主辦方 CSV 為 Big5 編碼，欄位名含換行需正規化。"""
    df = pd.read_csv(path, encoding="big5", encoding_errors="replace")
    df.columns = [c.replace("\n", "").strip() for c in df.columns]
    df["交車日"] = pd.to_datetime(df[COL_DATE], errors="coerce")
    df["車齡"] = (REF_DATE - df["交車日"]).dt.days / 365.25
    df["車齡組"] = df["車齡"].apply(bucket_of)
    return df


def bucket_of(years: float) -> str:
    for label, lo, hi in AGE_BINS:
        if lo <= years < hi:
            return label
    return AGE_BINS[-1][0]


def col_startswith(df: pd.DataFrame, prefix: str) -> str:
    """欄位名在兩份 CSV 之間有細微空白差異，用前綴比對。"""
    for c in df.columns:
        if c.startswith(prefix):
            return c
    raise KeyError(f"找不到以 {prefix} 開頭的欄位")


def analyse(gas: pd.DataFrame, ev: pd.DataFrame) -> dict:
    visit_col = col_startswith(gas, "近一年回廠次數")
    maint_gas = col_startswith(gas, "近一年定保消費金額")
    maint_ev = col_startswith(ev, "近一年定保消費金額")

    gas["零回廠"] = gas[visit_col] == 0
    stats: dict = {
        "資料基準日": str(REF_DATE.date()),
        "母體": {"全體車主": len(gas), "bZ4X車主": len(ev)},
    }

    # --- 簡報 P5：零回廠比例 vs 車齡 ---
    grouped = gas.groupby("車齡組").agg(樣本數=("零回廠", "size"), 零回廠比例=("零回廠", "mean"))
    grouped = grouped.reindex([b[0] for b in AGE_BINS])
    stats["零回廠_依車齡"] = [
        {"車齡": idx, "樣本數": int(row.樣本數), "零回廠比例": round(row.零回廠比例 * 100, 1)}
        for idx, row in grouped.iterrows()
    ]
    stats["全體零回廠比例"] = round(gas["零回廠"].mean() * 100, 1)
    stats["持有7年以上佔比"] = round((gas["車齡"] >= 7).mean() * 100, 1)

    # --- 簡報 P6：換購黃金池（持有 5–10 年） ---
    pool = gas[(gas["車齡"] >= 5) & (gas["車齡"] < 10)]
    pool_age = pool[pool[COL_AGE] > 0][COL_AGE]  # 年齡 0 為未填，排除後取中位數
    stats["換購黃金池"] = {
        "人數": len(pool),
        "佔全體比例": round(len(pool) / len(gas) * 100, 1),
        "男性佔比": round((pool[COL_SEX] == "男").mean() * 100, 1),
        "年齡中位數": round(float(pool_age.median()), 1),
        "年齡有效樣本": int(len(pool_age)),
        "六都佔比": round(pool[COL_CITY].isin(SIX_CITIES).mean() * 100, 1),
        "主力車款": pool[COL_MODEL].value_counts().head(6).to_dict(),
    }

    # --- 簡報 P6：bZ4X 車主輪廓對照 ---
    ev_age = ev[ev[COL_AGE] > 0][COL_AGE]
    stats["bZ4X輪廓"] = {
        "人數": len(ev),
        "男性佔比": round((ev[COL_SEX] == "男").mean() * 100, 1),
        "年齡中位數": round(float(ev_age.median()), 1),
        "年齡有效樣本": int(len(ev_age)),
        "六都加新竹佔比": round(ev[COL_CITY].isin(SIX_PLUS_HSINCHU).mean() * 100, 1),
        "全體六都加新竹佔比": round(gas[COL_CITY].isin(SIX_PLUS_HSINCHU).mean() * 100, 1),
    }

    # --- 簡報 P10：控制車齡後的定保金額對照 ---
    # 口徑統一為「該車齡區間全體車主」（含近一年未定保者，金額計 0）。
    # 平均與中位數必須取自同一母體，否則無法互相解釋。
    sub_gas = gas[(gas["車齡"] >= 0.5) & (gas["車齡"] <= 4)]
    sub_ev = ev[(ev["車齡"] >= 0.5) & (ev["車齡"] <= 4)]
    cost = {}
    for name, sub, col in [("燃油車", sub_gas, maint_gas), ("bZ4X", sub_ev, maint_ev)]:
        v = pd.to_numeric(sub[col], errors="coerce")
        v_nonzero = v[v > 0]
        cost[name] = {
            "樣本數": int(len(sub)),
            "平均_全體": round(float(v.mean())),
            "中位_全體": round(float(v.median())),
            "平均_排除未定保": round(float(v_nonzero.mean())),
            "中位_排除未定保": round(float(v_nonzero.median())),
            "有定保紀錄樣本數": int(len(v_nonzero)),
        }
    g, e = cost["燃油車"], cost["bZ4X"]
    cost["差異_全體口徑"] = {
        "平均降幅": round((e["平均_全體"] / g["平均_全體"] - 1) * 100, 1),
        "中位降幅": round((e["中位_全體"] / g["中位_全體"] - 1) * 100, 1),
    }
    cost["幣別註記"] = "A 國幣值，非台幣；簡報一律以相對比例呈現"
    stats["定保金額對照_車齡0.5至4年"] = cost

    return stats


def plot(stats: dict, outdir: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # Windows 內建正黑體，避免中文變豆腐字
    plt.rcParams["font.sans-serif"] = ["Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC"]
    plt.rcParams["axes.unicode_minus"] = False
    TOYOTA_RED = "#EB0A1E"

    # 圖一：零回廠比例 vs 車齡（簡報最有說服力的一張）
    rows = stats["零回廠_依車齡"]
    labels = [r["車齡"] for r in rows]
    values = [r["零回廠比例"] for r in rows]
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)
    ax.plot(labels, values, marker="o", linewidth=2.5, color=TOYOTA_RED, markersize=9)
    for x, y in zip(labels, values):
        ax.annotate(f"{y}%", (x, y), textcoords="offset points", xytext=(0, 11),
                    ha="center", fontsize=11, fontweight="bold")
    ax.set_title("近一年「零回廠」比例隨車齡急遽上升", fontsize=14, fontweight="bold", pad=14)
    ax.set_xlabel("車齡（年）")
    ax.set_ylabel("零回廠比例（%）")
    ax.set_ylim(0, 92)
    ax.grid(axis="y", alpha=0.25)
    ax.spines[["top", "right"]].set_visible(False)
    fig.text(0.99, 0.02, f"資料：主辦方 CDP n={stats['母體']['全體車主']:,}｜基準日 {stats['資料基準日']}",
             ha="right", fontsize=8, color="#666")
    fig.tight_layout()
    fig.savefig(outdir / "fig_return_rate.png", bbox_inches="tight")
    plt.close(fig)

    # 圖二：同車齡層定保金額對照
    cost = stats["定保金額對照_車齡0.5至4年"]
    fig, ax = plt.subplots(figsize=(7, 4.5), dpi=160)
    cats = ["平均", "中位數"]
    gas_v = [cost["燃油車"]["平均_全體"], cost["燃油車"]["中位_全體"]]
    ev_v = [cost["bZ4X"]["平均_全體"], cost["bZ4X"]["中位_全體"]]
    x = range(len(cats))
    ax.bar([i - 0.19 for i in x], gas_v, width=0.38, label="燃油車", color="#9AA0A6")
    ax.bar([i + 0.19 for i in x], ev_v, width=0.38, label="bZ4X", color=TOYOTA_RED)
    for i, (a, b) in enumerate(zip(gas_v, ev_v)):
        ax.text(i - 0.19, a, f"{a:,}", ha="center", va="bottom", fontsize=10)
        ax.text(i + 0.19, b, f"{b:,}", ha="center", va="bottom", fontsize=10, fontweight="bold")
        # 用 ASCII hyphen：正黑體缺 U+2212 MINUS SIGN 字符
        ax.text(i, max(a, b) * 1.16, f"-{abs(round((b/a-1)*100))}%", ha="center",
                fontsize=13, fontweight="bold", color=TOYOTA_RED)
    ax.set_xticks(list(x)); ax.set_xticklabels(cats)
    ax.set_title("控制車齡後（0.5–4 年車）近一年定保金額對照", fontsize=13, fontweight="bold", pad=14)
    ax.set_ylabel("定保金額（A 國幣值）")
    ax.set_ylim(0, max(gas_v) * 1.34)
    ax.legend(frameon=False)
    ax.grid(axis="y", alpha=0.25)
    ax.spines[["top", "right"]].set_visible(False)
    fig.text(0.99, 0.02,
             f"燃油車 n={cost['燃油車']['樣本數']:,}｜bZ4X n={cost['bZ4X']['樣本數']:,}｜含近一年未定保者",
             ha="right", fontsize=8, color="#666")
    fig.tight_layout()
    fig.savefig(outdir / "fig_maint_cost.png", bbox_inches="tight")
    plt.close(fig)


def main() -> int:
    ap = argparse.ArgumentParser(description="重現初賽簡報的 CDP 統計數字")
    ap.add_argument("--data-dir", default=r"D:\黑客松競賽",
                    help="存放主辦方 CSV 的資料夾（預設 D:\\黑客松競賽）")
    ap.add_argument("--no-plot", action="store_true", help="只輸出 stats.json，不畫圖")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    f_gas = data_dir / "2026 AI黑客松CDP資料 (T車輛).csv"
    f_ev = data_dir / "2026 AI黑客松CDP 電動車主補充資料資料 (T車輛).csv"
    for f in (f_gas, f_ev):
        if not f.exists():
            print(f"[錯誤] 找不到 {f}\n"
                  f"       主辦方原始資料含個資，不隨 repo 發布，請用 --data-dir 指向本機路徑。",
                  file=sys.stderr)
            return 1

    print(f"讀取中…（全體約 55MB，需數十秒）")
    gas, ev = load_csv(f_gas), load_csv(f_ev)
    stats = analyse(gas, ev)

    outdir = Path(__file__).parent / "output"
    outdir.mkdir(exist_ok=True)
    (outdir / "stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ {outdir / 'stats.json'}")

    if not args.no_plot:
        plot(stats, outdir)
        print(f"✓ {outdir / 'fig_return_rate.png'}")
        print(f"✓ {outdir / 'fig_maint_cost.png'}")

    print("\n--- 簡報引用數字對照 ---")
    for r in stats["零回廠_依車齡"]:
        print(f"  車齡 {r['車齡']:>5}｜零回廠 {r['零回廠比例']:>5}%｜n={r['樣本數']:,}")
    print(f"  全體零回廠 {stats['全體零回廠比例']}%｜持有 7 年以上 {stats['持有7年以上佔比']}%")
    pool = stats["換購黃金池"]
    print(f"  換購黃金池 {pool['人數']:,} 人（{pool['佔全體比例']}%）｜男 {pool['男性佔比']}%"
          f"｜年齡中位 {pool['年齡中位數']}｜六都 {pool['六都佔比']}%")
    d = stats["定保金額對照_車齡0.5至4年"]["差異_全體口徑"]
    print(f"  定保金額 平均 {d['平均降幅']}%｜中位 {d['中位降幅']}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
