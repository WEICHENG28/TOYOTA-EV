# -*- coding: utf-8 -*-
"""
短劇海報產生器 — AI 劇場 EV Drama Studio

把 EP1《回南部那天》做成一張真正的短劇海報（直式），放進簡報就是提案本身，
不是一張裝飾用的封面。

重要限制：本腳本不產生照片。
    海報的攝影底圖必須由外部提供（--photo），可以是：
      1. 拍攝三分鐘影片時真人出鏡的其中一格
      2. TOYOTA 官方 bZ4X 產品照（使用前請確認授權範圍）
      3. 以文生圖模型另外產出的素材
    未提供照片時，會以程式繪製的黃昏漸層作為佔位底圖，構圖與文字排版完全相同，
    拿到照片後重跑同一支腳本即可替換。

用法：
    python tools/make_poster.py                          # 佔位底圖
    python tools/make_poster.py --photo D:/某張圖.jpg     # 套用實際照片
    python tools/make_poster.py --photo x.jpg --scale 2  # 2400×3200
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FONT_DIR = Path(r"C:\Windows\Fonts")
F_BOLD = FONT_DIR / "msjhbd.ttc"
F_REG = FONT_DIR / "msjh.ttc"

# 金色標題漸層：由上而下 亮金 → 正金 → 暗金銅
GOLD = [(255, 236, 170), (255, 205, 92), (243, 168, 38), (198, 116, 18)]
GOLD_STROKE = (46, 22, 6)          # 標題描邊：深褐，與參考海報同一路數
RED = (235, 10, 30)                # TOYOTA 紅，與原型同色票
CREAM = (240, 232, 216)


def font(p: Path, size: int):
    return ImageFont.truetype(str(p), size)


def gradient_text(size, text, fnt, colors, stroke_w, stroke_fill, spacing=0):
    """
    以文字遮罩填入垂直漸層，並保留描邊。
    PIL 無法直接對文字上漸層，故先畫遮罩再用遮罩合成漸層色塊。
    """
    W, H = size
    # 1) 描邊層（實心深色，含 stroke）
    stroke_layer = Image.new("RGBA", size, (0, 0, 0, 0))
    ds = ImageDraw.Draw(stroke_layer)
    # 2) 字身遮罩（不含 stroke）
    mask = Image.new("L", size, 0)
    dm = ImageDraw.Draw(mask)

    x = 0
    for ch in text:
        ds.text((x, 0), ch, font=fnt, fill=stroke_fill,
                stroke_width=stroke_w, stroke_fill=stroke_fill)
        dm.text((x, 0), ch, font=fnt, fill=255)
        x += dm.textlength(ch, font=fnt) + spacing

    # 3) 垂直漸層色塊
    grad = np.zeros((H, W, 3), dtype=np.uint8)
    stops = np.linspace(0, H, len(colors))
    for i in range(len(colors) - 1):
        a, b = int(stops[i]), int(stops[i + 1])
        for c in range(3):
            grad[a:b, :, c] = np.linspace(colors[i][c], colors[i + 1][c], max(1, b - a))[:, None]
    grad_img = Image.fromarray(grad, "RGB").convert("RGBA")
    grad_img.putalpha(mask)

    out = Image.alpha_composite(stroke_layer, grad_img)
    return out, x


def text_width(text, fnt, spacing=0):
    d = ImageDraw.Draw(Image.new("L", (1, 1)))
    return sum(d.textlength(c, font=fnt) for c in text) + spacing * max(0, len(text) - 1)


def placeholder_bg(W, H):
    """佔位底圖：黃昏稻田色調的抽象漸層。不模擬人物或車輛。"""
    y = np.linspace(0, 1, H)[:, None]                     # (H,1)
    sky = np.array([44, 58, 84]); horizon = np.array([214, 148, 58])
    field = np.array([122, 84, 28]); ground = np.array([38, 27, 14])

    # 先做一條 (H,3) 的垂直色階：上半天空→地平線，下半稻田→地面
    t_top = np.clip(y / 0.5, 0, 1)
    t_bot = np.clip((y - 0.5) / 0.5, 0, 1)
    upper = sky + (horizon - sky) * t_top
    lower = field + (ground - field) * t_bot
    # 用 smoothstep 混合上下兩段，否則地平線會出現一條硬邊
    w = np.clip((y - 0.42) / 0.16, 0, 1)
    w = w * w * (3 - 2 * w)
    ramp = upper * (1 - w) + lower * w                           # (H,3)
    img = np.repeat(ramp[:, None, :], W, axis=1)                 # (H,W,3)

    # 右上落日光暈
    yy = np.linspace(0, 1, H)[:, None]
    xx = np.linspace(0, 1, W)[None, :]
    dist = np.sqrt((xx - 0.72) ** 2 + ((yy - 0.28) * (H / W)) ** 2)
    glow = np.clip(1 - dist / 0.42, 0, 1) ** 2                   # (H,W)
    img = img + glow[..., None] * np.array([90, 62, 18])
    # 顆粒感，避免漸層過於平板
    rng = np.random.default_rng(20260814)
    img = img + rng.normal(0, 4.5, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


def cover_crop(im: Image.Image, W: int, H: int,
               fx: float = 0.5, fy: float = 0.35, zoom: float = 1.0) -> Image.Image:
    """
    等比放大後裁切，填滿畫布不變形。
    橫幅素材（車輛型錄多為寬幅）裁成直式時，主體位置差一點就會被切掉，
    故開放 fx / fy 指定裁切錨點，zoom 再往主體推近。
    """
    im = im.convert("RGB")
    s = max(W / im.width, H / im.height) * zoom
    im = im.resize((int(im.width * s + 1), int(im.height * s + 1)), Image.LANCZOS)
    left = int((im.width - W) * fx)
    top = int((im.height - H) * fy)
    left = max(0, min(left, im.width - W))
    top = max(0, min(top, im.height - H))
    return im.crop((left, top, left + W, top + H))


def grade_warm(im: Image.Image, amount: float = 1.0) -> Image.Image:
    """
    黃昏色調。型錄照多為冷色（海、天空），與金色標題並置會打架，
    故把中間調往暖色推、壓一點藍，並加暈影集中視線。
    """
    a = np.asarray(im).astype(np.float32) / 255.0
    lum = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    warm = np.stack([
        np.clip(a[..., 0] * (1 + 0.16 * amount) + 0.045 * amount, 0, 1),
        np.clip(a[..., 1] * (1 + 0.04 * amount) + 0.012 * amount, 0, 1),
        np.clip(a[..., 2] * (1 - 0.14 * amount) - 0.012 * amount, 0, 1),
    ], axis=-1)
    # highlights 保留原色，避免車身白牌與天空過曝變橘
    k = np.clip((lum - 0.72) / 0.28, 0, 1)[..., None]
    out = warm * (1 - k) + a * k

    H, W = out.shape[:2]
    yy = np.linspace(-1, 1, H)[:, None]
    xx = np.linspace(-1, 1, W)[None, :]
    vig = 1 - 0.42 * amount * np.clip((xx ** 2 + yy ** 2) / 2.0, 0, 1) ** 1.1
    out = out * vig[..., None]
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGB")


def scrim(img: Image.Image, start: float, strength: float = 0.94):
    """底部壓暗，讓標題壓得住畫面。"""
    W, H = img.size
    yy = np.linspace(0, 1, H)[:, None]
    a = np.clip((yy - start) / (1 - start), 0, 1) ** 1.5 * strength
    layer = np.zeros((H, W, 4), dtype=np.uint8)
    layer[..., 3] = np.repeat((a * 255).astype(np.uint8), W, axis=1)
    return Image.alpha_composite(img.convert("RGBA"), Image.fromarray(layer, "RGBA")).convert("RGB")


def fit_width(src: Image.Image, W: int, H: int, top_frac: float, zoom: float) -> Image.Image:
    """
    橫幅素材放進直式海報的正解：
    直接 cover 裁切會把車頭車尾切掉，縮到剛好又會在上下留出生硬的空白。
    故以「同一張照片的模糊放大版」當背景填滿畫面，再把完整照片疊在上面，
    邊緣用羽化融進背景 — 這是電影海報處理寬幅劇照的標準手法。
    """
    backdrop = cover_crop(src, W, H, 0.5, 0.5, 1.25)
    backdrop = backdrop.filter(ImageFilter.GaussianBlur(int(W * 0.035)))
    backdrop = Image.blend(backdrop, Image.new("RGB", (W, H), (14, 11, 9)), 0.42)

    fw = int(W * zoom)
    fh = int(fw * src.height / src.width)
    fg = src.convert("RGB").resize((fw, fh), Image.LANCZOS)

    # 上下邊緣羽化，避免出現一條硬邊
    feather = max(8, int(fh * 0.10))
    mask = Image.new("L", (fw, fh), 255)
    md = ImageDraw.Draw(mask)
    for i in range(feather):
        v = int(255 * (i / feather))
        md.line([(0, i), (fw, i)], fill=v)
        md.line([(0, fh - 1 - i), (fw, fh - 1 - i)], fill=v)

    out = backdrop.copy()
    out.paste(fg, ((W - fw) // 2, int(H * top_frac)), mask)
    return out


def build(W: int, H: int, photo: Path | None, fx=0.5, fy=0.35,
          zoom=1.0, warm=1.0, fit="cover", top_frac=0.16) -> Image.Image:
    if photo:
        src = Image.open(photo)
        if fit == "width":
            base = fit_width(src, W, H, top_frac, zoom)
        else:
            base = cover_crop(src, W, H, fx, fy, zoom)
        if warm > 0:
            base = grade_warm(base, warm)
    else:
        base = placeholder_bg(W, H)
    base = scrim(base, 0.44)
    # 頂部也輕壓一層，讓頻道標示看得清楚
    base = base.rotate(180).transpose(Image.ROTATE_180) if False else base
    top_layer = np.zeros((H, W, 4), dtype=np.uint8)
    yy = np.linspace(0, 1, H)[:, None]
    a = np.clip((0.16 - yy) / 0.16, 0, 1) * 0.62
    top_layer[..., 3] = np.repeat((a * 255).astype(np.uint8), W, axis=1)
    base = Image.alpha_composite(base.convert("RGBA"), Image.fromarray(top_layer, "RGBA")).convert("RGB")

    img = base.convert("RGBA")
    d = ImageDraw.Draw(img)
    s = W / 1200
    px = lambda v: int(round(v * s))
    M = px(72)

    # ---------- 頂部：頻道標示 ----------
    f_badge = font(F_BOLD, px(26))
    bw = text_width("AI 劇場", f_badge) + px(30)
    d.rounded_rectangle([M, px(64), M + bw, px(64) + px(46)], radius=px(9), fill=RED)
    d.text((M + px(15), px(72)), "AI 劇場", font=f_badge, fill=(255, 255, 255))

    f_ch = font(F_REG, px(23))
    d.text((M + bw + px(16), px(76)), "EV DRAMA STUDIO", font=f_ch, fill=(226, 218, 204))
    ep = "EP 1"
    d.text((W - M - d.textlength(ep, font=f_badge), px(72)), ep, font=f_badge, fill=(226, 218, 204))

    # ---------- 主標題：金色描邊 ----------
    title = "回南部那天"
    f_title = font(F_BOLD, px(176))
    sp = px(4)
    tw = text_width(title, f_title, sp)
    if tw > W - M * 2:                                   # 字太寬就自動降級字級
        f_title = font(F_BOLD, int(px(176) * (W - M * 2) / tw))
        tw = text_width(title, f_title, sp)
    th = px(260)
    layer, _ = gradient_text((int(tw) + px(60), th), title, f_title, GOLD,
                             stroke_w=px(11), stroke_fill=GOLD_STROKE, spacing=sp)
    shadow = layer.filter(ImageFilter.GaussianBlur(px(9)))
    ty = int(H * 0.685)
    img.alpha_composite(shadow, ((W - layer.width) // 2, ty + px(10)))
    img.alpha_composite(layer, ((W - layer.width) // 2, ty))

    # ---------- 書名號（另外畫，避免佔用標題字寬）----------
    # 依兩種字級的實際字身 bbox 對齊垂直中心，不能直接用同一個 y。
    f_bk = font(F_BOLD, px(104))
    tb = d.textbbox((0, 0), "回", font=f_title)
    bb = d.textbbox((0, 0), "《", font=f_bk)
    by = ty + (tb[1] + tb[3]) / 2 - (bb[1] + bb[3]) / 2
    bkw = d.textlength("《", font=f_bk)
    for ch, bx in [("《", (W - layer.width) // 2 - bkw - px(2)),
                   ("》", (W + layer.width) // 2 + px(2))]:
        d.text((bx, by), ch, font=f_bk, fill=(243, 168, 38),
               stroke_width=px(7), stroke_fill=GOLD_STROKE)

    # ---------- 副標 ----------
    f_sub = font(F_BOLD, px(34))
    sub = "他怕的不是電，是回不了家"
    d.text(((W - text_width(sub, f_sub, px(2))) / 2, ty + px(232)), sub,
           font=f_sub, fill=CREAM, stroke_width=px(4), stroke_fill=(20, 12, 6))

    # ---------- 顧慮標籤 ----------
    f_tag = font(F_REG, px(22))
    tag = "對應顧慮　充電不方便 66%　·　里程焦慮 40%"
    d.text(((W - text_width(tag, f_tag, px(1))) / 2, ty + px(298)), tag,
           font=f_tag, fill=(206, 196, 180))

    # ---------- 底部資訊 ----------
    f_ft = font(F_REG, px(21))
    fy = H - px(78)
    d.rectangle([M, fy - px(24), W - M, fy - px(24) + 1], fill=(255, 255, 255, 46))
    d.text((M, fy), "隊伍：請下一隊上場", font=f_ft, fill=(214, 205, 190))
    url = "github.com/WEICHENG28/TOYOTA-EV"
    d.text((W - M - d.textlength(url, font=f_ft), fy), url, font=f_ft, fill=(168, 160, 148))

    return img.convert("RGB")


def main() -> int:
    ap = argparse.ArgumentParser(description="產生 EP1 短劇海報（直式）")
    ap.add_argument("--photo", type=Path, default=None, help="攝影底圖；未提供則用漸層佔位")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--fx", type=float, default=0.5, help="裁切水平錨點 0–1")
    ap.add_argument("--fy", type=float, default=0.35, help="裁切垂直錨點 0–1")
    ap.add_argument("--zoom", type=float, default=1.0, help="往主體推近的倍率")
    ap.add_argument("--warm", type=float, default=1.0, help="黃昏色調強度，0 為不調色")
    ap.add_argument("--fit", default="cover", choices=["cover", "width"],
                    help="cover=裁切填滿（直式素材）；width=完整照片疊在模糊底上（橫幅素材）")
    ap.add_argument("--top", type=float, default=0.16, help="fit=width 時照片的垂直位置 0–1")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    if a.photo and not a.photo.exists():
        print(f"[錯誤] 找不到圖檔：{a.photo}", file=sys.stderr)
        return 1

    W = int(1200 * a.scale)
    H = int(W * 4 / 3)                                   # 3:4 直式，與短劇海報比例相近
    img = build(W, H, a.photo, a.fx, a.fy, a.zoom, a.warm, a.fit, a.top)

    outdir = Path(__file__).resolve().parent.parent / "assets"
    outdir.mkdir(exist_ok=True)
    path = outdir / (a.out or ("poster_ep1.png" if a.photo else "poster_ep1_placeholder.png"))
    img.save(path, "PNG")
    print(f"{path}　{W}×{H}　底圖：{'照片 ' + a.photo.name if a.photo else '程式繪製佔位'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
