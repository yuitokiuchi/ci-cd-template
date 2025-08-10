-- このファイルは、データベースとテーブルの構造を定義する「設計図」です。

-- ========= ユーザーテーブル (認証とチャットの両方で利用) =========
CREATE TABLE IF NOT EXISTS `users` (
    `id` BIGINT PRIMARY KEY,
    `username` VARCHAR(255) NOT NULL UNIQUE,
    `display_name` VARCHAR(255) NOT NULL,
    `avatar_url` TEXT,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ========= リフレッシュトークン (認証サービス専用) =========
CREATE TABLE IF NOT EXISTS `refresh_tokens` (
    `jti` VARCHAR(255) PRIMARY KEY,
    `user_id` BIGINT NOT NULL,
    `expires_at` DATETIME NOT NULL,
    UNIQUE KEY (`user_id`),
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_refresh_tokens_user_id` ON `refresh_tokens`(`user_id`);
CREATE INDEX `idx_refresh_tokens_expires_at` ON `refresh_tokens`(`expires_at`);

-- ========= サーバー (チャットサービス専用) =========
CREATE TABLE IF NOT EXISTS `chat_servers` (
    `id` CHAR(36) PRIMARY KEY, -- UUIDを文字列として格納
    `name` VARCHAR(255) NOT NULL,
    `created_by` BIGINT,
    `visibility` ENUM('public', 'private') NOT NULL DEFAULT 'private',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);

-- ========= サーバーメンバー (チャットサービス専用) =========
CREATE TABLE IF NOT EXISTS `chat_server_members` (
    `server_id` CHAR(36) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `joined_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`server_id`, `user_id`),
    FOREIGN KEY (`server_id`) REFERENCES `chat_servers`(`id`) ON DELETE CASCADE,
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);

-- ========= チャンネル (チャットサービス専用) =========
CREATE TABLE IF NOT EXISTS `chat_channels` (
    `id` CHAR(36) PRIMARY KEY,
    `server_id` CHAR(36) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `topic` TEXT,
    `position` INT DEFAULT 0,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (`server_id`, `name`),
    FOREIGN KEY (`server_id`) REFERENCES `chat_servers`(`id`) ON DELETE CASCADE
);

-- ========= メッセージ (チャットサービス専用) =========
CREATE TABLE IF NOT EXISTS `chat_messages` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `channel_id` CHAR(36) NOT NULL,
    `sender_id` BIGINT,
    `content` TEXT NOT NULL,
    `sent_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `edited_at` DATETIME,
    FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON DELETE CASCADE,
    FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);

-- ========= インデックス (パフォーマンス向上) =========
CREATE INDEX `idx_server_members_user_id` ON `chat_server_members`(`user_id`);
CREATE INDEX `idx_servers_visibility` ON `chat_servers`(`visibility`);
-- MariaDBでは、DESCを指定しない方が一般的なインデックスとして機能しやすい
CREATE INDEX `idx_messages_channel_id_sent_at` ON `chat_messages`(`channel_id`, `sent_at`);


DELIMITER $$

-- サーバーが作成された"後"に、自動で'#general'チャンネルを作成するトリガー
CREATE TRIGGER `after_server_insert_create_channel`
AFTER INSERT ON `chat_servers`
FOR EACH ROW
BEGIN
    -- MariaDB/MySQLではUUID()関数が直接使えます
    INSERT INTO `chat_channels` (`id`, `server_id`, `name`, `topic`)
    VALUES (UUID(), NEW.id, 'general', 'Welcome to the new server!');
END$$

-- 区切り文字を';'に戻します。
DELIMITER ;