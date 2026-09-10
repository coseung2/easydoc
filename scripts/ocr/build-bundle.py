"""Assemble the Windows x64 OCR resource from a prepared environment and models."""
from pathlib import Path
import shutil,zipfile,json
root=Path(__file__).resolve().parents[2]
scratch=root/'.task'
dest=scratch/'paddle-bundle'
dest.mkdir(exist_ok=True)
with zipfile.ZipFile(scratch/'python-embed.zip') as archive:
    archive.extractall(dest)
(dest/'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n')
shutil.copytree(scratch/'paddle-runtime/Lib/site-packages',dest/'Lib/site-packages',dirs_exist_ok=True,
    ignore=shutil.ignore_patterns('__pycache__','pip','pip-*','PyInstaller','pyinstaller*'))
for name in ['PP-OCRv5_mobile_det','korean_PP-OCRv5_mobile_rec']:
    shutil.copytree(scratch/name,dest/'models'/name,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.cache'))
shutil.copyfile(root/'scripts/ocr/local-ocr.py',dest/'local-ocr.py')
print(json.dumps({'bundle':str(dest),'bytes':sum(p.stat().st_size for p in dest.rglob('*') if p.is_file())}))
