export async function copyFileAndMeasure<T extends { size: number }>(source: { copy(destination: T): Promise<void> }, target: T): Promise<number> {
  await source.copy(target);
  const size = target.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("저장한 파일의 크기를 확인할 수 없습니다.");
  return size;
}
