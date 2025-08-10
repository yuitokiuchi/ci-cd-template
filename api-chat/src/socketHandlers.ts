// socketHandlers.ts (完成版)
import { Server, Socket } from 'socket.io';
import mariadb from 'mariadb';

// 型定義はそのまま
interface AuthenticatedSocket extends Socket {
  data: {
    user: { sub: string; exp: number };
  };
}

// "join" イベントの処理: チャンネルに参加する
export const onJoin = async (socket: AuthenticatedSocket, db: mariadb.Pool, channelId: string) => {
  const userId = parseInt(socket.data.user.sub, 10);
  console.log(`User ${userId} requests to join channel ${channelId}`);

  let conn;
  try {
    conn = await db.getConnection();

    // 認可チェック：ユーザーがチャンネル所属サーバーのメンバーか
    const isMember = await conn.query(
      `SELECT 1 FROM chat_server_members sm
       JOIN chat_channels c ON sm.server_id = c.server_id
       WHERE c.id = ? AND sm.user_id = ?`,
      [channelId, userId]
    );
    if (isMember.length === 0) {
      console.warn(`Unauthorized join attempt by user ${userId} to channel ${channelId}`);
      return;
    }

    // 既存のチャンネル(ルーム)から退出
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });

    // 新しいチャンネルに参加
    await socket.join(channelId);
    console.log(`User ${userId} successfully joined channel ${channelId}`);
  } catch (error) {
    console.error('Error during join event:', error);
  } finally {
    conn?.release();
  }
};

// "message" イベントの処理: チャンネルにメッセージを送信する
export const onMessage = async (
  socket: AuthenticatedSocket,
  db: mariadb.Pool,
  io: Server,
  data: { channelId: string; content: string }
) => {
  const userId = parseInt(socket.data.user.sub, 10);
  const { channelId, content } = data;

  if (!content || content.trim().length === 0) {
    return;
  }

  console.log(`Message from user ${userId} to channel ${channelId}: ${content}`);

  if (!socket.rooms.has(channelId)) {
    console.warn(`Unauthorized message from user ${userId} to channel ${channelId} they haven't joined`);
    return;
  }

  let conn;
  try {
    conn = await db.getConnection();

    // メッセージ挿入
    const insertResult = await conn.query(
      'INSERT INTO chat_messages (channel_id, sender_id, content) VALUES (?, ?, ?)',
      [channelId, userId, content]
    );

    const insertedId = insertResult.insertId;

    // 送信者情報取得
    const messageRows = await conn.query(
      `SELECT 
         m.id, m.channel_id, m.content, m.sent_at, m.edited_at,
         u.id as sender_id, u.display_name, u.avatar_url
       FROM chat_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.id = ?`,
      [insertedId]
    );

    if (messageRows.length === 0) {
      console.error('Inserted message not found');
      return;
    }

    // BigIntをNumberに変換
    const m = messageRows[0];
    const fullMessage = {
      id: Number(m.id),
      channel_id: m.channel_id,
      content: m.content,
      sent_at: m.sent_at,
      edited_at: m.edited_at,
      sender: {
        id: Number(m.sender_id),
        displayName: m.display_name,
        avatarUrl: m.avatar_url,
      },
    };

    // ブロードキャスト
    io.to(channelId).emit('newMessage', fullMessage);
    console.log(`Broadcasted message to channel ${channelId}`);
  } catch (error) {
    console.error('Error during message event:', error);
  } finally {
    conn?.release();
  }
};

// "disconnect" イベントの処理（変更なし）
export const onDisconnect = (socket: AuthenticatedSocket) => {
  const userId = socket.data.user?.sub;
  console.log(`User ${userId ?? '(unauthenticated)'} disconnected, socket ID: ${socket.id}`);
};