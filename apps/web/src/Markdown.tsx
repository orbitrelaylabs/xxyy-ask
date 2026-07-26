import type { ReactNode } from 'react';

interface MarkdownProps {
  text: string;
}

export function Markdown({ text }: MarkdownProps): ReactNode {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  let paragraphLines: string[] = [];
  let listItems: string[] = [];
  let listType: 'ol' | 'ul' | undefined;
  let codeLines: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }
    const key = `p-${blocks.length}`;
    blocks.push(<p key={key}>{renderInlineMarkdown(paragraphLines.join(' '), key)}</p>);
    paragraphLines = [];
  };

  const flushList = (): void => {
    if (listItems.length === 0 || listType === undefined) {
      return;
    }
    const key = `${listType}-${blocks.length}`;
    const children = listItems.map((item, index) => (
      <li key={`${key}-${index}`}>{renderInlineMarkdown(item, `${key}-${index}`)}</li>
    ));
    blocks.push(listType === 'ol' ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
    listItems = [];
    listType = undefined;
  };

  const flushCodeBlock = (): void => {
    const key = `code-${blocks.length}`;
    blocks.push(
      <pre key={key}>
        <code>{codeLines.join('\n')}</code>
      </pre>,
    );
    codeLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
        continue;
      }
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeLines = [];
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/u.exec(trimmed);
    if (headingMatch !== null) {
      flushParagraph();
      flushList();
      const key = `h-${blocks.length}`;
      blocks.push(<h3 key={key}>{renderInlineMarkdown(headingMatch[2] ?? '', key)}</h3>);
      continue;
    }

    const unorderedMatch = /^[-*]\s+(.+)$/u.exec(trimmed);
    const orderedMatch = /^\d+[.)]\s+(.+)$/u.exec(trimmed);
    if (unorderedMatch !== null || orderedMatch !== null) {
      flushParagraph();
      const nextListType = unorderedMatch !== null ? 'ul' : 'ol';
      if (listType !== undefined && listType !== nextListType) {
        flushList();
      }
      listType = nextListType;
      listItems.push(unorderedMatch?.[1] ?? orderedMatch?.[1] ?? '');
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  if (inCodeBlock) {
    flushCodeBlock();
  }
  flushParagraph();
  flushList();

  return blocks.length === 0 ? text : blocks;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/gu;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    const key = `${keyPrefix}-inline-${index}`;
    if (match[2] !== undefined) {
      nodes.push(<strong key={key}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<code key={key}>{match[3]}</code>);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      nodes.push(
        <a href={match[5]} key={key} rel="noreferrer" target="_blank">
          {match[4]}
        </a>,
      );
    }

    index += 1;
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}
