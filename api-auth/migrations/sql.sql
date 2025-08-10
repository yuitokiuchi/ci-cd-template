-- users テーブル（public スキーマ相当）
CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- refresh_tokens テーブル
CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti VARCHAR(255) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    expires_at DATETIME NOT NULL,
    UNIQUE (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- chat スキーマ相当（MariaDB では DATABASE かプレフィックスとして扱うか）
-- テーブル名にプレフィックスを使うことで chat スキーマの代用にします

-- chat_server_visibility ENUM 型の代用
-- MariaDB では ENUM 型を直接使えます
-- chat_servers
CREATE TABLE IF NOT EXISTS chat_servers (
    id CHAR(36) PRIMARY KEY,
    name TEXT NOT NULL,
    created_by BIGINT,
    visibility ENUM('public', 'private') NOT NULL DEFAULT 'private',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- chat_server_members
CREATE TABLE IF NOT EXISTS chat_server_members (
    server_id CHAR(36) NOT NULL,
    user_id BIGINT NOT NULL,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES chat_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- chat_channels
CREATE TABLE IF NOT EXISTS chat_channels (
    id CHAR(36) PRIMARY KEY,
    server_id CHAR(36) NOT NULL,
    name TEXT NOT NULL,
    topic TEXT,
    position INT DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (server_id, name),
    FOREIGN KEY (server_id) REFERENCES chat_servers(id) ON DELETE CASCADE
);

-- chat_messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    channel_id CHAR(36) NOT NULL,
    sender_id BIGINT,
    content TEXT NOT NULL,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at DATETIME,
    FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL,
    CHECK (CHAR_LENGTH(content) > 0)
);

-- インデックス
CREATE INDEX idx_server_members_user_id ON chat_server_members(user_id);
CREATE INDEX idx_servers_visibility ON chat_servers(visibility);
CREATE INDEX idx_messages_channel_id_sent_at ON chat_messages(channel_id, sent_at DESC);

