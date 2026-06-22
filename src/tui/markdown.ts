/**
 * ponytail: lightweight markdown-to-ANSI renderer.
 * Handles common patterns only — no deps, no nesting, no tables.
 * Add more patterns when they start showing up in real output.
 */

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
};

/** Convert a markdown string to ANSI-colored terminal output. */
export function renderMarkdown(text: string): string {
  // Pre-process: extract fenced code blocks so inline rules don't fire inside them
  const fences: string[] = [];
  let out = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `\x00FENCE${fences.length - 1}\x00`;
  });

  // Headers
  out = out.replace(/^### (.+)$/gm, `${C.bold}$1${C.reset}`);
  out = out.replace(/^## (.+)$/gm, `${C.bold}$1${C.reset}`);
  out = out.replace(/^# (.+)$/gm, `${C.bold}$1${C.reset}`);

  // Bold / italic
  out = out.replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`);
  out = out.replace(/\*(.+?)\*/g, `${C.italic}$1${C.reset}`);

  // Inline code
  out = out.replace(/`([^`]+)`/g, `${C.dim}$1${C.reset}`);

  // Restore fenced code blocks
  out = out.replace(/\x00FENCE(\d+)\x00/g, (_, i) => {
    const f = fences[+i];
    // Strip the opening/closing ``` markers, indent content
    const lines = f.split("\n");
    const inner = lines.slice(1, -1).map((l: string) => `  ${C.dim}${l}${C.reset}`).join("\n");
    const lang = lines[0].replace(/^```/, "").trim();
    const header = lang ? `${C.dim}┌─ ${lang} ─${C.reset}` : `${C.dim}┌─ code ─${C.reset}`;
    return `\n${header}\n${inner}\n${C.dim}└─${C.reset}`;
  });

  return out;
}
