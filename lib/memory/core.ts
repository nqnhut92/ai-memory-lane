// Helpers for the Core instructions: one owner-written document every agent gets first from memory_search. The text that
// starts a new database lives in core-seed.ts.

/** Heading agents see above the text: which version, where it comes from and where it ranks. */
export function coreHeading(version: number): string {
  return `Core instructions, version ${version} (written by the owner; highest priority: the owner's words in the current conversation override them, and they override skills and every memory below)`;
}

/** Same text the owner typed, minus Windows line endings and trailing spaces; line breaks are kept. */
export function cleanCore(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}
