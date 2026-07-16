import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  img: ({ alt }) => <span className="markdown-image">[image: {alt || "attachment"}]</span>,
};

/** 渲染已保存的 Agent Markdown，但不执行原始 HTML，也不加载远程图片。 */
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  if (!children.trim()) return null;
  return <div className={`markdown ${className}`.trim()}><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown></div>;
}
