import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";

// Ink 只负责渲染；修饰键、粘贴帧和终端能力响应统一在此解码，避免输入行为受渲染时序影响。

const ESC = "\u001b";
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;
const ENABLE_INPUT_PROTOCOLS = `${ESC}[?2004h${ESC}[>7u${ESC}[?u${ESC}[c`;
const DISABLE_INPUT_PROTOCOLS = `${ESC}[?2004l${ESC}[<u${ESC}[>4;0m`;
const ENABLE_MODIFY_OTHER_KEYS = `${ESC}[>4;2m`;
const ESC_PATTERN = escapeRegex(ESC);
const KITTY_RESPONSE = new RegExp(`^${ESC_PATTERN}\\[\\?(\\d+)u$`);
const DEVICE_ATTRIBUTES_RESPONSE = new RegExp(`^${ESC_PATTERN}\\[\\?[\\d;]*c$`);
const KITTY_KEY = new RegExp(`^${ESC_PATTERN}\\[(\\d+)(?::(\\d*))?(?::(\\d+))?(?:;(\\d+))?(?::(\\d+))?u$`);
const MODIFY_OTHER_KEY = new RegExp(`^${ESC_PATTERN}\\[27;(\\d+);(\\d+)~$`);
const PLAIN_CSI_KEY = new RegExp(`^${ESC_PATTERN}\\[([ABCDHF])$`);
const MODIFIED_CSI_KEY = new RegExp(`^${ESC_PATTERN}\\[1;(\\d+)(?::(\\d+))?([ABCDHF])$`);
const FUNCTION_KEY = new RegExp(`^${ESC_PATTERN}\\[(2|3|5|6|7|8)(?:;(\\d+))?(?::(\\d+))?~$`);

export type TerminalKeyName = "character" | "enter" | "escape" | "tab" | "backspace" | "delete" | "up" | "down" | "left" | "right" | "home" | "end" | "pageUp" | "pageDown";

export type TerminalInputEvent =
  | { type: "text"; text: string; paste: boolean }
  | { type: "key"; key: TerminalKeyName; character?: string; ctrl: boolean; shift: boolean; alt: boolean; raw: string };

type Modifiers = { ctrl: boolean; shift: boolean; alt: boolean };

export class TerminalInputDecoder {
  private paste = false;
  private pasted = "";
  private pendingKittyPrintable: string | undefined;

  push(sequence: string): TerminalInputEvent[] {
    if (this.paste) return this.continuePaste(sequence);
    const start = sequence.indexOf(BRACKETED_PASTE_START);
    if (start >= 0) {
      this.pendingKittyPrintable = undefined;
      const events = this.decodeOrdinary(sequence.slice(0, start));
      this.paste = true;
      return [...events, ...this.continuePaste(sequence.slice(start + BRACKETED_PASTE_START.length))];
    }
    return this.decodeOrdinary(sequence);
  }

  private continuePaste(sequence: string): TerminalInputEvent[] {
    const end = sequence.indexOf(BRACKETED_PASTE_END);
    if (end < 0) { this.pasted += sequence; return []; }
    const text = this.pasted + sequence.slice(0, end);
    this.paste = false;
    this.pasted = "";
    const events: TerminalInputEvent[] = text ? [{ type: "text", text: normalizePastedText(text), paste: true }] : [];
    return [...events, ...this.push(sequence.slice(end + BRACKETED_PASTE_END.length))];
  }

  private decodeOrdinary(sequence: string): TerminalInputEvent[] {
    if (!sequence) return [];
    if (this.pendingKittyPrintable) {
      const pending = this.pendingKittyPrintable;
      this.pendingKittyPrintable = undefined;
      if (sequence === pending) return [];
    }
    const special = decodeSpecialSequence(sequence);
    if (special === "ignore") return [];
    if (special) {
      if (special.type === "text" && isUnmodifiedKittyPrintable(sequence)) this.pendingKittyPrintable = special.text;
      return [special];
    }
    if (sequence.startsWith(`${ESC}${ESC}[`)) {
      const release = decodeSpecialSequence(sequence.slice(1));
      return release === "ignore" ? [keyEvent("escape", ESC)] : [keyEvent("escape", ESC), ...(release ? [release] : [])];
    }
    // ESC 前缀字节属于终端协议或 Alt 组合键；未知序列不能落入编辑器变成可见乱码。
    if (sequence.startsWith(ESC)) return [];

    const events: TerminalInputEvent[] = [];
    let text = "";
    const imeConfirm = sequence.endsWith("\r") && [...sequence.slice(0, -1)].some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
    const flush = () => { if (text) { events.push({ type: "text", text, paste: false }); text = ""; } };
    for (const character of sequence) {
      const key = character === "\r" && imeConfirm ? keyEvent("enter", character, { shift: true }) : decodeControlCharacter(character);
      if (key) { flush(); events.push(key); }
      else text += character;
    }
    flush();
    return events;
  }
}

