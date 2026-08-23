/**
 * Build a fenced code block whose fence is strictly longer than any backtick
 * run inside `content`, so process output containing backticks can never break
 * out of the enclosing fence in model-visible text.
 */
export function codeFence(content: string): string {
  const longest = content.match(/`{3,}/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return `${fence}\n${body}\n${fence}`
}
