const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h\u001B[2J\u001B[H";
const LEAVE_ALTERNATE_SCREEN = "\u001B[0m\u001B[?2004l\u001B[<u\u001B[>4;0m\u001B[?1049l\u001B[?25h";

export interface TerminalScreenGuard {
  restore(): void;
}

/** 持有全屏终端缓冲区，并保证父 shell 只恢复一次。 */
export function enterTerminalScreen(output: NodeJS.WriteStream = process.stdout): TerminalScreenGuard {
  let active = output.isTTY === true;
  const restore = () => {
    if (!active) return;
    active = false;
    output.write(LEAVE_ALTERNATE_SCREEN);
  };
  if (active) output.write(ENTER_ALTERNATE_SCREEN);
  process.once("exit", restore);
  return {
    restore() {
      process.off("exit", restore);
      restore();
    },
  };
}
