/**
 * Canonical foreign-memory visibility predicate. Keep this text byte-identical to
 * mc-store's FOREIGN_VISIBLE_SQL so render, delta, search, and revocation use one rule.
 */
export declare const FOREIGN_VISIBLE_SQL = "status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > :now_ms) AND shareable = 1 AND scope IN ('project','ecosystem','universe') AND category IN (SELECT value FROM json_each(:share_categories)) AND project_path IN (SELECT project_path FROM mc_workspace_members WHERE workspace_id = :workspace_id) AND project_path <> :reader_project";
//# sourceMappingURL=visibility.d.ts.map