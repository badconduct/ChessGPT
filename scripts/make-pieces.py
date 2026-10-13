"""Build local GIF assets. Pillow and Windows Segoe UI Symbol are build-only.
The browser does not need the font, Python, or Unicode chess support.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

target = Path(__file__).resolve().parents[1] / "public" / "pieces"
target.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype("C:/Windows/Fonts/seguisym.ttf", 82)
for color in "wb":
    for piece, offset in zip("kqrbnp", range(6)):
        char = chr((0x2654 if color == "w" else 0x265A) + offset)
        outline = Image.new("L", (96, 96), 0)
        draw = ImageDraw.Draw(outline)
        box = draw.textbbox((0, 0), char, font=font)
        pos = ((96 - (box[2] - box[0])) / 2 - box[0],
               (96 - (box[3] - box[1])) / 2 - box[1])
        draw.text(pos, char, font=font, fill=255)
        binary = outline.point(lambda value: 255 if value >= 100 else 0)
        outside = binary.copy()
        ImageDraw.floodfill(outside, (0, 0), 128)
        silhouette = outside.point(lambda value: 0 if value == 128 else 255)
        im = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
        im.paste((249, 248, 231, 255) if color == "w" else (28, 36, 24, 255),
                 (0, 0, 96, 96), silhouette)
        im.paste((28, 36, 24, 255), (0, 0, 96, 96), outline)
        im = im.resize((48, 48), Image.Resampling.LANCZOS)
        pal = im.convert("RGB").quantize(colors=254)
        pal.paste(255, mask=im.getchannel("A").point(lambda value: 255 if value < 80 else 0))
        pal.save(target / (color + piece + ".gif"), transparency=255)
