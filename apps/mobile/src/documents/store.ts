import { Directory, File, Paths } from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { PDFDocument } from "pdf-lib";

export type LocalDocument = {
  id: string;
  title: string;
  uri: string;
  pageCount: number;
  size: number;
  mimeType: string;
  createdAt: number;
};

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;

async function database() {
  databasePromise ??= SQLite.openDatabaseAsync("easydoc.db");
  const db = await databasePromise;
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      uri TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function rowToDocument(row: { id: string; title: string; uri: string; page_count: number; size: number; mime_type: string; created_at: number }): LocalDocument {
  return { id: row.id, title: row.title, uri: row.uri, pageCount: row.page_count, size: row.size, mimeType: row.mime_type, createdAt: row.created_at };
}

export async function listLocalDocuments(): Promise<LocalDocument[]> {
  const db = await database();
  const rows = await db.getAllAsync<{ id: string; title: string; uri: string; page_count: number; size: number; mime_type: string; created_at: number }>("SELECT * FROM documents ORDER BY created_at DESC");
  return rows.map(rowToDocument);
}

export async function deleteLocalDocument(id: string): Promise<void> {
  const db = await database();
  const row = await db.getFirstAsync<{ uri: string }>("SELECT uri FROM documents WHERE id = ?", id);
  await db.runAsync("DELETE FROM documents WHERE id = ?", id);
  if (row?.uri) {
    const directory = new Directory(Paths.dirname(row.uri));
    if (directory.exists) directory.delete();
  }
}

function fitImage(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

export async function createScannedPdf(pageUris: string[], title = `스캔_${new Date().toISOString().slice(0, 10)}.pdf`): Promise<LocalDocument> {
  if (pageUris.length === 0) throw new Error("scan_has_no_pages");
  const id = crypto.randomUUID();
  const documentDirectory = new Directory(Paths.document, "EasyDoc", "scans", id);
  documentDirectory.create({ intermediates: true, idempotent: true });
  const pdf = await PDFDocument.create();
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 18;

  for (let index = 0; index < pageUris.length; index += 1) {
    const source = new File(pageUris[index]!);
    const bytes = await source.bytes();
    let image;
    try { image = await pdf.embedJpg(bytes); } catch { image = await pdf.embedPng(bytes); }
    const fitted = fitImage(image.width, image.height, pageWidth - margin * 2, pageHeight - margin * 2);
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: (pageWidth - fitted.width) / 2, y: (pageHeight - fitted.height) / 2, width: fitted.width, height: fitted.height });
    const extension = source.extension || ".jpg";
    const pageFile = new File(documentDirectory, `page_${String(index + 1).padStart(3, "0")}${extension.startsWith(".") ? extension : `.${extension}`}`);
    source.copy(pageFile);
  }

  const pdfFile = new File(documentDirectory, "document.pdf");
  pdfFile.create({ overwrite: true, intermediates: true });
  pdfFile.write(await pdf.save({ useObjectStreams: true }));
  const createdAt = Date.now();
  const document: LocalDocument = { id, title, uri: pdfFile.uri, pageCount: pageUris.length, size: pdfFile.size, mimeType: "application/pdf", createdAt };
  const db = await database();
  await db.runAsync(
    "INSERT INTO documents (id, title, uri, page_count, size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    document.id, document.title, document.uri, document.pageCount, document.size, document.mimeType, document.createdAt,
  );
  return document;
}
