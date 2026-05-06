/**
 * Cheap structural counts over fetched HTML so the LLM cannot contradict obvious facts
 * (e.g. "multiple h1" when there is only one literal <h1> in document markup).
 */

export function htmlForStructuralFacts(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ");
}

/** Count opening tags `<tagName` after stripping inert regions (case-insensitive). */
export function countOpenTags(html: string, tagName: string): number {
  const cleaned = htmlForStructuralFacts(html);
  const re = new RegExp(`<${tagName}\\b`, "gi");
  return (cleaned.match(re) || []).length;
}
