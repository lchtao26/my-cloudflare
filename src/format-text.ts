import pangu from "pangu";

const PROTECTED_TEXT = /<[^>]*>|https?:\/\/[^\s<>"']+/gi;
const CLOSING_QUOTES: Record<string, string> = {
  "“": "”",
  "‘": "’",
  "「": "」",
  "『": "』",
  '"': '"',
  "'": "'",
};

/** Apply Chinese typography to plain text while preserving markup and URLs. */
export function formatText(value: string): string {
  const parts = value.split(PROTECTED_TEXT);
  const protectedParts = Array.from(value.matchAll(PROTECTED_TEXT), (match) => match[0]);
  const characters = parts.map((part) => part.split(""));
  const stack: Array<{ quote: string; part: number; index: number }> = [];

  if (/\p{Script=Han}/u.test(parts.join(""))) {
    for (let part = 0; part < characters.length; part++) {
      const text = parts[part]!;
      for (let index = 0; index < text.length; index++) {
        const quote = text[index]!;
        const previous = stack[stack.length - 1];
        if ((quote === "'" || quote === "’") && /[a-z0-9]/i.test(text[index - 1] ?? "")) {
          if (/[a-z0-9]/i.test(text[index + 1] ?? "") || (quote === "'" && previous?.quote !== "'")) continue;
        }
        if (previous && CLOSING_QUOTES[previous.quote] === quote) {
          const depth = stack.length - 1;
          if (previous.quote !== "「" && previous.quote !== "『") {
            characters[previous.part]![previous.index] = depth % 2 === 0 ? "「" : "『";
            characters[part]![index] = depth % 2 === 0 ? "」" : "』";
          }
          stack.pop();
        } else if (CLOSING_QUOTES[quote]) {
          stack.push({ quote, part, index });
        }
      }
    }
  }

  let marker = "\uE000";
  while (value.includes(marker)) marker += "\uE000";
  const tags: string[] = [];
  const urls: string[] = [];
  const text = characters.map((part, index) => {
    const protectedPart = protectedParts[index] ?? "";
    if (protectedPart.startsWith("<")) {
      tags.push(protectedPart);
      return part.join("") + protectedPart;
    }
    if (protectedPart) {
      urls.push(protectedPart);
      return part.join("") + marker + (urls.length - 1) + marker;
    }
    return part.join("");
  }).join("");

  let tagIndex = 0;
  return pangu.spaceText(text)
    .replace(/<[^>]*>/g, () => tags[tagIndex++]!)
    .replace(new RegExp(`${marker}(\\d+)${marker}`, "g"), (_, index: string) => urls[Number(index)]!);
}
