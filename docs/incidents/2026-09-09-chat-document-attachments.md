# Chat document attachment failures

- Date: 2026-09-09, Asia/Seoul (UTC+09:00).
- Status: HWPX, text PDF, and bundled Windows CPU OCR verified locally.
- Recovery completed: 2026-09-10, Asia/Seoul (UTC+09:00).
- Symptoms: HWPX drops were rejected; the user reported that AI said it could
  not read an attached PDF.
- Confirmed: Docs attachment allowlist and shared text parser omitted HWPX.
  PDF text extraction existed, but contents were only exposed when the model
  chose read_attachment. Empty PDF extraction was reported as successful.
- The supplied 18-page PDF has no extractable text. Windows OCR initially
  recovered 3,632 characters. The user requested a stronger CPU OCR engine
  and then selected application bundling instead of Oracle VM hosting.
- Response: add ordered HWPX section/table text extraction, allow HWPX in Docs
  attachments, provide bounded PDF/HWPX excerpts before the first model turn,
  and report empty PDFs as requiring OCR rather than claiming successful read.
- Verification: shared parser tests passed 32/32; Docs typecheck passed.
- Local recovery: bundled Python 3.12, PaddlePaddle 3.2.2, PaddleOCR 3.3.2,
  PP-OCRv5 mobile detection and Korean mobile recognition. The portable
  resource is approximately 742 MB before installer compression. No server
  or separately installed Python is required.
- Korean image-PDF smoke: date, supplies and amount recovered in 16.39 seconds
  within the OCR routine (process/import startup is additional).
- Built Electron verification: real file-backed drop events accepted HWPX and
  PDF; parser returned fixture text. The user-provided 18-page image-only PDF
  returned 4,006 characters through the bundled PaddleOCR process. This proves
  extraction, not complete transcription accuracy or table reconstruction.
- Windows shell build, typecheck and focused lint passed. The app uses a hidden
  child process and a local model directory; the remote endpoint code was removed.
- Trial Oracle service was stopped; port 8767 no longer listens. The temporary
  VM environment remains on disk but is not used by the app.
- Limits: CPU OCR returns page-tagged text, not reconstructed table structure;
  HWP5 import remains unsupported. Windows x64 bundle only; no new installer
  or store release has been produced.
