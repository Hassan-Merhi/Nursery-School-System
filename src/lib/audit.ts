import type { PoolClient } from "pg";

export type AuditEntry = {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
};

export async function writeAudit(client: PoolClient, entry: AuditEntry) {
  await client.query(
    `insert into audit_log
       (actor_user_id, action, entity_type, entity_id, before_data, after_data)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
