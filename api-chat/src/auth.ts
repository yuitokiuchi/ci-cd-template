// auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload, VerifyErrors } from 'jsonwebtoken';
import mariadb from 'mariadb';

// Expressの型拡張 (変更なし)
declare global {
  namespace Express {
    interface Request {
      user?: { userId: number };
    }
  }
}

// AccessTokenのペイロードの型定義 (変更なし)
interface AccessTokenPayload extends JwtPayload {
  sub: string;
}

/**
 * 認証ミドルウェアを生成するファクトリー関数
 * @param db - MariaDBのプール
 * @returns Expressミドルウェア
 */
export const createAuthenticateTokenMiddleware = (db: mariadb.Pool) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies['__Secure-access_token'];
    if (!token) {
      return res.sendStatus(401); // Unauthorized
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("FATAL ERROR: JWT_SECRET is not defined.");
      return res.status(500).send('Internal Server Configuration Error');
    }

    try {
      const payload = await new Promise<AccessTokenPayload>((resolve, reject) => {
        jwt.verify(
          token,
          jwtSecret,
          (err: VerifyErrors | null, decoded: JwtPayload | string | undefined) => {
            if (err) {
              return reject(err);
            }
            if (!decoded || typeof decoded !== 'object') {
              return reject(new Error('Invalid token payload format'));
            }
            resolve(decoded as AccessTokenPayload);
          }
        );
      });

      const userId = parseInt(payload.sub, 10);
      if (isNaN(userId)) {
        return res.status(400).send('Invalid user ID in token');
      }

      // JIT Provisioning: ユーザーが存在しなければ作成
      let conn;
      try {
        conn = await db.getConnection();
        const upsertQuery = `
          INSERT INTO users (id, username, display_name)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE 
            username = VALUES(username);
        `;
        await conn.query(upsertQuery, [
          userId,
          userId.toString(),
          `User${userId}`
        ]);
      } catch (e) {
        console.error('Failed to upsert user:', e);
        return res.status(500).send('Internal Server Error');
      } finally {
        conn?.release();
      }

      req.user = { userId };
      next();

    } catch (err) {
      console.warn('JWT Verification Error:', (err as Error).message);
      return res.sendStatus(403); // Forbidden
    }
  };
};
