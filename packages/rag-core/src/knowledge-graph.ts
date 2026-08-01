import { createHash } from 'node:crypto';

import type { SourceType } from '@xxyy/shared';

import { aliasesForCanonicalName, matchKnowledgeAliases } from './knowledge-aliases.js';
import type { PgClientLike } from './pgvector-store.js';

export type KnowledgeGraphEntityType = 'chain' | 'feature' | 'launchpad' | 'plan' | 'product';
export type KnowledgeGraphRelationStatus = 'approved' | 'rejected';

export interface ExtractedKnowledgeRelation {
  confidence: number;
  evidence: string;
  object: { canonicalName: string; type: KnowledgeGraphEntityType };
  predicate: 'does_not_support_chain' | 'supports_chain' | 'supported_launchpad_on_chain';
  subject: { canonicalName: string; type: KnowledgeGraphEntityType };
}

export interface KnowledgeGraphEntity {
  aliases: string[];
  canonicalName: string;
  id: string;
  type: KnowledgeGraphEntityType;
}

export interface KnowledgeGraphRelation extends ExtractedKnowledgeRelation {
  id: string;
  sourceChunkId: string;
  sourceDocumentId: string;
  sourceType: SourceType;
  sourceUrl?: string;
  status: KnowledgeGraphRelationStatus;
  updatedAt: string;
}

export interface KnowledgeGraphConflict {
  negativeRelationIds: string[];
  object: KnowledgeGraphEntity;
  positiveRelationIds: string[];
  subject: KnowledgeGraphEntity;
}

export interface PgKnowledgeGraphStore {
  listEntities(input?: {
    limit?: number;
    query?: string;
    type?: KnowledgeGraphEntityType;
  }): Promise<KnowledgeGraphEntity[]>;
  listRelations(input?: {
    limit?: number;
    status?: KnowledgeGraphRelationStatus;
  }): Promise<KnowledgeGraphRelation[]>;
  listConflicts(input?: { limit?: number }): Promise<KnowledgeGraphConflict[]>;
  setRelationStatus(input: {
    id: string;
    status: KnowledgeGraphRelationStatus;
  }): Promise<KnowledgeGraphRelation>;
}

const CHAIN_NAMES = new Set([
  'Solana',
  'BSC',
  'Ethereum',
  'Base',
  'Robinhood Chain',
  'Stable Chain',
]);
const LAUNCHPAD_NAMES = new Set([
  'Pump',
  'LetsBonk',
  'Raydium Launchlab',
  'Four.meme',
  'Klik',
  'Noxa',
  'Virtuals',
  'Bankr',
  'Varo',
]);

export function extractKnowledgeGraphRelations(input: {
  text: string;
  title?: string;
}): ExtractedKnowledgeRelation[] {
  const evidenceText = `${input.title ?? ''}\n${input.text}`.normalize('NFKC');
  const aliases = matchKnowledgeAliases(evidenceText);
  const chains = aliases.filter((match) => CHAIN_NAMES.has(match.canonical));
  const launchpads = aliases.filter((match) => LAUNCHPAD_NAMES.has(match.canonical));
  const relations: ExtractedKnowledgeRelation[] = [];
  const title = input.title ?? '';

  if (/当前支持的公链|整体产品目前支持哪些链/u.test(evidenceText)) {
    for (const chain of chains) {
      relations.push(
        relation('XXYY', 'product', 'supports_chain', chain.canonical, 'chain', evidenceText),
      );
    }
  }

  for (const feature of aliases.filter(
    (match) => match.type === 'feature' && match.canonical !== '发射平台',
  )) {
    const titleMatchesFeature = normalizeComparable(title).includes(
      normalizeComparable(feature.canonical),
    );
    const supportSegments = evidenceText
      .split(/[。！？!?\n]+/u)
      .map((segment) => segment.trim())
      .filter((segment) => /支持|覆盖/iu.test(segment))
      .filter(
        (segment) =>
          titleMatchesFeature || new RegExp(escapeRegExp(feature.matchedAlias), 'iu').test(segment),
      );
    for (const segment of supportSegments) {
      for (const chain of matchKnowledgeAliases(segment).filter((match) =>
        CHAIN_NAMES.has(match.canonical),
      )) {
        const predicate = /不支持|未支持|尚未支持/u.test(segment)
          ? 'does_not_support_chain'
          : 'supports_chain';
        relations.push(
          relation(feature.canonical, 'feature', predicate, chain.canonical, 'chain', segment),
        );
      }
    }
  }

  if (
    /发射平台|发射台|launchpad/iu.test(title) ||
    /按链(?:整理|筛选).{0,40}发射/iu.test(evidenceText)
  ) {
    for (const launchpad of launchpads) {
      const chain = nearestPrecedingChain(evidenceText, launchpad.matchedAlias, chains);
      if (chain !== undefined) {
        relations.push(
          relation(
            launchpad.canonical,
            'launchpad',
            'supported_launchpad_on_chain',
            chain.canonical,
            'chain',
            evidenceText,
          ),
        );
      }
    }
  }

  return deduplicateRelations(relations);
}

