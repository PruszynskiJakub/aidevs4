export function elapsed(startPerfNow: number): string {
  const seconds = (performance.now() - startPerfNow) / 1000;
  return `${seconds.toFixed(2)}s`;
}