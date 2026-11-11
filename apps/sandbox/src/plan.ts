import type { Block, ModelMessage } from "./model.js";

/** Shared pieces for the scripted (demo) agent: building tool calls and reading results back. */
export type Results = Array<{ name: string; input: any; output: any; raw: string }>;
export interface Ctx {
  base: string;
  history: ModelMessage[];
}
export type Step = (r: Results, ctx: Ctx) => Block[];

let n = 0;
const id = () => `mock_${++n}_${Math.random().toString(36).slice(2, 8)}`;
export const say = (text: string): Block => ({ type: "text", text });
export const call = (name: string, input: unknown): Block => ({ type: "tool_use", id: id(), name, input });
export const parse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
export const last = (r: Results, name: string) => [...r].reverse().find((x) => x.name === name);
export const all = (r: Results, name: string) => r.filter((x) => x.name === name);
/** 1234567 cents -> "R12 345.67" (spaces between thousands, a dot before the cents), whatever the runtime's locale. */
const money2 = (cents: number) => {
  const [i, d] = (Math.abs(cents) / 100).toFixed(2).split(".");
  return `${cents < 0 ? "-" : ""}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${d}`;
};
export const rands = (cents: number) => `R${money2(cents)}`;
export const usd = (cents: number) => `$${money2(cents).replace(/ /g, ",")}`;
export const units6 = (v: string | number | undefined) => (Number(v ?? 0) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 });

export const lastUserText = (history: ModelMessage[]) =>
  String([...history].reverse().find((m) => m.role === "user" && typeof m.content === "string")?.content ?? "");

/** Tool results since the visitor's latest message, paired with the call that made them. */
export function resultsSinceLastUserMessage(history: ModelMessage[]): { results: Results; turns: number } {
  let start = history.length - 1;
  while (start >= 0 && !(history[start]!.role === "user" && typeof history[start]!.content === "string")) start--;
  const uses = new Map<string, { name: string; input: any }>();
  const results: Results = [];
  let turns = 0;
  for (const m of history.slice(start + 1)) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      turns++;
      for (const b of m.content) if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input });
    } else if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "tool_result") {
        const u = uses.get(b.tool_use_id);
        if (u) results.push({ ...u, raw: b.content, output: parse(b.content) });
      }
    }
  }
  return { results, turns };
}

/** The most recent thing of a kind from earlier in the conversation (a card id, a held preview). */
export function earlier(history: ModelMessage[]) {
  const uses = new Map<string, { name: string; input: any }>();
  let card: string | undefined;
  let heldCharge: any;
  let heldTransfer: string | undefined;
  for (const m of history) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input });
      if (b.type === "tool_result") {
        const u = uses.get(b.tool_use_id);
        const out = parse(b.content);
        if (u?.name === "create_card" && out?.id) card = out.id;
        if (u?.name === "pay_checkout") heldCharge = /pending_human_approval|pending_approval/.test(b.content) ? u.input : undefined;
        if (u?.name === "send_preview" && out?.decision === "require_approval") heldTransfer = out.preview_id;
        if (u?.name === "send_execute") heldTransfer = undefined;
      }
    }
  }
  return { card, heldCharge, heldTransfer };
}

/** One plain sentence for a pay_checkout / pay_x402 result. */
export const verdict = (x?: { raw: string; output: any }) => {
  const o = x?.output;
  if (o && typeof o === "object") {
    if (o.approved === true) return "approved";
    if (o.approved === false) return `declined (${o.decline_reason ?? o.declineReason ?? "no reason given"})`;
    if (o.status === "paid") return `paid${o.body ? `. The API replied: ${typeof o.body === "string" ? o.body : JSON.stringify(o.body)}` : ""}`;
    if (o.status) return String(o.status);
  }
  return (x?.raw ?? "").replace(/^Error\s*—\s*/, "").replace(/\s+/g, " ").slice(0, 160);
};
export const held = (x?: { raw: string }) => /pending_human_approval|pending_approval/.test(x?.raw ?? "");
