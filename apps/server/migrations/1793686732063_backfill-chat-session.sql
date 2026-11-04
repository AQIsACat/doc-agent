-- Up Migration

INSERT INTO chat_session
  (user_id, session_id, title, last_message, message_count, created_at, updated_at)
SELECT
  g.user_id,
  g.session_id,
  COALESCE(
    NULLIF(left(regexp_replace(first_user.content, '[[:space:]]+', ' ', 'g'), 50), ''),
    '新会话'
  ),
  COALESCE(left(regexp_replace(last_msg.content, '[[:space:]]+', ' ', 'g'), 200), ''),
  g.message_count,
  g.created_at,
  g.updated_at
FROM (
  SELECT user_id,
         session_id,
         COUNT(*)::int AS message_count,
         MIN(created_at) AS created_at,
         MAX(created_at) AS updated_at
  FROM chat_message
  GROUP BY user_id, session_id
) g
LEFT JOIN LATERAL (
  SELECT content
  FROM chat_message
  WHERE user_id = g.user_id AND session_id = g.session_id AND role = 'user'
  ORDER BY created_at ASC, id ASC
  LIMIT 1
) first_user ON true
LEFT JOIN LATERAL (
  SELECT content
  FROM chat_message
  WHERE user_id = g.user_id AND session_id = g.session_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1
) last_msg ON true
WHERE NOT EXISTS (
  SELECT 1 FROM chat_session s
  WHERE s.user_id = g.user_id AND s.session_id = g.session_id
);

-- Down Migration
-- 数据回填没有安全的自动回滚方式；生产回滚请使用备份/快照。
DO $$ BEGIN RAISE NOTICE 'backfill-chat-session is not reversible'; END $$;