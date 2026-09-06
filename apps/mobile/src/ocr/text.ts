export type RecognizedPage = { page: number; text: string };

export function joinRecognizedPages(pages: readonly RecognizedPage[]): string {
  return pages.map(({ text }) => text.trim()).filter(Boolean).join("\n\n");
}

export function searchRecognizedPages(pages: readonly RecognizedPage[], query: string): RecognizedPage[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? pages.filter(({ text }) => text.toLocaleLowerCase().includes(needle)) : [];
}
