# -*- coding: utf-8 -*-
"""生成扩展图标:渐变圆角底 + 五角星 + 播放键,输出 16/48/128 三种尺寸"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "icons"))
S = 1024  # 超采样画布,最后缩小到目标尺寸抗锯齿


def gradient_rounded_square(size, top_color, bottom_color, radius_ratio=0.23):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # 先在小画布上做对角渐变再放大,避免逐像素循环
    g = Image.new("RGB", (256, 256))
    gp = g.load()
    for y in range(256):
        for x in range(256):
            t = (x + y) / 510.0
            gp[x, y] = tuple(
                int(top_color[i] + (bottom_color[i] - top_color[i]) * t)
                for i in range(3)
            )
    g = g.resize((size, size), Image.BILINEAR).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    img.paste(g, (0, 0), mask)
    return img


def star_points(cx, cy, outer, inner, points=5):
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = -math.pi / 2 + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def make_icon(star_color, play_color, top_color, bottom_color, out_prefix):
    img = gradient_rounded_square(S, top_color, bottom_color)
    draw = ImageDraw.Draw(img)
    cx = cy = S / 2
    outer = S * 0.36
    inner = outer * 0.47  # 星形偏饱满,给中心播放键留空间
    draw.polygon(star_points(cx, cy, outer, inner), fill=star_color)

    # 星心播放三角(指向右侧)
    tw, th = outer * 0.30, outer * 0.27  # 半宽/半高
    draw.polygon(
        [(cx - tw * 0.72, cy - th), (cx - tw * 0.72, cy + th), (cx + tw * 1.15, cy)],
        fill=play_color,
    )

    for size in (16, 48, 128):
        img.resize((size, size), Image.LANCZOS).save(
            os.path.join(OUT, f"{out_prefix}{size}.png")
        )
    # 预览用大图
    img.resize((256, 256), Image.LANCZOS).save(
        os.path.join(HERE, f"preview_{out_prefix}.png")
    )


# 方案A:蓝色渐变底 + 白星 + 蓝色播放键
make_icon(
    star_color=(255, 255, 255, 255),
    play_color=(37, 99, 235, 255),
    top_color=(91, 157, 255, 255),
    bottom_color=(28, 78, 226, 255),
    out_prefix="icon",
)

# 方案B:深蓝渐变底 + 金星 + 深蓝播放键
make_icon(
    star_color=(255, 205, 74, 255),
    play_color=(24, 52, 132, 255),
    top_color=(64, 108, 255, 255),
    bottom_color=(21, 42, 140, 255),
    out_prefix="alt_",
)

print("done")
