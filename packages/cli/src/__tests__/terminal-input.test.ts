import { describe, expect, it } from "vitest";
import { isKeyboardProtocolResponse, TerminalInputDecoder } from "../terminal/input.js";

describe("terminal input protocol", () => {
  it("distinguishes plain, Kitty, xterm, legacy iTerm, and Ctrl+J Enter", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push("\r")).toMatchObject([{ type: "key", key: "enter", shift: false, ctrl: false }]);
    expect(decoder.push("\u001b[13;2u")).toMatchObject([{ type: "key", key: "enter", shift: true }]);
    expect(decoder.push("\u001b[13;2:2u")).toMatchObject([{ type: "key", key: "enter", shift: true }]);
    expect(decoder.push("\u001b[13;2:3u")).toEqual([]);
    expect(decoder.push("\u001b[27;2;13~")).toMatchObject([{ type: "key", key: "enter", shift: true }]);
    expect(decoder.push("\u001b\r")).toMatchObject([{ type: "key", key: "enter", shift: true }]);
    expect(decoder.push("\n")).toMatchObject([{ type: "key", key: "enter", ctrl: true }]);
    expect(decoder.push("\u001b\u007f")).toMatchObject([{ type: "key", key: "backspace", alt: true }]);
  });

  it("keeps bracketed paste together across chunks", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push("\u001b[200~first\r\n")).toEqual([]);
    expect(decoder.push("second\u001b[201~")).toEqual([{ type: "text", text: "first\nsecond", paste: true }]);
  });

  it("normalizes legacy, Kitty, and xterm control characters without inserting text", () => {
    const decoder = new TerminalInputDecoder();
    for (const character of ["a", "c", "e", "h", "j", "k", "o", "u", "v", "w"]) {
      const codepoint = character.codePointAt(0)!;
      const rawKey = character === "h" ? "backspace" : character === "j" ? "enter" : "character";
      expect(decoder.push(String.fromCharCode(codepoint & 0x1f))).toMatchObject([{ type: "key", key: rawKey, ...(rawKey === "character" ? { character } : {}), ctrl: character !== "h" }]);
      expect(decoder.push(`\u001b[${codepoint};5u`)).toMatchObject([{ type: "key", key: "character", character, ctrl: true }]);
      expect(decoder.push(`\u001b[${codepoint};5:3u`)).toEqual([]);
    }
    expect(decoder.push("\u001f")).toMatchObject([{ type: "key", key: "character", character: "-", ctrl: true }]);
    expect(decoder.push("\u001b[45;5u")).toMatchObject([{ type: "key", key: "character", character: "-", ctrl: true }]);
    expect(decoder.push("\u001b[3;5u")).toMatchObject([{ type: "key", key: "character", character: "c", ctrl: true }]);
    expect(decoder.push("\u001b[27;5;99~")).toMatchObject([{ type: "key", key: "character", character: "c", ctrl: true }]);
    expect(decoder.push("\u001b[1089::99;5u")).toMatchObject([{ type: "key", key: "character", character: "c", ctrl: true }]);
    expect(decoder.push("\u001b[97:65;2u")).toEqual([{ type: "text", text: "A", paste: false }]);
  });

  it("normalizes navigation and ignores every Kitty release form", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push("\u001b[A")).toMatchObject([{ type: "key", key: "up" }]);
    expect(decoder.push("\u001b[1;2:1A")).toMatchObject([{ type: "key", key: "up", shift: true }]);
    expect(decoder.push("\u001b[1;2:3A")).toEqual([]);
    expect(decoder.push("\u001b[3;1~")).toMatchObject([{ type: "key", key: "delete" }]);
    expect(decoder.push("\u001b[3;1:3~")).toEqual([]);
    expect(decoder.push("\u001b[57417;1u")).toMatchObject([{ type: "key", key: "left" }]);
    expect(decoder.push("\u001b[57419;3u")).toMatchObject([{ type: "key", key: "up", alt: true }]);
    expect(decoder.push("\u001b[57419;3:3u")).toEqual([]);
    expect(decoder.push("\u001b[57426;1u")).toMatchObject([{ type: "key", key: "delete" }]);
    expect(decoder.push("\u001b[57425;1u")).toEqual([]);
    expect(decoder.push("\u001b\u001b[A")).toMatchObject([{ type: "key", key: "up", alt: true }]);
    expect(decoder.push("\u001bb")).toMatchObject([{ type: "key", key: "left", alt: true }]);
    expect(decoder.push("\u001bf")).toMatchObject([{ type: "key", key: "right", alt: true }]);
  });

  it("suppresses duplicate Kitty printables and preserves WezTerm Escape presses", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push("\u001b[97u")).toEqual([{ type: "text", text: "a", paste: false }]);
    expect(decoder.push("a")).toEqual([]);
    expect(decoder.push("\u001b\u001b[27;1:3u")).toMatchObject([{ type: "key", key: "escape" }]);
  });

  it("splits batched IME text from control keys without splitting graphemes", () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push("你好🙂x\u007f")).toEqual([
      { type: "text", text: "你好🙂x", paste: false },
      { type: "key", key: "backspace", ctrl: false, shift: false, alt: false, raw: "\u007f" },
    ]);
    expect(decoder.push("中文\r")).toMatchObject([
      { type: "text", text: "中文", paste: false },
      { type: "key", key: "enter", shift: true },
    ]);
  });

  it("filters protocol responses from composer input", () => {
    expect(isKeyboardProtocolResponse("\u001b[?7u")).toBe("kitty");
    expect(isKeyboardProtocolResponse("\u001b[?0u")).toBe("fallback");
    expect(isKeyboardProtocolResponse("\u001b[?1;2c")).toBe("fallback");
    expect(new TerminalInputDecoder().push("\u001b[999;1z")).toEqual([]);
  });
});
