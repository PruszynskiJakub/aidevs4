const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function format(color: string, prefix: string, message: string): string {
  return `${color}${prefix}${RESET} ${message}`;
}

export function duration(startMs: number): string {
  const elapsed = (performance.now() - startMs) / 1000;
  return `[${elapsed.toFixed(2)}s]`;
}

export const log = {
  info(message: string) {
    console.log(format(CYAN, "ℹ", message));
  },

  success(message: string) {
    console.log(format(GREEN, "✓", message));
  },

  error(message: string) {
    console.log(format(RED, "✗", message));
  },

  debug(message: string) {
    console.log(format(DIM, "·", message));
  },
};
