// routes.ts
import { Router, Request, Response } from 'express';
import mariadb from 'mariadb';
import { createAuthenticateTokenMiddleware } from './auth';
import { v4 as uuidv4 } from 'uuid';

interface AuthenticatedRequest extends Request {
  user?: { userId: number };
}

interface ChatMessageRow {
  id: number;               // BIGINTなのでnumberで十分（JavaScriptのNumberは53bit整数まで安全）
  channel_id: string;       // CHAR(36) → UUIDなどの文字列
  sender_id: number | null; // BIGINTだが、ON DELETE SET NULLなのでnull許容
  content: string;
  sent_at: Date;            // DATETIMEはDate型にマッピング
  edited_at: Date | null;   // NULL可能
  // 送信者のプロフィールはJOINで別途取得する想定
  display_name: string;
  avatar_url: string | null;
}

/**
 * MariaDBから返されたデータ内のBigIntをNumberに変換する。
 * 配列が渡された場合は、配列の各要素を変換する。
 * @param data - DBから返されたオブジェクトまたはオブジェクトの配列
 * @returns BigIntがNumberに変換された新しいオブジェクトまたは配列
 */
function sanitizeBigInts(data: any): any {
  if (Array.isArray(data)) {
    return data.map(item => sanitizeBigInts(item));
  }
  if (data === null || typeof data !== 'object') {
    return data;
  }
  
  const newObj: { [key: string]: any } = {};
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const value = data[key];
      if (typeof value === 'bigint') {
        newObj[key] = Number(value);
      } else {
        newObj[key] = value;
      }
    }
  }
  return newObj;
}

