import { useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Extract the code language from a className (string or array, e.g. "language-js"). */
function languageFromProps(className) {
  const list = Array.isArray(className) ? className : [className];
  for (const c of list) {
    if (typeof c !== 'string') continue;
    const match = c.match(/^language-([\w-]+)$/);
    if (match) return match[1];
  }
  return null;
}

/** A fenced code block: header (language badge + copy) + syntax-highlighted <pre>. */
function BlockCode({ lang, children }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const preRef = useRef(null);
  const handleCopy = () => {
    const text = preRef.current?.innerText ?? '';
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-1 dark:border-zinc-700 dark:bg-zinc-800/60">
        <span className="text-[11px] font-medium text-zinc-400">{lang || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-700 focus:outline-none dark:hover:text-zinc-200"
          aria-label={t('sessions:conversation.copy_code', { defaultValue: 'Copy code' })}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          {copied ? t('sessions:conversation.copied', { defaultValue: 'Copied' }) : ''}
        </button>
      </div>
      <pre
        ref={preRef}
        className="overflow-x-auto bg-zinc-50 p-3 text-[12.5px] leading-relaxed text-zinc-800 dark:bg-black dark:text-zinc-300"
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * Markdown renderer with zinc design tokens.
 * Features: syntax highlighting (rehype-highlight, light/dark themes via CSS),
 * language badge + copy button on code blocks, KaTeX math (remark-math +
 * rehype-katex), GFM tables/lists, plain-text line breaks preserved.
 */
export default function MarkdownView({ children, className = '' }) {
  return (
    <div className={`markdown-body text-sm leading-relaxed text-zinc-800 ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          // Fenced code blocks: header (language + copy) + highlighted pre.
          pre: (props) => {
            const lang = languageFromProps(props?.node?.children?.[0]?.properties?.className);
            return <BlockCode lang={lang}>{props.children}</BlockCode>;
          },
          // Block code carries hljs/language-* classes; render it clean inside
          // the <pre> without the inline-chip styling. Inline code gets a chip.
          code: (props) => {
            const block = languageFromProps(props?.className) !== null;
            if (block) {
              return (
                <code
                  {...props}
                  className="block bg-transparent p-0 font-mono text-[12.5px] text-zinc-800 dark:text-zinc-300"
                />
              );
            }
            return (
              <code
                {...props}
                className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[12px] text-zinc-700"
              />
            );
          },
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
