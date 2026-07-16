import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "@runharness/providers";

/** 从宿主剪贴板读取图片字节，不向目标项目写入临时文件。 */
export async function readClipboardImage(): Promise<{ name: string; bytes: Buffer }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runharness-clipboard-"));
  const file = path.join(directory, "clipboard.png");
  try {
    if (process.platform === "darwin") await captureMacImage(file);
    else if (process.platform === "win32") await captureWindowsImage(file);
    else await captureLinuxImage(file);
    return { name: "clipboard.png", bytes: await readFile(file) };
  } catch (error) {
    throw new Error(`No readable image on the clipboard: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 剪贴板中没有受支持图片时读取纯文本。 */
export async function readClipboardText(): Promise<string> {
  if (process.platform === "darwin") {
    const result = await runProcess("pbpaste", [], { cwd: os.tmpdir(), timeoutMs: 5_000 });
    if (result.code === 0) return result.stdout;
  } else if (process.platform === "win32") {
    const result = await runProcess("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { cwd: os.tmpdir(), timeoutMs: 5_000 });
    if (result.code === 0) return result.stdout;
  } else {
    const result = await runProcess("/bin/sh", ["-c", "if command -v wl-paste >/dev/null 2>&1; then wl-paste --no-newline; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -o; else exit 127; fi"], { cwd: os.tmpdir(), timeoutMs: 5_000 });
    if (result.code === 0) return result.stdout;
  }
  throw new Error("No readable text on the clipboard");
}

async function captureMacImage(file: string): Promise<void> {
  const script = `set imageData to the clipboard as «class PNGf»\nset targetFile to open for access POSIX file ${appleString(file)} with write permission\ntry\nset eof targetFile to 0\nwrite imageData to targetFile\nfinally\nclose access targetFile\nend try`;
  const result = await runProcess("osascript", ["-e", script], { cwd: os.tmpdir(), timeoutMs: 5_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "clipboard does not contain PNG image data");
}

async function captureWindowsImage(file: string): Promise<void> {
  const escaped = file.replaceAll("'", "''");
  const script = `Add-Type -AssemblyName System.Windows.Forms; $image=[Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 1 }; $image.Save('${escaped}', [Drawing.Imaging.ImageFormat]::Png)`;
  const result = await runProcess("powershell", ["-NoProfile", "-Command", script], { cwd: os.tmpdir(), timeoutMs: 5_000 });
  if (result.code !== 0) throw new Error("clipboard does not contain image data");
}

async function captureLinuxImage(file: string): Promise<void> {
  const shell = `if command -v wl-paste >/dev/null 2>&1; then wl-paste --type image/png > "$1"; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -t image/png -o > "$1"; else exit 127; fi`;
  const result = await runProcess("/bin/sh", ["-c", shell, "runharness", file], { cwd: os.tmpdir(), timeoutMs: 5_000 });
  if (result.code !== 0) throw new Error(result.code === 127 ? "install wl-clipboard or xclip" : "clipboard does not contain PNG image data");
}

function appleString(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
