import { getEncoding } from "js-tiktoken";

let encoding: ReturnType<typeof getEncoding> | undefined;

export function responseTokens(text: string): { encoding: "cl100k_base"; count: number } {
  encoding ??= getEncoding("cl100k_base");
  return { encoding: "cl100k_base", count: encoding.encode(text, [], []).length };
}
