import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const commitTypes = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const headerPattern = new RegExp(
  `^(${commitTypes.join('|')})(?:\\(([a-z0-9][a-z0-9-]*)\\))?(!)?: (.+)$`,
  'u',
);
const generatedMessagePatterns = [/^Merge /u, /^Revert "/u, /^(?:fixup|squash)! /u];
const vagueSubjects = new Set([
  'bug fix',
  'change',
  'changes',
  'fix',
  'misc',
  'update',
  'update files',
  'updates',
  'wip',
]);

function normalizedLines(message) {
  const lines = message
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter((line) => !line.startsWith('#'));

  while (lines[0]?.trim() === '') {
    lines.shift();
  }
  while (lines.at(-1)?.trim() === '') {
    lines.pop();
  }

  return lines;
}

export function validateCommitMessage(message) {
  const lines = normalizedLines(message);
  const header = lines[0] ?? '';
  const errors = [];

  if (header === '') {
    return ['提交消息不能为空'];
  }

  if (generatedMessagePatterns.some((pattern) => pattern.test(header))) {
    return [];
  }

  if (header.length > 100) {
    errors.push(`标题长度为 ${header.length}，不能超过 100 个字符`);
  }

  const match = header.match(headerPattern);
  if (!match) {
    errors.push(`标题必须符合 <type>(<scope>): <subject>，type 只能是 ${commitTypes.join(', ')}`);
    return errors;
  }

  const subject = match[4];
  const hasBreakingMarker = match[3] === '!';
  const breakingFooter = lines.find((line) => line.startsWith('BREAKING CHANGE:'));

  if (subject !== subject.trim()) {
    errors.push('subject 前后不能包含多余空格');
  }
  if (/^[A-Z]/u.test(subject)) {
    errors.push('subject 的普通英文单词应小写开头');
  }
  if (/[.!?。！？]$/u.test(subject)) {
    errors.push('subject 末尾不能使用句号、问号或感叹号');
  }
  if (vagueSubjects.has(subject.trim().toLowerCase())) {
    errors.push('subject 不能使用 update、changes、misc、WIP 等模糊描述');
  }
  if (lines.length > 1 && lines[1].trim() !== '') {
    errors.push('标题与正文之间必须保留一个空行');
  }
  if (hasBreakingMarker && breakingFooter === undefined) {
    errors.push('破坏性变更标题包含 ! 时，必须添加 BREAKING CHANGE: footer');
  }
  if (!hasBreakingMarker && breakingFooter !== undefined) {
    errors.push('包含 BREAKING CHANGE: footer 时，标题必须使用 ! 标记破坏性变更');
  }
  if (
    breakingFooter !== undefined &&
    breakingFooter.slice('BREAKING CHANGE:'.length).trim() === ''
  ) {
    errors.push('BREAKING CHANGE: footer 必须说明具体影响');
  }

  return errors;
}

async function main(args) {
  const [mode, ...rawValues] = args;
  if (rawValues[0] === '--') {
    rawValues.shift();
  }
  const value = rawValues.join(' ');
  let message;

  if (mode === '--file' && value) {
    message = await readFile(value, 'utf8');
  } else if (mode === '--message' && value) {
    message = value;
  } else {
    console.error(
      '用法: node scripts/validate-commit-message.mjs --file <path> | --message "<message>"',
    );
    return 2;
  }

  const errors = validateCommitMessage(message);
  if (errors.length === 0) {
    if (mode === '--message') {
      console.log('Commit message is valid.');
    }
    return 0;
  }

  console.error('提交消息不符合 AGENTS.md 中的 Commit message 规范：');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  console.error('示例: feat(knowledge): improve markdown chunk boundaries');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