export const createChatRouter = (db: mariadb.Pool): Router => {
  const router = Router();

  // 認証ミドルウェアを全ルートに適用
  router.use(createAuthenticateTokenMiddleware(db));

  // --- Handlers ---

  // GET /servers - 自分が所属するサーバー一覧を取得
  const getMyServers = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    let conn;
    try {
      conn = await db.getConnection();
      const rows = await conn.query(
        `SELECT s.id, s.name, s.created_by, s.visibility FROM chat_servers s
         JOIN chat_server_members sm ON s.id = sm.server_id
         WHERE sm.user_id = ? ORDER BY s.name`,
        [userId]
      );

      res.json(sanitizeBigInts(rows));
    } catch (error) {
      console.error('Failed to fetch servers:', error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  // POST /servers - 新規サーバー作成
  const createServer = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    const { name, visibility } = req.body;

    if (!name || (visibility && !['public', 'private'].includes(visibility))) {
      return res.status(400).send('Invalid input: name and visibility are required.');
    }
    const serverVisibility = visibility || 'private';

    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      const newServerId = uuidv4();

      await conn.query(
        'INSERT INTO chat_servers (id, name, created_by, visibility) VALUES (?, ?, ?, ?)',
        [newServerId, name, userId, serverVisibility]
      );

      // serverResult.insertId は使わなくなる
      await conn.query(
        'INSERT INTO chat_server_members (server_id, user_id) VALUES (?, ?)',
        [newServerId, userId]
      );

      // DBトリガーが#general等のデフォルトチャンネルを作成している想定

      await conn.commit();

      // 作成したサーバーデータを再取得（必要なら）
      const newServer = await conn.query('SELECT * FROM chat_servers WHERE id = ?', [newServerId]);
      res.status(201).json(sanitizeBigInts(newServer[0]));
    } catch (error) {
      await conn?.rollback();
      console.error('Failed to create server:', error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  // GET /servers/public - 公開サーバー一覧（まだ参加してないもののみ）
  const getPublicServers = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    let conn;
    try {
      conn = await db.getConnection();
      const rows = await conn.query(
        `SELECT id, name, created_by FROM chat_servers 
         WHERE visibility = 'public'
         AND id NOT IN (SELECT server_id FROM chat_server_members WHERE user_id = ?)
         ORDER BY name`,
        [userId]
      );
      res.json(sanitizeBigInts(rows));
    } catch (error) {
      console.error('Failed to fetch public servers:', error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  // POST /servers/:serverId/join - 公開サーバーに参加
  const joinServer = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    const { serverId } = req.params;
    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      const serverRows = await conn.query(
        'SELECT visibility FROM chat_servers WHERE id = ? FOR UPDATE',
        [serverId]
      );
      if (serverRows.length === 0) {
        await conn.rollback();
        return res.status(404).send('Server not found');
      }
      if (serverRows[0].visibility !== 'public') {
        await conn.rollback();
        return res.status(403).send('Forbidden: This is a private server.');
      }

      // MariaDBのINSERT IGNOREで重複を無視する書き方
      await conn.query(
        'INSERT IGNORE INTO chat_server_members (server_id, user_id) VALUES (?, ?)',
        [serverId, userId]
      );

      await conn.commit();
      res.status(200).json({ message: 'Successfully joined the server.' });
    } catch (error) {
      await conn?.rollback();
      console.error(`Failed to join server ${serverId}:`, error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  // GET /servers/:serverId/channels - サーバーのチャンネル一覧を取得
  const getChannels = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    const { serverId } = req.params;
    let conn;
    try {
      conn = await db.getConnection();

      const isMember = await conn.query(
        'SELECT 1 FROM chat_server_members WHERE server_id = ? AND user_id = ?',
        [serverId, userId]
      );
      if (isMember.length === 0) {
        return res.status(403).send('Forbidden: You are not a member of this server.');
      }

      const channels = await conn.query(
        'SELECT id, name, topic FROM chat_channels WHERE server_id = ? ORDER BY position, name',
        [serverId]
      );
      res.json(channels);
    } catch (error) {
      console.error('Failed to fetch channels:', error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  /**
   * POST /servers/:serverId/channels - 新しいチャンネルを作成する
   */
  const createChannel = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    const { serverId } = req.params;
    const { name, topic } = req.body;

    // --- 入力値の検証 ---
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
      return res.status(400).send('Invalid input: Channel name is required and must be less than 100 characters.');
    }
    // トピックは任意
    const channelTopic = topic && typeof topic === 'string' ? topic.trim() : '';

    let conn;
    try {
      conn = await db.getConnection();
      
      // --- 認可チェック ---
      // チャンネルを作成しようとしているユーザーが、そのサーバーのメンバーであるかを確認
      const isMember = await conn.query(
        'SELECT 1 FROM chat_server_members WHERE server_id = ? AND user_id = ?',
        [serverId, userId]
      );
      if (isMember.length === 0) {
        return res.status(403).send('Forbidden: You are not a member of this server.');
      }

      // 新しいチャンネルのIDをアプリケーション側で生成
      const newChannelId = uuidv4();

      await conn.query(
        'INSERT INTO chat_channels (id, server_id, name, topic) VALUES (?, ?, ?, ?)',
        [newChannelId, serverId, name.trim(), channelTopic]
      );

      // 作成したチャンネルの情報を取得して返す
      const newChannelRows = await conn.query('SELECT * FROM chat_channels WHERE id = ?', [newChannelId]);
      res.status(201).json(newChannelRows[0]);

    } catch (error: any) {
      // 'ER_DUP_ENTRY'は、ユニークキー制約違反のエラーコード
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).send('A channel with this name already exists in this server.');
      }
      console.error('Failed to create channel:', error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  // GET /channels/:channelId/messages - チャンネルのメッセージ履歴を取得
  const getMessages = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    const { channelId } = req.params;
    let conn;
    try {
      conn = await db.getConnection();

      const memberCheck = await conn.query(
        `SELECT 1 FROM chat_server_members sm
         JOIN chat_channels c ON sm.server_id = c.server_id
         WHERE c.id = ? AND sm.user_id = ?`,
        [channelId, userId]
      );
      if (memberCheck.length === 0) {
        return res.status(403).send('Forbidden: You do not have access to this channel.');
      }

      // MariaDBにはjson_build_objectがないので、JSON組み立てはNode.js側でやるのが簡単です
      const messages = await conn.query(
        `SELECT 
          m.id, m.channel_id, m.content, m.sent_at, m.edited_at,
          u.id as sender_id, u.display_name, u.avatar_url
         FROM chat_messages m
         JOIN users u ON m.sender_id = u.id
         WHERE m.channel_id = ?
         ORDER BY m.sent_at DESC
         LIMIT 50`,
        [channelId]
      );

      const formattedMessages = messages.reverse().map((m: any) => ({
            id: Number(m.id), // BigIntをNumberに明示的に変換
            channel_id: m.channel_id,
            content: m.content,
            sent_at: m.sent_at,
            edited_at: m.edited_at,
            sender: {
                id: Number(m.sender_id), // BigIntをNumberに明示的に変換
                displayName: m.display_name,
                avatarUrl: m.avatar_url,
            }
        }));
        res.json(formattedMessages);
    } catch (error) {
      console.error(`Failed to fetch messages for channel ${channelId}:`, error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  /**
   * GET /me/profile - 自分のプロフィール情報を取得する
   */
  const getMyProfile = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    let conn;
    try {
      conn = await db.getConnection();
      // usersテーブルから、認証されたユーザーの情報を取得
      const userRows = await conn.query(
        "SELECT id, username, display_name, avatar_url, created_at FROM users WHERE id = ?",
        [userId]
      );

      if (userRows.length === 0) {
        // JIT Provisioningが機能していれば、基本的にはこのルートには到達しないはず
        return res.status(404).send('User profile not found.');
      }
      res.json(sanitizeBigInts(userRows[0]));
    } catch (error) {
      console.error('Failed to fetch user profile:', error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  /**
   * PUT /me/profile - 自分のプロフィール情報（表示名、アバター）を更新する
   */
  const updateMyProfile = async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;
    const { displayName, avatarUrl } = req.body;

    // --- 入力値の検証 (Validation) ---
    if (displayName !== undefined) {
        if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 50) {
            return res.status(400).send('Invalid input: displayName must be a non-empty string and less than 50 characters.');
        }
    }
    if (avatarUrl !== undefined) {
        // 簡単なURL形式のチェック（より厳密にするならライブラリを使う）
        if (typeof avatarUrl !== 'string' || (avatarUrl.length > 0 && !avatarUrl.startsWith('http'))) {
            return res.status(400).send('Invalid input: avatarUrl must be a valid URL.');
        }
    }
    if (displayName === undefined && avatarUrl === undefined) {
      return res.status(400).send('No update fields provided.');
    }

    let conn;
    try {
      conn = await db.getConnection();

      // 更新するフィールドと値を動的に構築
      const fieldsToUpdate: string[] = [];
      const values: (string | number)[] = [];

      if (displayName !== undefined) {
        fieldsToUpdate.push("display_name = ?");
        values.push(displayName.trim());
      }
      if (avatarUrl !== undefined) {
        fieldsToUpdate.push("avatar_url = ?");
        values.push(avatarUrl);
      }
      
      values.push(userId); // WHERE句のためのuserId

      const updateQuery = `UPDATE users SET ${fieldsToUpdate.join(', ')} WHERE id = ?`;
      
      await conn.query(updateQuery, values);
      
      // 更新後のプロフィール情報を取得して返す
      const updatedUserRows = await conn.query(
        "SELECT id, username, display_name, avatar_url, created_at FROM users WHERE id = ?",
        [userId]
      );

      res.status(200).json(sanitizeBigInts(updatedUserRows[0]));
    } catch (error) {
      console.error('Failed to update user profile:', error);
      res.status(500).send('Internal Server Error');
    } finally {
      conn?.release();
    }
  };

  // --- ルーター設定 ---

  router.get('/servers', getMyServers);
  router.post('/servers', createServer);
  router.get('/servers/public', getPublicServers);
  router.post('/servers/:serverId/join', joinServer);

  router.get('/servers/:serverId/channels', getChannels);
  router.post('/servers/:serverId/channels', createChannel);
  router.get('/channels/:channelId/messages', getMessages);

  router.get('/me/profile', getMyProfile);
  router.put('/me/profile', updateMyProfile);

  return router;
};