export function isKeyboardProtocolResponse(sequence: string): "kitty" | "fallback" | undefined {
  const kitty = sequence.match(KITTY_RESPONSE);
  if (kitty) return Number(kitty[1]) > 0 ? "kitty" : "fallback";
  if (DEVICE_ATTRIBUTES_RESPONSE.test(sequence)) return "fallback";
  return undefined;
}

export function useTerminalInput(handler: (event: TerminalInputEvent) => void): void {
  const { internal_eventEmitter: emitter, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const decoder = new TerminalInputDecoder();
    let kitty = false;
    let modifyOtherKeys = false;
    const onInput = (sequence: string) => {
      const protocol = isKeyboardProtocolResponse(sequence);
      if (protocol === "kitty") {
        kitty = true;
        if (modifyOtherKeys) { stdout.write(`${ESC}[>4;0m`); modifyOtherKeys = false; }
        return;
      }
      if (protocol === "fallback") {
        if (!kitty && !modifyOtherKeys) { stdout.write(ENABLE_MODIFY_OTHER_KEYS); modifyOtherKeys = true; }
        return;
      }
      for (const event of decoder.push(sequence)) handlerRef.current(event);
    };
    setRawMode(true);
    emitter.on("input", onInput);
    stdout.write(ENABLE_INPUT_PROTOCOLS);
    return () => {
      emitter.off("input", onInput);
      stdout.write(DISABLE_INPUT_PROTOCOLS);
      setRawMode(false);
    };
  }, [emitter, setRawMode, stdout]);
}

function decodeSpecialSequence(sequence: string): TerminalInputEvent | "ignore" | undefined {
  if (sequence === `${ESC}\r`) return keyEvent("enter", sequence, { shift: true });
  if (sequence === `${ESC}\u007f` || sequence === `${ESC}\b`) return keyEvent("backspace", sequence, { alt: true });
  if (sequence === `${ESC}[Z`) return keyEvent("tab", sequence, { shift: true });
  if (sequence === `${ESC}${ESC}[A`) return keyEvent("up", sequence, { alt: true });
  if (sequence === `${ESC}${ESC}[B`) return keyEvent("down", sequence, { alt: true });

  const kitty = sequence.match(KITTY_KEY);
  if (kitty) {
    if (Number(kitty[5] ?? 1) === 3) return "ignore";
    return fromCodepoint(
      Number(kitty[1]),
      decodeModifiers(Number(kitty[4] ?? 1) - 1),
      sequence,
      kitty[2] ? Number(kitty[2]) : undefined,
      kitty[3] ? Number(kitty[3]) : undefined,
    ) ?? "ignore";
  }

  const modify = sequence.match(MODIFY_OTHER_KEY);
  if (modify) return fromCodepoint(Number(modify[2]), decodeModifiers(Number(modify[1]) - 1), sequence) ?? "ignore";

  const names: Record<string, TerminalKeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
  const plainCsi = sequence.match(PLAIN_CSI_KEY);
  if (plainCsi?.[1]) {
    const name = names[plainCsi[1]];
    if (name) return keyEvent(name, sequence);
  }
  const modifiedCsi = sequence.match(MODIFIED_CSI_KEY);
  if (modifiedCsi) {
    if (Number(modifiedCsi[2] ?? 1) === 3) return "ignore";
    const name = modifiedCsi[3] ? names[modifiedCsi[3]] : undefined;
    if (name) return keyEvent(name, sequence, decodeModifiers(Number(modifiedCsi[1]) - 1));
  }
  const functional = sequence.match(FUNCTION_KEY);
  if (functional) {
    if (Number(functional[3] ?? 1) === 3) return "ignore";
    const functionNames: Record<string, TerminalKeyName> = { "3": "delete", "5": "pageUp", "6": "pageDown", "7": "home", "8": "end" };
    const name = functional[1] ? functionNames[functional[1]] : undefined;
    if (name) return keyEvent(name, sequence, decodeModifiers(Number(functional[2] ?? 1) - 1));
    return "ignore";
  }
  const legacy: Record<string, TerminalKeyName> = {
    [`${ESC}OA`]: "up", [`${ESC}OB`]: "down", [`${ESC}OC`]: "right", [`${ESC}OD`]: "left",
    [`${ESC}OH`]: "home", [`${ESC}OF`]: "end", [`${ESC}[1~`]: "home", [`${ESC}[4~`]: "end",
  };
  if (legacy[sequence]) return keyEvent(legacy[sequence]!, sequence);
  if (sequence === `${ESC}b`) return keyEvent("left", sequence, { alt: true });
  if (sequence === `${ESC}f`) return keyEvent("right", sequence, { alt: true });
  if (sequence.length === 2 && sequence.startsWith(ESC)) {
    const character = sequence.slice(1);
    if (character.codePointAt(0)! >= 32) return keyEvent("character", sequence, { alt: true }, character.toLowerCase());
  }
  return undefined;
}

