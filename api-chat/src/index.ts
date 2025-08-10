// index.ts
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import mariadb from 'mariadb';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { createChatRouter } from './routes';
import jwt from 'jsonwebtoken';
import { onJoin, onMessage, onDisconnect } from './socketHandlers';

dotenv.config();

// 型定義: socketHandlers.tsと共有できるように、将来的には専用のtypes.tsファイルに切り出すとさらに良い
interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      sub: string; // user_id
      exp: number;
    }
  }
}

// MySQL接続URLをパースしてオブジェクトに変換する関数
function parseDatabaseUrl(databaseUrl: string) {
  // 例: mysql://user:pass@host:3306/dbname
  const regex = /^mysql:\/\/([^:]+):([^@]+)@([^:\/]+)(?::(\d+))?\/(.+)$/;
  const match = databaseUrl.match(regex);
  if (!match) {
    throw new Error('Invalid DATABASE_URL format');
  }
  const [, user, password, host, port, database] = match;
  return {
    host,
    user,
    password,
    database,
    port: port ? Number(port) : 3306,
  };
}

// 環境変数のDATABASE_URLから接続設定を作成
const dbConfig = process.env.DATABASE_URL ? parseDatabaseUrl(process.env.DATABASE_URL) : null;
if (!dbConfig) {
  console.error('DATABASE_URL is not set or invalid');
  process.exit(1);
}

// Express & Server Setup
const app = express();
const httpServer = createServer(app);

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(','),
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Database Pool
const db = mariadb.createPool({
  host: dbConfig.host,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  port: dbConfig.port,
  connectionLimit: 5,
});

// HTTP API Router
app.use('/api/v1/chat', createChatRouter(db));

// Socket.IO Server
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(','),
    credentials: true
  }
});

// Socket.IO Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token as string;
  if (!token) {
    return next(new Error('Authentication error: Missing token'));
  }
  
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("FATAL ERROR: JWT_SECRET is not defined.");
    return next(new Error('Internal server configuration error.'));
  }

  jwt.verify(token, jwtSecret, (err, decoded) => {
    if (err) {
      console.warn(`Token verification failed for socket ${socket.id}: ${err.message}`);
      return next(new Error('Authentication error: Invalid token'));
    }
    (socket as AuthenticatedSocket).data.user = decoded as { sub: string; exp: number; };
    next();
  });
});

// Socket.IO Connection Handler
io.on('connection', (socket) => {
  const authSocket = socket as AuthenticatedSocket;
  console.log(`User connected: ${authSocket.data.user.sub}, socket ID: ${socket.id}`);

  socket.on('join', (channelId: string) => onJoin(authSocket, db, channelId));
  socket.on('message', (data: { channelId: string, content: string }) => onMessage(authSocket, db, io, data));
  socket.on('disconnect', () => onDisconnect(authSocket));
});

// Start Server
const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Chat API server listening on port ${PORT}`);
});
