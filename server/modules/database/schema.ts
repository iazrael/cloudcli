const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
);
`;

export const SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    -- Composer preferences (model, effort, permission mode, attachments) as
    -- they were when the message was scheduled, so it runs the way the user
    -- set it up rather than however the session is configured hours later.
    options TEXT NOT NULL DEFAULT '{}',
    -- UTC. The client sends an absolute instant so the schedule does not move
    -- when the user changes time zone between scheduling and firing.
    scheduled_for DATETIME NOT NULL,
    -- pending | sent | failed | cancelled
    status TEXT NOT NULL DEFAULT 'pending',
    -- Why a failed one failed, shown next to it in the composer.
    failure_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

/**
 * Recurring scheduled jobs: a prompt that runs on a cron schedule, into a
 * bound session (`reuse`) or into a fresh session per occurrence (`new`).
 *
 * Unlike `scheduled_messages`, a job is not tied to an existing conversation:
 * it belongs to a workspace and a provider, survives the session it was
 * created from, and keeps firing until it is paused or deleted. `session_id`
 * deliberately carries no foreign key — deleting a conversation must not
 * silently delete the user's recurring task; the job records a failed run
 * instead and waits to be rebound or removed.
 *
 * A job with `run_at` set is a one-off: it fires once at that instant and the
 * claim disables it, so it reads as completed rather than as a yearly repeat.
 */
export const SCHEDULED_JOBS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    project_path TEXT NOT NULL,
    -- Bound session for 'reuse' jobs; NULL for 'new' jobs.
    session_id TEXT,
    -- reuse | new
    session_mode TEXT NOT NULL DEFAULT 'reuse',
    -- 'reuse' only: once the bound session is this many days old, the next run
    -- moves to a fresh session and archives the old one. NULL never rotates.
    rotate_after_days INTEGER,
    prompt TEXT NOT NULL,
    -- Composer preferences (model, effort, permission mode) as they were when
    -- the job was created, so each occurrence runs the way the user set it up.
    options TEXT NOT NULL DEFAULT '{}',
    -- Standard 5-field cron expression, evaluated in the job's timezone. For a
    -- one-off it is derived from run_at so the column stays a valid cron.
    cron_expression TEXT NOT NULL,
    -- IANA zone captured from the client that created the job, so "09:00"
    -- means 09:00 for the user rather than for the server's locale.
    timezone TEXT NOT NULL,
    -- UTC instant of a one-off task; NULL for a recurring job. Claiming a
    -- one-off disables it, so it can never fire a second time.
    run_at DATETIME,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    -- UTC instant of the next occurrence. Advanced inside the claim
    -- transaction, so a claimed job can never fire twice for one occurrence.
    next_run_at DATETIME NOT NULL,
    last_run_at DATETIME,
    -- Status of the last finished run: succeeded | failed | skipped | missed.
    last_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * One attempt of one scheduled job, kept so the UI can show what happened
 * while the user was away. `session_id` is the session the occurrence ran in:
 * the bound one for `reuse` jobs, a freshly created one for `new` jobs.
 */
export const SCHEDULED_JOB_RUNS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_job_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    session_id TEXT,
    -- schedule | manual
    trigger TEXT NOT NULL DEFAULT 'schedule',
    -- running | succeeded | failed | skipped | missed
    status TEXT NOT NULL,
    error TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id) ON DELETE CASCADE
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    custom_name TEXT,
    -- 1 when the user renamed the session in the app: engine-generated titles
    -- must never overwrite it. 0 (the default) means the name is app-derived
    -- or engine-synced, so synchronizers keep following the engine's title.
    name_locked INTEGER DEFAULT 0,
    project_path TEXT,
    jsonl_path TEXT,
    -- Model and reasoning effort this session runs with. Written when the user
    -- changes either selection and on every send, so reopening a session
    -- restores its exact runtime configuration instead of provider defaults.
    model TEXT,
    effort TEXT,
    -- Context window this session actually runs against, in tokens, as the
    -- provider engine itself reported it. NULL until an engine reports one,
    -- which is the only way to know a window the transcript never records
    -- (a Claude session on a 1M-context model writes the resolved model id,
    -- never the 1M variant tag). Readers fall back to CONTEXT_WINDOW and then
    -- to a per-provider default.
    context_window INTEGER,
    -- The app session this one was branched from, NULL for sessions created
    -- normally. Informational only: a fork is a fully independent provider
    -- session, and deleting the source does not affect it.
    forked_from_session_id TEXT,
    -- Git worktree the session actually runs in, when an engine rebound it
    -- out of the owning project's main checkout (OpenCode's worktree feature).
    -- The session stays keyed under the main project; these columns feed the
    -- workspace header's branch label. NULL for main-checkout sessions.
    worktree_path TEXT,
    worktree_branch TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Persistent custom-model library used by the Providers module.
 *
 * Only user-created models are stored here. Predefined models remain source-
 * controlled in each provider's `-models.provider.ts` adapter so they can be
 * updated without migrating application data. `model_id` is unique only within
 * a provider because different CLIs can accept the same identifier.
 *
 * `effort_values` (JSON array of level ids) and `effort_default` hold the
 * reasoning-effort levels the user declared for the model; both stay NULL when
 * none were declared. They sit after the timestamps so fresh installs match the
 * column order that `runMigrations` produces on upgraded databases.
 */
export const PROVIDER_MODELS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'cursor', 'codex', 'opencode', 'zcode', 'antigravity')),
    model_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    effort_values TEXT DEFAULT NULL,
    effort_default TEXT DEFAULT NULL,
    UNIQUE(provider, model_id)
);
`;

