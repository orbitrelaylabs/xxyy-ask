import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  createAgentStartMode,
  runAgentStart,
  shouldIngestFromStatsOutput,
} from './start-agent.mjs';

describe('createAgentStartMode', () => {
  it('uses service-only mode in production', () => {
    expect(createAgentStartMode([], { NODE_ENV: 'production' })).toBe('service');
  });

  it('uses local bootstrap mode outside production', () => {
    expect(createAgentStartMode([], {})).toBe('local');
  });

  it('allows explicit mode overrides', () => {
    expect(createAgentStartMode(['--service'], {})).toBe('service');
    expect(createAgentStartMode(['--local'], { NODE_ENV: 'production' })).toBe('local');
    expect(createAgentStartMode([], { XXYY_START_MODE: 'service' })).toBe('service');
  });
});

describe('shouldIngestFromStatsOutput', () => {
  it('requests ingestion when stats fail or the knowledge base is empty', () => {
    expect(shouldIngestFromStatsOutput({ exitCode: 1, stdout: '' })).toBe(true);
    expect(
      shouldIngestFromStatsOutput({ exitCode: 0, stdout: 'Knowledge stats:\nChunks: 0\n' }),
    ).toBe(true);
  });

  it('skips ingestion when stats show existing chunks', () => {
    expect(
      shouldIngestFromStatsOutput({ exitCode: 0, stdout: 'Knowledge stats:\nChunks: 42\n' }),
    ).toBe(false);
  });
});

describe('runAgentStart', () => {
  it('starts API and Web without refreshing knowledge by default', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service'],
      env: {},
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual(['build Web', 'start API and Web']);
  });

  it('checks incremental updates before serving when sync is requested', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service', '--sync'],
      env: {},
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'knowledge stats',
      'refresh X updates',
      'sync X knowledge',
      'build Web',
      'start API and Web',
    ]);
  });

  it('bootstraps local postgres and ingests an empty knowledge base before sync serving', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--local', '--sync'],
      env: {
        POSTGRES_DB: 'xxyy_ask',
        POSTGRES_PASSWORD: 'secret',
        POSTGRES_USER: 'xxyy',
      },
      hasFile: (file) => file.endsWith('docker-compose.yml'),
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 0\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'start local postgres',
      'knowledge stats',
      'ingest knowledge',
      'refresh X updates',
      'sync X knowledge',
      'build Web',
      'start API and Web',
    ]);
  });

  it('skips docker and knowledge refresh by default when using an external database', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--local'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      hasFile: () => true,
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual(['build Web', 'start API and Web']);
  });

  it('ingests a missing production knowledge base before incremental sync', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service', '--sync'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: command.label === 'knowledge stats' ? 1 : 0,
          stdout: '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'knowledge stats',
      'ingest knowledge',
      'refresh X updates',
      'sync X knowledge',
      'build Web',
      'start API and Web',
    ]);
  });

  it('does not start the service when incremental sync fails', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service', '--sync'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: command.label === 'sync X knowledge' ? 1 : 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['knowledge stats', 'refresh X updates', 'sync X knowledge']);
  });

  it('starts the service with existing knowledge when X refresh is temporarily unavailable', async () => {
    const commands = [];
    const logs = [];
    const exitCode = await runAgentStart({
      args: ['--service', '--sync'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      log(message) {
        logs.push(message);
      },
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: command.label === 'refresh X updates' ? 1 : 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'knowledge stats',
      'refresh X updates',
      'build Web',
      'start API and Web',
    ]);
    expect(logs.join('\n')).toContain(
      'Warning: refresh X updates failed; starting with existing knowledge.',
    );
  });

  it('runs full source refresh and ingestion before serving when full sync is requested', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service', '--full-sync'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      log: () => {},
      runCommand(command) {
        commands.push({ args: command.args, label: command.label });
        return Promise.resolve({ exitCode: 0, stdout: '' });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      { args: ['docs:sync'], label: 'refresh official docs' },
      { args: ['docs:enrich:media'], label: 'enrich documentation media' },
      { args: ['docs:audit'], label: 'audit documentation coverage' },
      { args: ['x:scrape', '--', '--full'], label: 'refresh X updates' },
      { args: ['rag:ingest'], label: 'ingest knowledge' },
      { args: ['--filter', '@xxyy/web', 'build'], label: 'build Web' },
      { args: ['--filter', '@xxyy/api', 'start'], label: 'start API and Web' },
    ]);
  });

  it('runs only ingestion before serving when ingestion is requested', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service', '--ingest'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({ exitCode: 0, stdout: '' });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual(['ingest knowledge', 'build Web', 'start API and Web']);
  });

  it('does not start the API when the Web build fails', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service'],
      env: {},
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: command.label === 'build Web' ? 1 : 0,
          stdout: '',
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['build Web']);
  });
});

describe('root package scripts', () => {
  it('exposes dev entrypoints without legacy start aliases', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

    expect(packageJson.scripts['app:dev']).toBe('node scripts/start-agent.mjs');
    expect(packageJson.scripts['app:up']).toBe('docker compose up --detach --build');
    expect(packageJson.scripts['app:stop']).toBe(
      'docker compose stop api telegram telegram-curation-worker',
    );
    expect(packageJson.scripts['app:status']).toBe('docker compose ps');
    expect(packageJson.scripts['app:restart']).toBe(
      'docker compose restart api telegram telegram-curation-worker',
    );
    expect(packageJson.scripts['app:logs']).toBe(
      'docker compose logs --follow --tail=200 api telegram telegram-curation-worker',
    );
    expect(packageJson.scripts['app:down']).toBe('docker compose down');
    expect(packageJson.scripts['api:dev']).toBe('pnpm --filter @xxyy/api start');
    expect(packageJson.scripts['web:dev']).toBe('pnpm --filter @xxyy/web dev');
    expect(packageJson.scripts['telegram:dev']).toBe('pnpm --filter @xxyy/telegram-bot start');
    expect(packageJson.scripts['telegram:curation:worker']).toBe(
      'pnpm --filter @xxyy/telegram-bot curation-worker',
    );
    expect(packageJson.scripts['onchain:query:production']).toBeUndefined();
    expect(packageJson.scripts['xxyy:diagnose']).toBe(
      'node skills/xxyy-transaction-diagnosis/scripts/diagnose.mjs',
    );
    expect(packageJson.scripts['xxyy:skill:build']).toContain(
      'packages/xxyy-transaction-diagnosis-runtime/src/cli.ts',
    );
    expect(packageJson.scripts['onchain:inspect']).toBe(
      'node skills/onchain-transaction-inspector/scripts/inspect.mjs',
    );
    expect(packageJson.scripts.start).toBeUndefined();
    expect(packageJson.scripts.dev).toBeUndefined();
    expect(packageJson.scripts.sync).toBeUndefined();
    expect(packageJson.scripts['start:service']).toBeUndefined();
    expect(packageJson.scripts['telegram:start']).toBeUndefined();
  });
});
