/** Build-time and shell-provided modules this bundle uses. */
declare module '*.css' {
  const text: string
  export default text
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'

  export const MarkdownText: ComponentType<{
    text: string
    labels: { code: { copyLabel: string; copiedLabel: string }; footnotes: string }
    variant?: 'body' | 'compact'
    omitHtml?: boolean
  }>
}
