# -*- coding: utf-8 -*-
"""
簡報封面／結尾頁產生器 — AI 劇場 EV Drama Studio

以程式繪製，不是生圖模型的產物：字級、顏色、間距都可精確控制，
要改字或換尺寸重跑即可，不會出現錯字或走樣的中文。

用法：
    python tools/make_cover.py                    # 16:9，預設輸出 assets/
    python tools/make_cover.py --ratio 4:3
    python tools/make_cover.py --scale 2          # 輸出 3840×2160，投影更銳利
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# --- 色票：與原型 docs/css/style.css 同一組，確保簡報與 Demo 視覺一致 ---
BG      = (11, 13, 16)
PANEL   = (21, 26, 32)
LINE    = (42, 50, 59)
TEXT    = (232, 234, 237)
MUTED   = (152, 162, 173)
RED     = (235, 10, 30)
DIM     = (200, 206, 214)

FONT_DIR = Path(r"C:\Windows\Fonts")
F_BOLD = FONT_DIR / "msjhbd.ttc"     # 微軟正黑體 Bold
F_REG  = FONT_DIR / "msjh.ttc"       # 微軟正黑體 Regular
F_LGT  = FONT_DIR / "msjhl.ttc"      # 微軟正黑體 Light


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def text_ls(draw: ImageDraw.ImageDraw, xy, s: str, f, fill, spacing: float = 0):
    """逐字繪製以支援字距（PIL 無原生 letter-spacing）。回傳結束的 x 座標。"""
    x, y = xy
    for ch in s:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + spacing
    return x


def width_ls(draw: ImageDraw.ImageDraw, s: str, f, spacing: float = 0) -> float:
    return sum(draw.textlength(c, font=f) for c in s) + spacing * max(0, len(s) - 1)


def radial_glow(size, center, radius, color, strength=0.5):
    """在深色底上疊一層柔和光暈，避免整張圖死板。"""
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt((xx - center[0]) ** 2 + (yy - center[1]) ** 2)
    a = np.clip(1 - d / radius, 0, 1) ** 2 * strength
    layer = np.zeros((h, w, 4), dtype=np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = color
    layer[..., 3] = (a * 255).astype(np.uint8)
    return Image.fromarray(layer, "RGBA")


def build(W: int, H: int, punchline: bool) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    # 兩道光暈：紅色在右下呼應主色，冷色在左上避免整張偏暖
    img.paste(Image.alpha_composite(
        img.convert("RGBA"), radial_glow((W, H), (W * 0.78, H * 0.72), W * 0.58, RED, 0.22)).convert("RGB"), (0, 0))
    img.paste(Image.alpha_composite(
        img.convert("RGBA"), radial_glow((W, H), (W * 0.1, -H * 0.1), W * 0.5, (60, 90, 130), 0.13)).convert("RGB"), (0, 0))

    d = ImageDraw.Draw(img)
    s = W / 1920  # 所有尺寸依寬度等比縮放
    px = lambda v: int(round(v * s))
    L = px(132)                      # 左側基準線
    # 版面依 16:9 設計。換成較高的比例時，內容區整體下移，
    # 避免上半部擠成一團、下半部留一大片空白（頁尾仍錨定在底部）。
    oy = int((H - px(1080)) * 0.42)

    # ---------- 品牌標記 ----------
    mark = px(84)
    d.rounded_rectangle([L, oy + px(150), L + mark, oy + px(150) + mark], radius=px(20), fill=RED)
    f_mark = font(F_BOLD, px(46))
    bb = d.textbbox((0, 0), "劇", font=f_mark)
    d.text((L + (mark - (bb[2] - bb[0])) / 2 - bb[0],
            oy + px(150) + (mark - (bb[3] - bb[1])) / 2 - bb[1]), "劇", font=f_mark, fill=(255, 255, 255))

    # ---------- 題目 ----------
    f_kick = font(F_REG, px(24))
    text_ls(d, (L, oy + px(292)), "2026 和泰 AI 黑客松　智能轉型：AI 助攻油轉電 TOYOTA EV 新生活",
            f_kick, MUTED, spacing=px(2.2))

    # ---------- 主標 ----------
    f_zh = font(F_BOLD, px(148))
    d.text((L, oy + px(336)), "AI 劇場", font=f_zh, fill=TEXT)
    zh_w = d.textlength("AI 劇場", font=f_zh)

    f_en = font(F_LGT, px(60))
    text_ls(d, (L + px(14), oy + px(516)), "EV DRAMA STUDIO", f_en, RED, spacing=px(7))

    # ---------- 紅線 ----------
    d.rectangle([L, oy + px(628), L + px(116), oy + px(628) + px(7)], fill=RED)

    # ---------- 標語 ----------
    f_tag = font(F_REG, px(40))
    d.text((L, oy + px(690)), "用 AI 短劇把陌生人變觀眾，", font=f_tag, fill=DIM)
    d.text((L, oy + px(752)), "用劇中角色把觀眾變準客戶。", font=f_tag, fill=DIM)

    # ---------- 三幕標籤 ----------
    f_num = font(F_BOLD, px(20))
    f_act = font(F_REG, px(25))
    acts = [("01", "AI 短劇"), ("02", "角色顧問"), ("03", "數位分身"), ("04", "業務交接單")]
    x, y = L, oy + px(872)
    for i, (n, name) in enumerate(acts):
        d.text((x, y + px(5)), n, font=f_num, fill=RED)
        nx = x + d.textlength(n, font=f_num) + px(11)
        d.text((nx, y), name, font=f_act, fill=MUTED)
        x = nx + d.textlength(name, font=f_act) + px(26)
        if i < len(acts) - 1:
            d.text((x, y), "·", font=f_act, fill=LINE)
            x += px(24)

    # ---------- 底部資訊 ----------
    f_foot = font(F_REG, px(23))
    foot_y = H - px(96)
    d.rectangle([L, foot_y - px(28), W - px(132), foot_y - px(28) + px(1)], fill=LINE)
    d.text((L, foot_y), "隊伍：請下一隊上場", font=f_foot, fill=TEXT)
    url = "github.com/WEICHENG28/TOYOTA-EV"
    d.text((W - px(132) - d.textlength(url, font=f_foot), foot_y), url, font=f_foot, fill=MUTED)

    # ---------- 右側：短劇畫面示意 ----------
    pw, ph = px(360), px(720)
    pxx, pyy = W - px(132) - pw, oy + px(160)
    d.rounded_rectangle([pxx, pyy, pxx + pw, pyy + ph], radius=px(38), fill=PANEL, outline=LINE, width=px(3))

    seg_w = (pw - px(52) - px(6) * 6) / 7
    for i in range(7):
        sx = pxx + px(26) + i * (seg_w + px(6))
        d.rounded_rectangle([sx, pyy + px(26), sx + seg_w, pyy + px(30)], radius=px(2),
                            fill=(255, 255, 255) if i < 3 else LINE)

    # 手機上方的頻道標示，讓畫面不至於上半部空白
    f_meta = font(F_REG, px(17))
    d.ellipse([pxx + px(26), pyy + px(56), pxx + px(26) + px(8), pyy + px(56) + px(8)], fill=RED)
    d.text((pxx + px(42), pyy + px(48)), "EV DRAMA STUDIO", font=f_meta, fill=(150, 158, 168))
    d.text((pxx + pw - px(26) - d.textlength("1 / 7", font=f_meta), pyy + px(48)),
           "1 / 7", font=f_meta, fill=(150, 158, 168))

    cx, cy, r = pxx + pw / 2, pyy + ph * 0.42, px(52)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED)
    t = px(21)
    d.polygon([(cx - t * 0.5 + px(4), cy - t), (cx - t * 0.5 + px(4), cy + t), (cx + t + px(4), cy)],
              fill=(255, 255, 255))

    f_ep = font(F_BOLD, px(27))
    f_epn = font(F_REG, px(19))
    for txt, fnt, col, dy in [("EP1《回南部那天》", f_ep, TEXT, 0), ("對應顧慮：充電不方便 66%", f_epn, MUTED, px(42))]:
        d.text((cx - d.textlength(txt, font=fnt) / 2, cy + px(112) + dy), txt, font=fnt, fill=col)

    # ---------- 結尾頁變體 ----------
    if punchline:
        f_pl = font(F_LGT, px(27))
        d.text((L, oy + px(806)), "—— 這三分鐘看完，希望你先別急著叫下一隊。", font=f_pl, fill=MUTED)

    return img


def main() -> int:
    ap = argparse.ArgumentParser(description="產生簡報封面／結尾頁")
    ap.add_argument("--ratio", default="16:9", choices=["16:9", "4:3"])
    ap.add_argument("--scale", type=float, default=1.0, help="解析度倍率（2 = 3840 寬）")
    ap.add_argument("--punchline", action="store_true", help="加上結尾頁的隊名回馬槍")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    W = int(1920 * a.scale)
    H = int(W * (9 / 16 if a.ratio == "16:9" else 3 / 4))

    img = build(W, H, a.punchline)
    outdir = Path(__file__).resolve().parent.parent / "assets"
    outdir.mkdir(exist_ok=True)
    name = a.out or f"cover_{a.ratio.replace(':', 'x')}{'_punchline' if a.punchline else ''}.png"
    path = outdir / name
    img.save(path, "PNG")
    print(f"{path}　{W}×{H}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
