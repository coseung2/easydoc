"""Offline CPU OCR sidecar: one PDF path in, JSON on stdout. No server or uploads."""
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['PADDLE_PDX_CACHE_HOME'] = str(Path(os.environ.get('LOCALAPPDATA', str(root))) / 'GenOffice' / 'ocr-cache')
import contextlib
import json
import time

def run(path):
    import numpy as np
    import pypdfium2 as pdfium
    from paddleocr import PaddleOCR
    started = time.monotonic()
    ocr = PaddleOCR(device='cpu', cpu_threads=2, enable_mkldnn=False,
        use_doc_orientation_classify=False, use_doc_unwarping=False,
        use_textline_orientation=False,
        text_detection_model_name='PP-OCRv5_mobile_det',
        text_detection_model_dir=str(root / 'models' / 'PP-OCRv5_mobile_det'),
        text_recognition_model_name='korean_PP-OCRv5_mobile_rec',
        text_recognition_model_dir=str(root / 'models' / 'korean_PP-OCRv5_mobile_rec'))
    with pdfium.PdfDocument(path) as doc:
        if len(doc) > 100:
            raise ValueError('Split PDFs larger than 100 pages before OCR')
        pages = []
        for index in range(len(doc)):
            page = doc[index]
            bitmap = None
            try:
                bitmap = page.render(scale=min(2, 2200 / max(page.get_size())))
                image = np.array(bitmap.to_pil().convert('RGB'))[:, :, ::-1].copy()
                lines = [text for result in ocr.predict(image) for text in result['rec_texts']]
                pages.append({'page': index + 1, 'text': '\n'.join(lines)})
            finally:
                if bitmap: bitmap.close()
                page.close()
    return {'text': '\n\n'.join(f"[Page {p['page']}; OCR]\n{p['text']}" for p in pages if p['text'].strip()),
        'pages': len(pages), 'seconds': round(time.monotonic() - started, 2), 'engine': 'PaddleOCR CPU'}

try:
    with contextlib.redirect_stdout(sys.stderr):
        result = run(sys.argv[1])
    print(json.dumps(result, ensure_ascii=True))
except Exception as error:
    print(json.dumps({'error': str(error)}, ensure_ascii=True))
    sys.exit(1)