export async function migrateKnowledgeGraph(client: PgClientLike): Promise<void> {
  await client.query(`
    create table if not exists knowledge_graph_entities (
      id text primary key,
      canonical_name text not null,
      entity_type text not null check (entity_type in ('chain', 'feature', 'launchpad', 'plan', 'product')),
      aliases text[] not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (canonical_name, entity_type)
    )
  `);
  await client.query(`
    create table if not exists knowledge_graph_relations (
      id text primary key,
      subject_entity_id text not null references knowledge_graph_entities(id),
      predicate text not null check (predicate in ('supports_chain', 'does_not_support_chain', 'supported_launchpad_on_chain')),
      object_entity_id text not null references knowledge_graph_entities(id),
      source_document_id text not null,
      source_chunk_id text not null,
      source_type text not null check (source_type in ('admin_verified', 'official_docs', 'x_updates')),
      source_url text,
      evidence text not null,
      confidence double precision not null check (confidence >= 0 and confidence <= 1),
      status text not null default 'approved' check (status in ('approved', 'rejected')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(
    'create index if not exists knowledge_graph_entities_aliases_idx on knowledge_graph_entities using gin (aliases)',
  );
  await client.query(
    `alter table knowledge_graph_relations drop constraint if exists knowledge_graph_relations_predicate_check`,
  );
  await client.query(
    `alter table knowledge_graph_relations add constraint knowledge_graph_relations_predicate_check
     check (predicate in ('supports_chain', 'does_not_support_chain', 'supported_launchpad_on_chain'))`,
  );
  await client.query(
    'create index if not exists knowledge_graph_relations_source_chunk_idx on knowledge_graph_relations (source_chunk_id)',
  );
  await client.query(
    'create index if not exists knowledge_graph_relations_status_idx on knowledge_graph_relations (status, predicate)',
  );
}

export async function replaceChunkKnowledgeGraph(input: {
  client: PgClientLike;
  chunk: {
    documentId: string;
    id: string;
    metadata: {
      sourceType: SourceType;
      sourceUrl?: string;
      status?: 'current' | 'deprecated' | 'historical';
      title: string;
    };
    text: string;
  };
}): Promise<void> {
  const effectiveStatus =
    input.chunk.metadata.status ??
    (input.chunk.metadata.sourceType === 'x_updates' ? 'historical' : 'current');
  if (effectiveStatus !== 'current') {
    await input.client.query(`delete from knowledge_graph_relations where source_chunk_id=$1`, [
      input.chunk.id,
    ]);
    return;
  }
  const relations = extractKnowledgeGraphRelations({
    text: input.chunk.text,
    title: input.chunk.metadata.title,
  });
  const graphEligible =
    relations.length > 0 ||
    /当前支持的公链|发射平台|发射台|支持.{0,80}(?:公)?链/u.test(
      `${input.chunk.metadata.title}\n${input.chunk.text}`,
    );
  if (!graphEligible) {
    return;
  }
  const relationIds: string[] = [];
  for (const item of relations) {
    const subjectId = await upsertEntity(
      input.client,
      item.subject.canonicalName,
      item.subject.type,
    );
    const objectId = await upsertEntity(input.client, item.object.canonicalName, item.object.type);
    const id = graphRelationId(subjectId, item.predicate, objectId, input.chunk.id);
    relationIds.push(id);
    await input.client.query(
      `insert into knowledge_graph_relations (
        id, subject_entity_id, predicate, object_entity_id, source_document_id, source_chunk_id,
        source_type, source_url, evidence, confidence, status, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',now())
      on conflict (id) do update set
        source_document_id=excluded.source_document_id,
        source_type=excluded.source_type,
        source_url=excluded.source_url,
        evidence=excluded.evidence,
        confidence=excluded.confidence,
        status=case when knowledge_graph_relations.status='rejected' then 'rejected' else 'approved' end,
        updated_at=now()`,
      [
        id,
        subjectId,
        item.predicate,
        objectId,
        input.chunk.documentId,
        input.chunk.id,
        input.chunk.metadata.sourceType,
        input.chunk.metadata.sourceUrl ?? null,
        item.evidence.slice(0, 4_000),
        item.confidence,
      ],
    );
  }
  await input.client.query(
    `delete from knowledge_graph_relations where source_chunk_id=$1 and not (id = any($2::text[]))`,
    [input.chunk.id, relationIds],
  );
}

export function createPgKnowledgeGraphStore(options: {
  client: PgClientLike;
}): PgKnowledgeGraphStore {
  return {
    async listEntities(input = {}) {
      const response = await options.client.query<{
        aliases: string[];
        canonical_name: string;
        entity_type: KnowledgeGraphEntityType;
        id: string;
      }>(
        `select id, canonical_name, entity_type, aliases from knowledge_graph_entities
         where ($1::text is null or entity_type=$1)
           and ($2::text is null or lower(canonical_name) like '%'||lower($2)||'%' or aliases && array[lower($2)]::text[])
         order by entity_type, canonical_name limit $3`,
        [input.type ?? null, input.query?.trim() || null, normalizeLimit(input.limit)],
      );
      return response.rows.map((row) => ({
        aliases: row.aliases,
        canonicalName: row.canonical_name,
        id: row.id,
        type: row.entity_type,
      }));
    },
    async listRelations(input = {}) {
      return listRelations(options.client, input);
    },
    async listConflicts(input = {}) {
      const response = await options.client.query<{
        aliases: string[];
        negative_relation_ids: string[];
        object_id: string;
        object_name: string;
        object_type: KnowledgeGraphEntityType;
        positive_relation_ids: string[];
        subject_aliases: string[];
        subject_id: string;
        subject_name: string;
        subject_type: KnowledgeGraphEntityType;
      }>(
        `select s.id subject_id, s.canonical_name subject_name, s.entity_type subject_type,
           s.aliases subject_aliases, o.id object_id, o.canonical_name object_name,
           o.entity_type object_type, o.aliases,
           array_agg(distinct p.id) positive_relation_ids,
           array_agg(distinct n.id) negative_relation_ids
         from knowledge_graph_relations p
         join knowledge_graph_relations n
           on n.subject_entity_id=p.subject_entity_id
          and n.object_entity_id=p.object_entity_id
          and n.predicate='does_not_support_chain'
          and n.status='approved'
         join knowledge_graph_entities s on s.id=p.subject_entity_id
         join knowledge_graph_entities o on o.id=p.object_entity_id
         where p.predicate='supports_chain' and p.status='approved'
         group by s.id, s.canonical_name, s.entity_type, s.aliases,
           o.id, o.canonical_name, o.entity_type, o.aliases
         order by s.canonical_name, o.canonical_name limit $1`,
        [normalizeLimit(input.limit)],
      );
      return response.rows.map((row) => ({
        negativeRelationIds: row.negative_relation_ids,
        object: {
          aliases: row.aliases,
          canonicalName: row.object_name,
          id: row.object_id,
          type: row.object_type,
        },
        positiveRelationIds: row.positive_relation_ids,
        subject: {
          aliases: row.subject_aliases,
          canonicalName: row.subject_name,
          id: row.subject_id,
          type: row.subject_type,
        },
      }));
    },
    async setRelationStatus(input) {
      const response = await options.client.query<{ id: string }>(
        `update knowledge_graph_relations set status=$2, updated_at=now() where id=$1 returning id`,
        [input.id, input.status],
      );
      if (response.rows.length === 0) throw new Error('Knowledge graph relation not found.');
      const relations = await listRelations(options.client, { limit: 1, relationId: input.id });
      const relation = relations[0];
      if (relation === undefined) throw new Error('Knowledge graph relation not found.');
      return relation;
    },
  };
}

async function listRelations(
  client: PgClientLike,
  input: { limit?: number; relationId?: string; status?: KnowledgeGraphRelationStatus },
): Promise<KnowledgeGraphRelation[]> {
  const response = await client.query<{
    confidence: number;
    evidence: string;
    id: string;
    object_name: string;
    object_type: KnowledgeGraphEntityType;
    predicate: ExtractedKnowledgeRelation['predicate'];
    source_chunk_id: string;
    source_document_id: string;
    source_type: SourceType;
    source_url: string | null;
    status: KnowledgeGraphRelationStatus;
    subject_name: string;
    subject_type: KnowledgeGraphEntityType;
    updated_at: string;
  }>(
    `select r.id, s.canonical_name subject_name, s.entity_type subject_type, r.predicate,
       o.canonical_name object_name, o.entity_type object_type, r.source_document_id,
       r.source_chunk_id, r.source_type, r.source_url, r.evidence, r.confidence, r.status,
       r.updated_at::text updated_at
     from knowledge_graph_relations r
     join knowledge_graph_entities s on s.id=r.subject_entity_id
     join knowledge_graph_entities o on o.id=r.object_entity_id
     where ($1::text is null or r.status=$1) and ($2::text is null or r.id=$2)
     order by r.updated_at desc, r.id limit $3`,
    [input.status ?? null, input.relationId ?? null, normalizeLimit(input.limit)],
  );
  return response.rows.map((row) => ({
    confidence: row.confidence,
    evidence: row.evidence,
    id: row.id,
    object: { canonicalName: row.object_name, type: row.object_type },
    predicate: row.predicate,
    sourceChunkId: row.source_chunk_id,
    sourceDocumentId: row.source_document_id,
    sourceType: row.source_type,
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    status: row.status,
    subject: { canonicalName: row.subject_name, type: row.subject_type },
    updatedAt: row.updated_at,
  }));
}

async function upsertEntity(
  client: PgClientLike,
  canonicalName: string,
  type: KnowledgeGraphEntityType,
): Promise<string> {
  const id = `kg_entity_${createHash('sha256').update(`${type}:${canonicalName}`).digest('hex').slice(0, 24)}`;
  await client.query(
    `insert into knowledge_graph_entities (id, canonical_name, entity_type, aliases, updated_at)
     values ($1,$2,$3,$4,now()) on conflict (id) do update set aliases=excluded.aliases, updated_at=now()`,
    [
      id,
      canonicalName,
      type,
      aliasesForCanonicalName(canonicalName).map((alias) => alias.toLowerCase()),
    ],
  );
  return id;
}

function relation(
  subjectName: string,
  subjectType: KnowledgeGraphEntityType,
  predicate: ExtractedKnowledgeRelation['predicate'],
  objectName: string,
  objectType: KnowledgeGraphEntityType,
  evidence: string,
): ExtractedKnowledgeRelation {
  return {
    confidence: 0.95,
    evidence: compactEvidence(evidence),
    object: { canonicalName: objectName, type: objectType },
    predicate,
    subject: { canonicalName: subjectName, type: subjectType },
  };
}

function nearestPrecedingChain(
  text: string,
  launchpadAlias: string,
  chains: ReturnType<typeof matchKnowledgeAliases>,
) {
  const launchpadIndex = text.toLowerCase().indexOf(launchpadAlias.toLowerCase());
  return chains
    .map((chain) => ({
      chain,
      index: text.toLowerCase().lastIndexOf(chain.matchedAlias.toLowerCase(), launchpadIndex),
    }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => right.index - left.index)[0]?.chain;
}

function compactEvidence(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 1_000);
}

function deduplicateRelations(
  relations: ExtractedKnowledgeRelation[],
): ExtractedKnowledgeRelation[] {
  return [
    ...new Map(
      relations.map((item) => [
        `${item.subject.canonicalName}:${item.predicate}:${item.object.canonicalName}`,
        item,
      ]),
    ).values(),
  ];
}

function graphRelationId(
  subjectId: string,
  predicate: string,
  objectId: string,
  sourceChunkId: string,
): string {
  return `kg_relation_${createHash('sha256').update(`${subjectId}:${predicate}:${objectId}:${sourceChunkId}`).digest('hex').slice(0, 24)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeComparable(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

function normalizeLimit(value: number | undefined): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? Math.min(value ?? 100, 500) : 100;
}
