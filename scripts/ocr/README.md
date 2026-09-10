# Bundled Windows CPU OCR

GenOffice launches the bundled Python executable as a hidden child process for
image-only PDF chat attachments. It opens no listener and uses no remote OCR
endpoint. Text PDFs use the normal parser; HWPX uses XML extraction.

## Build the Windows x64 resource

1. Create `.task/paddle-runtime` with Python 3.12 and install
   `paddlepaddle==3.2.2 paddleocr==3.3.2 pypdfium2==5.13.0`.
2. Download the official Python 3.12.10 embeddable x64 ZIP to
   `.task/python-embed.zip`.
3. Prepare the official `PP-OCRv5_mobile_det` and
   `korean_PP-OCRv5_mobile_rec` model folders under `.task/`. Preserve their
   model metadata and license files.
4. Run `python scripts/ocr/build-bundle.py`.
5. Verify `.task/paddle-bundle/python.exe .task/paddle-bundle/local-ocr.py sample.pdf`.

The Windows electron-builder configuration copies `.task/paddle-bundle` into
`resources/paddle-ocr` and refuses to package a missing runtime. This resource
is x64; Windows ARM64 packaging requires an independently verified runtime.
The development app loads the same resource from `.task/paddle-bundle`.

Limits: 100 pages, five-minute process timeout, two CPU threads, and one
queued OCR process at a time. Results are text with page markers, not a table
structure reconstruction. Cached attachment text follows the existing app
mtime/size cache. No OS Python installation is required by the shipped resource.
