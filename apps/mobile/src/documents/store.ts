import type * as SQLite from "expo-sqlite";
import { copyFileAndMeasure } from "./file-copy.ts";

export type LocalDocument = {
  id: string;
  title: string;
  uri: string;
  pageCount: number;
  size: number;
  mimeType: string;
  createdAt: number;
  folderId: string | null;
};

export type LocalFolder = { id: string; name: string; createdAt: number };

export type DocumentFilter = "all" | "pdf" | "hwp" | "office" | "image";

const IMAGE_EXTENSIONS = new Set(["bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const OFFICE_EXTENSIONS = new Set(["doc", "docx", "odp", "ods", "odt", "ppt", "pptx", "xls", "xlsx"]);

function fileExtension(title: string): string {
  return title.toLocaleLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? "";
}

export function documentMatchesFilter(document: Pick<LocalDocument, "title" | "mimeType">, filter: DocumentFilter): boolean {
  if (filter === "all") return true;
  const mimeType = document.mimeType.toLocaleLowerCase();
  const extension = fileExtension(document.title);
  if (filter === "pdf") return mimeType === "application/pdf" || extension === "pdf";
  if (filter === "hwp") return ["hwp", "hwpx"].includes(extension) || mimeType.includes("hwp") || mimeType.includes("hancom");
  if (filter === "office") {
    return OFFICE_EXTENSIONS.has(extension)
      || mimeType === "application/msword"
      || mimeType.startsWith("application/vnd.ms-")
      || mimeType.startsWith("application/vnd.openxmlformats-officedocument.")
      || mimeType.startsWith("application/vnd.oasis.opendocument.");
  }
  return mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension);
}

export function filterLocalDocuments(documents: readonly LocalDocument[], query = "", filter: DocumentFilter = "all", folderId?: string | null): LocalDocument[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return documents.filter((document) => {
    const matchesQuery = !normalizedQuery || document.title.toLocaleLowerCase().includes(normalizedQuery);
    const matchesFolder = folderId === undefined || document.folderId === folderId;
    return matchesQuery && matchesFolder && documentMatchesFilter(document, filter);
  });
}

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;

async function initializeDatabase() {
  const SQLite = await import("expo-sqlite");
  const db = await SQLite.openDatabaseAsync("easydoc.db");
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      uri TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      folder_id TEXT
    );
    CREATE TABLE IF NOT EXISTS document_folders (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at INTEGER NOT NULL
    );
  `);
  const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(documents)");
  if (!columns.some((column) => column.name === "folder_id")) await db.execAsync("ALTER TABLE documents ADD COLUMN folder_id TEXT");
  return db;
}

async function database() {
  databasePromise ??= initializeDatabase();
  return databasePromise;
}

type DocumentRow = { id: string; title: string; uri: string; page_count: number; size: number; mime_type: string; created_at: number; folder_id: string | null };

function rowToDocument(row: DocumentRow): LocalDocument {
  return { id: row.id, title: row.title, uri: row.uri, pageCount: row.page_count, size: row.size, mimeType: row.mime_type, createdAt: row.created_at, folderId: row.folder_id };
}

export async function listLocalDocuments(): Promise<LocalDocument[]> {
  const db = await database();
  const rows = await db.getAllAsync<DocumentRow>("SELECT * FROM documents ORDER BY created_at DESC");
  return rows.map(rowToDocument);
}

export async function listLocalFolders(): Promise<LocalFolder[]> {
  const db = await database();
  const rows = await db.getAllAsync<{ id: string; name: string; created_at: number }>("SELECT * FROM document_folders ORDER BY name COLLATE NOCASE ASC");
  return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

export async function createLocalFolder(name: string): Promise<LocalFolder> {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 80) throw new Error("invalid_folder_name");
  const folder = { id: crypto.randomUUID(), name: normalizedName, createdAt: Date.now() };
  const db = await database();
  await db.runAsync("INSERT INTO document_folders (id, name, created_at) VALUES (?, ?, ?)", folder.id, folder.name, folder.createdAt);
  return folder;
}

export async function moveLocalDocument(id: string, folderId: string | null): Promise<void> {
  const db = await database();
  if (folderId) {
    const folder = await db.getFirstAsync<{ id: string }>("SELECT id FROM document_folders WHERE id = ?", folderId);
    if (!folder) throw new Error("folder_not_found");
  }
  await db.runAsync("UPDATE documents SET folder_id = ? WHERE id = ?", folderId, id);
}

export async function deleteLocalDocument(id: string): Promise<void> {
  const db = await database();
  const row = await db.getFirstAsync<{ uri: string }>("SELECT uri FROM documents WHERE id = ?", id);
  await db.runAsync("DELETE FROM documents WHERE id = ?", id);
  if (row?.uri) {
    const { Directory, Paths } = await import("expo-file-system");
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
  const { Directory, File, Paths } = await import("expo-file-system");
  const { PDFDocument } = await import("pdf-lib");
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
    await copyFileAndMeasure<typeof pageFile>(source, pageFile);
  }

  const pdfFile = new File(documentDirectory, "document.pdf");
  pdfFile.create({ overwrite: true, intermediates: true });
  pdfFile.write(await pdf.save({ useObjectStreams: true }));
  const createdAt = Date.now();
  const document: LocalDocument = { id, title, uri: pdfFile.uri, pageCount: pageUris.length, size: pdfFile.size, mimeType: "application/pdf", createdAt, folderId: null };
  const db = await database();
  await db.runAsync(
    "INSERT INTO documents (id, title, uri, page_count, size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    document.id, document.title, document.uri, document.pageCount, document.size, document.mimeType, document.createdAt,
  );
  return document;
}

export async function importLocalFile(input: { uri: string; name: string; mimeType?: string | null }): Promise<LocalDocument> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const id = crypto.randomUUID();
  const safeName = input.name.replace(/[\\/]/gu, "_") || `file_${id}`;
  const documentDirectory = new Directory(Paths.document, "EasyDoc", "imports", id);
  documentDirectory.create({ intermediates: true, idempotent: true });
  const source = new File(input.uri);
  const target = new File(documentDirectory, safeName);
  const size = await copyFileAndMeasure<typeof target>(source, target);
  const document: LocalDocument = {
    id,
    title: safeName,
    uri: target.uri,
    pageCount: 0,
    size,
    mimeType: input.mimeType || target.type || "application/octet-stream",
    createdAt: Date.now(),
    folderId: null,
  };
  const db = await database();
  await db.runAsync(
    "INSERT INTO documents (id, title, uri, page_count, size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    document.id, document.title, document.uri, document.pageCount, document.size, document.mimeType, document.createdAt,
  );
  return document;
}

export async function saveGeneratedPdf(bytes: Uint8Array, title: string, pageCount: number): Promise<LocalDocument> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const id = crypto.randomUUID();
  const safeTitle = (title.replace(/[\\/]/gu, "_") || `document_${id}.pdf`).replace(/\.pdf$/iu, "") + ".pdf";
  const documentDirectory = new Directory(Paths.document, "EasyDoc", "generated", id);
  documentDirectory.create({ intermediates: true, idempotent: true });
  const target = new File(documentDirectory, safeTitle);
  target.create({ overwrite: true, intermediates: true });
  target.write(bytes);
  const document: LocalDocument = {
    id,
    title: safeTitle,
    uri: target.uri,
    pageCount,
    size: target.size,
    mimeType: "application/pdf",
    createdAt: Date.now(),
    folderId: null,
  };
  const db = await database();
  await db.runAsync(
    "INSERT INTO documents (id, title, uri, page_count, size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    document.id, document.title, document.uri, document.pageCount, document.size, document.mimeType, document.createdAt,
  );
  return document;
}
