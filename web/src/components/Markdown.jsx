import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * Markdown renderer with zinc design tokens.
 * Used where message/transcript content may contain markdown (code blocks,
 * lists, emphasis), while still preserving plain-text line breaks via
 * remark-breaks.
 */
export default function MarkdownView({ children, className = '' }) {
  return (
    <div className={`markdown-body text-sm leading-relaxed text-zinc-800 ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // Fenced code blocks that follow the theme: light mode gets a light
          // surface with dark text; dark mode gets a black surface with light
          // text. The zinc palette is inverted in .dark, so the base
          // bg-zinc-100/text-zinc-800 already flip automatically; dark:bg-black
          // makes the dark-mode block a true pure-black surface.
          pre: (props) => (
            <pre
              {...props}
              className="my-2 overflow-x-auto rounded-lg bg-zinc-100 p-3 text-[12.5px] leading-relaxed text-zinc-800 dark:bg-black [&_code]:bg-transparent [&_code]:px-0 [&_code]:py-0 [&_code]:text-[12.5px] [&_code]:text-zinc-800"
            />
          ),
          // Inline code gets a subtle zinc chip. Block code (inside <pre>) is
          // overridden by the pre child selectors above.
          code: (props) => (
            <code
              {...props}
              className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[12px] text-zinc-700"
            />
          ),
          p: (props) => <p {...props} className="my-1.5 last:mb-0" />,
          a: (props) => (
            <a {...props} className="text-zinc-900 underline underline-offset-2" target="_blank" rel="noreferrer" />
          ),
          ul: (props) => <ul {...props} className="my-1.5 list-disc space-y-1 pl-5" />,
          ol: (props) => <ol {...props} className="my-1.5 list-decimal space-y-1 pl-5" />,
          li: (props) => <li {...props} className="leading-relaxed" />,
          h1: (props) => <h1 {...props} className="my-2 text-base font-semibold text-zinc-900" />,
          h2: (props) => <h2 {...props} className="my-2 text-[15px] font-semibold text-zinc-900" />,
          h3: (props) => <h3 {...props} className="my-2 text-sm font-semibold text-zinc-900" />,
          h4: (props) => <h4 {...props} className="my-2 text-sm font-semibold text-zinc-900" />,
          h5: (props) => <h5 {...props} className="my-2 text-sm font-semibold text-zinc-900" />,
          h6: (props) => <h6 {...props} className="my-2 text-sm font-semibold text-zinc-900" />,
          blockquote: (props) => (
            <blockquote {...props} className="my-2 border-l-2 border-zinc-300 pl-3 text-zinc-500" />
          ),
          hr: () => <hr className="my-3 border-zinc-200" />,
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table {...props} className="w-full border-collapse text-[13px]" />
            </div>
          ),
          th: (props) => (
            <th {...props} className="border border-zinc-200 bg-zinc-50 px-2 py-1 text-left font-semibold text-zinc-700" />
          ),
          td: (props) => (
            <td {...props} className="border border-zinc-200 px-2 py-1 text-zinc-700" />
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
