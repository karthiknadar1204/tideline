import Markdown from "react-markdown";
import type { Components } from "react-markdown";

const reportComponents: Components = {
  a: ({ href, children }) => href ? <a href={href} rel="noopener noreferrer" target="_blank">{children}</a> : <span>{children}</span>,
  h1: "h2",
  h2: "h3",
  h3: "h4",
  h4: "h5",
  h5: "h6",
};

export function ReportMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="space-y-4 leading-relaxed [overflow-wrap:anywhere]
      [&_a]:text-[var(--workspace-accent)] [&_a]:underline [&_a]:underline-offset-4
      [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--workspace-border)] [&_blockquote]:pl-4
      [&_code]:rounded [&_code]:bg-[var(--workspace-subtle)] [&_code]:px-1 [&_code]:text-sm
      [&_h2]:text-xl [&_h3]:text-lg [&_h4]:text-base [&_:is(h2,h3,h4,h5,h6)]:font-semibold
      [&_hr]:border-[var(--workspace-border)] [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6
      [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--workspace-subtle)] [&_pre]:p-3 [&_pre_code]:px-0
      [&_ul]:list-disc [&_ul]:pl-6">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        components={reportComponents}
        urlTransform={(url) => /^https?:\/\//i.test(url) ? url : undefined}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
