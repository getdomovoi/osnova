export async function withSequentialExtract<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OSNOVA_EXTRACT_WORKERS;
  process.env.OSNOVA_EXTRACT_WORKERS = "0";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OSNOVA_EXTRACT_WORKERS;
    else process.env.OSNOVA_EXTRACT_WORKERS = previous;
  }
}
