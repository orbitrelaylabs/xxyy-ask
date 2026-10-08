import { VectorStoreUnavailableError, type PgClientLike } from './pgvector-store.js';
import { wikiSnapshotSchema, type WikiSnapshot } from './knowledge-wiki.js';

// Shared by the compiler and the online query. A corpus change (including a new
// source, scope edit, supersession or withdrawal) invalidates every old wiki.
// MD5 is only a database revision token, never a signature or trust decision.
export const WIKI_CORPUS_CTES = `
  wiki_corpus as (
    select k.* from knowledge_chunks k
    where k.source_type in ('official_docs', 'x_updates', 'admin_verified')
      and not exists (
        select 1 from knowledge_source_tombstones t where t.document_id=k.document_id
      )
  ),
  wiki_revision as (
    select md5(coalesce(jsonb_agg(jsonb_build_array(
      id, document_id, content_hash, title, module, source_type, source_url,
      file, heading_path, order_index, effective_at, status, supersedes, attachments
    ) order by id collate "C")::text, '[]')) as revision
    from wiki_corpus
  )`;

export async function readWikiSnapshot(client: PgClientLike): Promise<WikiSnapshot> {
  const result = await queryWiki<{ revision: string; chunks: unknown }>(
    client,
    `
    with ${WIKI_CORPUS_CTES}
    select revision, coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'documentId', document_id, 'text', content,
        'metadata', jsonb_strip_nulls(jsonb_build_object(
          'title', title, 'module', module, 'sourceType', source_type,
          'sourceUrl', source_url, 'file', file, 'headingPath', heading_path,
          'order', order_index, 'effectiveAt', effective_at::text,
          'status', status, 'supersedes', supersedes, 'attachments', attachments
        ))
      ) order by id collate "C") from wiki_corpus
    ), '[]'::jsonb) as chunks from wiki_revision
  `,
  );
  return wikiSnapshotSchema.parse(result.rows[0]);
}

export async function readWikiRevision(client: PgClientLike): Promise<string> {
  const result = await queryWiki<{ revision: string }>(
    client,
    `with ${WIKI_CORPUS_CTES} select revision from wiki_revision`,
  );
  const revision = result.rows[0]?.revision;
  if (revision === undefined || !/^[a-f0-9]{32}$/u.test(revision))
    throw new Error('wiki_invalid_revision');
  return revision;
}

async function queryWiki<T>(client: PgClientLike, sql: string): Promise<{ rows: T[] }> {
  try {
    return await client.query<T>(sql);
  } catch (error) {
    throw new VectorStoreUnavailableError(error);
  }
}
