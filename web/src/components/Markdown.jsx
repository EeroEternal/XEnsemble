import { createContext, useContext, useRef, useState } from 'react';
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
    const match = c.match(/(?:^|\s)language-([\w-]+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * react-markdown v10 passes a `node` prop to every component; spreading it onto
 * DOM elements leaks node="[object Object]" attributes. Strip it out.
 */
function stripNode(props) {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

/** Tells <code> whether it sits inside a <pre> (fenced block) vs inline text. */
const BlockCodeContext = createContext(false);

/** A fenced code block: header (language badge + copy) + syntax-highlighted <pre>. */
function BlockCode({ lang, children }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const preRef = useRef(null);

  const handleCopy = async () => {
    const text = preRef.current?.innerText ?? '';
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      /* secure-context API rejected */
    }
    if (!ok) {
      // Fallback for non-secure contexts (e.g. http://<ip>:port where
      // navigator.clipboard is unavailable).
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        /* ignore */
      }
    }
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-300">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-100 px-3 py-1 dark:border-zinc-300 dark:bg-zinc-200">
        <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{lang || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 focus:outline-none dark:text-zinc-400 dark:hover:text-zinc-200"
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
            return (
              <BlockCodeContext.Provider value={true}>
                <BlockCode lang={lang}>{props.children}</BlockCode>
              </BlockCodeContext.Provider>
            );
          },
          // Block code (inside <pre>) renders clean without the inline chip;
          // inline code gets a subtle zinc chip. The context (set by <pre>) is
          // authoritative — className language detection fails for plain blocks.
          code: (props) => {
            const inBlock = useContext(BlockCodeContext);
            const rest = stripNode(props);
            if (inBlock) {
              return (
                <code
                  {...rest}
                  className="block bg-transparent p-0 font-mono text-[12.5px] text-zinc-800 dark:text-zinc-300"
                />
              );
            }
            return (
              <code
                {...rest}
                className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[12px] text-zinc-700"
              />
            );
          },
          p: (props) => <p {...stripNode(props)} className="my-1.5 last:mb-0" />,
          a: (props) => (
            <a {...stripNode(props)} className="text-zinc-900 underline underline-offset-2" target="_blank" rel="noreferrer" />
          ),
          ul: (props) => <ul {...stripNode(props)} className="my-1.5 list-disc space-y-1 pl-5" />,
          ol: (props) => <ol {...stripNode(props)} className="my-1.5 list-decimal space-y-1 pl-5" />,
          li: (props) => <li {...stripNode(props)} className="leading-relaxed" />,
          h1: (props) => <h1 {...stripNode(props)} className="my-2 text-base font-semibold text-zinc-900" />,
          h2: (props) => <h2 {...stripNode(props)} className="my-2 text-[15px] font-semibold text-zinc-900" />,
          h3: (props) => <h3 {...stripNode(props)} className="my-2 text-sm font-semibold text-zinc-900" />,
          h4: (props) => <h4 {...stripNode(props)} className="my-2 text-sm font-semibold text-zinc-900" />,
          h5: (props) => <h5 {...stripNode(props)} className="my-2 text-sm font-semibold text-zinc-900" />,
          h6: (props) => <h6 {...stripNode(props)} className="my-2 text-sm font-semibold text-zinc-900" />,
          blockquote: (props) => (
            <blockquote {...stripNode(props)} className="my-2 border-l-2 border-zinc-300 pl-3 text-zinc-500" />
          ),
          hr: () => <hr className="my-3 border-zinc-200" />,
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table {...stripNode(props)} className="w-full border-collapse text-[13px]" />
            </div>
          ),
          th: (props) => (
            <th {...stripNode(props)} className="border border-zinc-200 bg-zinc-50 px-2 py-1 text-left font-semibold text-zinc-700" />
          ),
          td: (props) => (
            <td {...stripNode(props)} className="border border-zinc-200 px-2 py-1 text-zinc-700" />
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