function fromCodepoint(codepoint: number, modifiers: Modifiers, raw: string, shiftedKey?: number, baseLayoutKey?: number): TerminalInputEvent | undefined {
  const functional: Record<number, TerminalKeyName> = { 57417: "left", 57418: "right", 57419: "up", 57420: "down", 57421: "pageUp", 57422: "pageDown", 57423: "home", 57424: "end", 57426: "delete" };
  if (functional[codepoint]) return keyEvent(functional[codepoint]!, raw, modifiers);
  if (codepoint >= 57344 && codepoint <= 63743) return undefined;
  if (codepoint === 13 || codepoint === 57414) return keyEvent("enter", raw, modifiers);
  if (codepoint === 9) return keyEvent("tab", raw, modifiers);
  if (codepoint === 27) return keyEvent("escape", raw, modifiers);
  if (codepoint === 127 || codepoint === 8) return keyEvent("backspace", raw, modifiers);
  if (modifiers.ctrl && codepoint >= 1 && codepoint <= 26) return keyEvent("character", raw, modifiers, String.fromCharCode(codepoint + 96));
  if (modifiers.ctrl && codepoint === 31) return keyEvent("character", raw, modifiers, "-");
  if (codepoint < 32 || codepoint > 0x10ffff) return undefined;
  const printableCodepoint = modifiers.shift && shiftedKey !== undefined ? shiftedKey : codepoint;
  const character = String.fromCodePoint(printableCodepoint);
  if (modifiers.ctrl || modifiers.alt) {
    const identity = normalizeModifiedCharacter(codepoint, baseLayoutKey);
    return identity ? keyEvent("character", raw, modifiers, identity) : undefined;
  }
  return { type: "text", text: character, paste: false };
}

function decodeControlCharacter(character: string): TerminalInputEvent | undefined {
  if (character === "\r") return keyEvent("enter", character);
  if (character === "\n") return keyEvent("enter", character, { ctrl: true });
  if (character === "\t") return keyEvent("tab", character);
  if (character === "\u001b") return keyEvent("escape", character);
  if (character === "\u007f" || character === "\b") return keyEvent("backspace", character);
  const code = character.charCodeAt(0);
  if (code >= 1 && code <= 26) return keyEvent("character", character, { ctrl: true }, String.fromCharCode(code + 96));
  if (code === 31) return keyEvent("character", character, { ctrl: true }, "-");
  return undefined;
}

function keyEvent(name: TerminalKeyName, raw: string, modifiers: Partial<Modifiers> = {}, character?: string): TerminalInputEvent {
  return { type: "key", key: name, ...(character ? { character } : {}), ctrl: modifiers.ctrl ?? false, shift: modifiers.shift ?? false, alt: modifiers.alt ?? false, raw };
}

function decodeModifiers(mask: number): Modifiers {
  return { shift: Boolean(mask & 1), alt: Boolean(mask & 2), ctrl: Boolean(mask & 4) };
}

function normalizePastedText(value: string): string { return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "  "); }

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeModifiedCharacter(codepoint: number, baseLayoutKey?: number): string | undefined {
  const direct = String.fromCodePoint(codepoint).toLowerCase();
  if (/^[a-z0-9`\-=[\]\\;',./]$/.test(direct)) return direct;
  if (baseLayoutKey !== undefined) {
    const base = String.fromCodePoint(baseLayoutKey).toLowerCase();
    if (/^[a-z0-9`\-=[\]\\;',./]$/.test(base)) return base;
  }
  return undefined;
}

function isUnmodifiedKittyPrintable(sequence: string): boolean {
  const match = sequence.match(KITTY_KEY);
  if (!match) return false;
  const modifier = Number(match[4] ?? 1) - 1;
  return modifier === 0 && Number(match[1]) >= 32;
}