/**
 * Per-user application preferences that used to live in browser localStorage.
 *
 * One row per (user, key); `preference_value` is always a JSON document so a
 * key can hold a scalar (`"dark"`), a flag (`false`) or a whole settings blob
 * without the schema having to know which. Keeping them server-side is what
 * makes a preference follow the user from one device to another.
 */
export const USER_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER NOT NULL,
    preference_key TEXT NOT NULL,
    preference_value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, preference_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Unsent composer text and queued messages, per user and per chat scope.
 *
 * `draft_scope` is a session id, or `project:<projectId>` for a chat that has
 * not been sent yet and therefore has no session. Storing this server-side is
 * what lets a message typed on a laptop be finished on a phone.
 */
export const SESSION_DRAFTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_drafts (
    user_id INTEGER NOT NULL,
    draft_scope TEXT NOT NULL,
    draft_text TEXT NOT NULL DEFAULT '',
    queued_message TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, draft_scope),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Provider sessions an app session has moved off, and must never move back to.
 *
 * Editing a message on a provider that cannot resume a transcript partway
 * (Codex) is done by branching: the conversation is copied up to the edited
 * turn and the app session follows the copy. The original transcript is left
 * on disk untouched — nothing is deleted — but it is no longer the session's,
 * and the indexer would otherwise rediscover it on its next full scan and hand
 * the session back to the version the user edited away from.
 */
export const SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS superseded_provider_sessions (
    provider_session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    -- The transcript the session left behind. Recorded because the session row
    -- stops pointing at it, and "delete this conversation from disk" has to
    -- reach every file the conversation ever lived in.
    jsonl_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_session_id, provider)
);
`;

export const ASYNC_TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS async_tasks (
    task_id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT,
    provider_thread_id TEXT,
    session_project_path TEXT,
    working_directory TEXT,
    sandbox_policy_type TEXT,
    network_access BOOLEAN,
    approval_policy TEXT,
    title TEXT NOT NULL,
    command TEXT,
    registration_key TEXT,
    auto_notify BOOLEAN DEFAULT 0,
    notification_cancelled_at DATETIME,
    notification_cancelled_reason TEXT,
    status TEXT NOT NULL DEFAULT 'registered',
    exit_code INTEGER,
    result_digest TEXT,
    result_path TEXT,
    result_summary TEXT,
    result_json TEXT,
    last_error TEXT,
    token_hash TEXT NOT NULL,
    token_expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const TASK_CONTINUATION_EVENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_continuation_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at DATETIME,
    lease_expires_at_ms INTEGER,
    last_attempt_at DATETIME,
    engine_turn_id TEXT,
    host_run_id TEXT,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE
);
`;

export const TASK_CONTINUATION_MANUAL_ACTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_continuation_manual_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    previous_receipt_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES task_continuation_events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES async_tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${PROVIDER_MODELS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_provider_models_provider_order
ON provider_models(provider, sort_order, id);

${USER_PREFERENCES_TABLE_SCHEMA_SQL}

${SESSION_DRAFTS_TABLE_SCHEMA_SQL}

${SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL}

${ASYNC_TASKS_TABLE_SCHEMA_SQL}

${TASK_CONTINUATION_EVENTS_TABLE_SCHEMA_SQL}
${TASK_CONTINUATION_MANUAL_ACTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_continuation_events_status_lease ON task_continuation_events(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_continuation_events_session ON task_continuation_events(session_id);
`;
