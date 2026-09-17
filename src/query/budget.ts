import { maximumTextResponseCodeUnits } from "../types.js";

export function boundText(text: string, maxCodeUnits: number = maximumTextResponseCodeUnits): string {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 256) {
    throw new RangeError("osnova: text budget must be a safe integer of at least 256 code units");
  }
  if (text.length <= maxCodeUnits) return text;
  const notice = (omitted: number): string =>
    `\n[output truncated: ${omitted} UTF-16 code units omitted; counts above describe the query result before output clipping. Use the API or narrow the query.]`;
  let end = maxCodeUnits - notice(text.length).length;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end) + notice(text.length - end);
}

export const maximumPlumbCodeUnits = 4_096;
