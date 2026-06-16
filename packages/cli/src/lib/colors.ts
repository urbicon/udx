const enabled = !process.env.NO_COLOR && process.stdout.isTTY;

function wrap(open: number, close: number) {
  return (s: string): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39)
};
