"""Create public/logo.png (the in-app header logo) from the exe icon source.

The exe icon and the in-app logo must be the same artwork, so we derive both
from a single source file: app-icon.png (the Tauri icon source).
"""
import os
from PIL import Image

# Resolve paths relative to this script so the repo works from any checkout
# location instead of assuming one machine's absolute path.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'app-icon.png')
PUB = os.path.join(ROOT, 'public')

os.makedirs(PUB, exist_ok=True)
im = Image.open(SRC).convert('RGBA')
print('source', im.size, os.path.getsize(SRC), 'bytes')

# Displayed at 56px, so 192px covers high-DPI screens with room to spare.
out = im.resize((192, 192), Image.LANCZOS)
dst = os.path.join(PUB, 'logo.png')
out.save(dst, optimize=True)
print('saved', dst, out.size, os.path.getsize(dst), 'bytes')
