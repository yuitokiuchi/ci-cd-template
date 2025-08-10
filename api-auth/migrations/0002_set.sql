-- Up Migration

CREATE SCHEMA IF NOT EXISTS chat;
CREATE TYPE chat.server_visibility AS ENUM ('public', 'private');

CREATE TABLE IF NOT EXISTS public.users (
    id BIGINT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat.servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    visibility chat.server_visibility NOT NULL DEFAULT 'private',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat.server_members (
    server_id UUID NOT NULL REFERENCES chat.servers(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat.channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES chat.servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    topic TEXT,
    position INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, name)
);

CREATE TABLE IF NOT EXISTS chat.messages (
    id BIGSERIAL PRIMARY KEY,
    channel_id UUID NOT NULL REFERENCES chat.channels(id) ON DELETE CASCADE,
    sender_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    content TEXT NOT NULL CHECK (length(content) > 0),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_server_members_user_id ON chat.server_members(user_id);
CREATE INDEX IF NOT EXISTS idx_servers_visibility ON chat.servers(visibility);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id_sent_at ON chat.messages(channel_id, sent_at DESC);

CREATE OR REPLACE FUNCTION chat.create_default_channel_for_new_server()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO chat.channels (server_id, name, topic)
  VALUES (NEW.id, 'general', 'Welcome to the server!');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DROP TRIGGER IF EXISTS trg_create_default_channel ON chat.servers; -- トリガーは初回のみ作成で十分なのでDROPは不要
CREATE TRIGGER trg_create_default_channel
AFTER INSERT ON chat.servers
FOR EACH ROW
EXECUTE FUNCTION chat.create_default_channel_for_new_server();

-- Down Migration
DROP TRIGGER IF EXISTS trg_create_default_channel ON chat.servers;
DROP FUNCTION IF EXISTS chat.create_default_channel_for_new_server();
DROP TABLE IF EXISTS chat.messages;
DROP TABLE IF EXISTS chat.channels;
DROP TABLE IF EXISTS chat.server_members;
DROP TABLE IF EXISTS chat.servers;
DROP TYPE IF EXISTS chat.server_visibility;
DROP SCHEMA IF EXISTS chat;