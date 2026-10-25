import express from "express";
import cors from "cors";
import { initTRPC, TRPCError } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { z } from "zod";
import crypto from "node:crypto";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const t = initTRPC.create({ transformer: superjson });
const rooms = new Map();
const tRPCError = (code, message) => { throw new TRPCError({ code, message }); };
const newToken = () => crypto.randomBytes(16).toString("hex");
const newCode = () => {
  let code;
  do { code = String(100000 + Math.floor(Math.random() * 900000)); } while (rooms.has(code));
  return code;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

function initialState(players) {
  return {
    status: "waiting",
    phase: "roll",
    players: players.map(p => ({ ...p, tokens: [-1, -1, -1, -1], finishedCount: 0 })),
    currentSeat: 0,
    dice: null,
    legalTokenIds: [],
    winnerSeat: null,
    event: { id: 1, kind: "join", text: "تم إنشاء الغرفة", seat: players[0]?.seat ?? 0, tokenId: null }
  };
}
function publicRoom(room, session) {
  const seat = room.players.find(p => p.token === session.token && p.name === session.name)?.seat;
  if (seat === undefined) tRPCError("FORBIDDEN", "الجلسة غير صالحة لهذه الغرفة");
  return {
    code: room.code,
    maxPlayers: room.maxPlayers,
    hostSeat: room.hostSeat,
    isHost: seat === room.hostSeat,
    yourSeat: seat,
    state: clone(room.state)
  };
}
function getRoom(session) {
  if (!session || typeof session.code !== "string" || typeof session.token !== "string") {
    tRPCError("BAD_REQUEST", "بيانات الجلسة غير مكتملة");
  }
  const room = rooms.get(session.code);
  if (!room) tRPCError("NOT_FOUND", "الغرفة غير موجودة");
  const player = room.players.find(p => p.token === session.token);
  if (!player) tRPCError("FORBIDDEN", "الجلسة غير صالحة");
  return { room, player };
}
function emit(room, kind, text, seat, tokenId = null) {
  room.state.event = {
    id: (room.state.event?.id ?? 0) + 1,
    kind, text, seat, tokenId
  };
}
function nextSeat(room, fromSeat) {
  const active = room.players.filter(p => p.tokens.some(x => x !== 57)).map(p => p.seat);
  if (!active.length) return fromSeat;
  for (let step = 1; step <= room.maxPlayers; step++) {
    const candidate = (fromSeat + step) % room.maxPlayers;
    if (active.includes(candidate)) return candidate;
  }
  return fromSeat;
}
function legalTokens(player, dice) {
  return player.tokens.map((pos, id) => {
    if (pos === 57) return -1;
    if (pos === -1) return dice === 6 ? id : -1;
    return pos + dice <= 57 ? id : -1;
  }).filter(id => id >= 0);
}
// Track-relative positions are 0..51, home lane 52..56, completed=57.
// The exact visual mapping is implemented in the APK; this backend only stores progress.
function advance(room, player, tokenId, dice) {
  const before = player.tokens[tokenId];
  if (before === -1) player.tokens[tokenId] = 0;
  else player.tokens[tokenId] = before + dice;
  const after = player.tokens[tokenId];
  if (after === 57) {
    player.finishedCount = player.tokens.filter(p => p === 57).length;
    emit(room, "finish", `${player.name} أوصل قطعة إلى النهاية`, player.seat, tokenId);
  } else {
    emit(room, "move", `${player.name} حرّك قطعة`, player.seat, tokenId);
  }
  // Basic Ludo capture: only on the shared 52-square track, excluding safe squares.
  const safeSquares = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
  if (after >= 0 && after <= 51) {
    const absolute = (player.seat * 13 + after) % 52;
    if (!safeSquares.has(absolute)) {
      for (const other of room.players) {
        if (other.seat === player.seat) continue;
        other.tokens = other.tokens.map((pos, id) => {
          if (pos >= 0 && pos <= 51 && (other.seat * 13 + pos) % 52 === absolute) {
            emit(room, "capture", `${player.name} أكل قطعة من ${other.name}`, player.seat, tokenId);
            return -1;
          }
          return pos;
        });
      }
    }
  }
  if (player.tokens.every(p => p === 57)) {
    room.state.status = "finished";
    room.state.phase = "finish";
    room.state.winnerSeat = player.seat;
    room.state.legalTokenIds = [];
    emit(room, "win", `${player.name} فاز بالمباراة!`, player.seat, tokenId);
    return;
  }
  if (dice !== 6) room.state.currentSeat = nextSeat(room, player.seat);
  room.state.phase = "roll";
  room.state.dice = null;
  room.state.legalTokenIds = [];
}
const sessionSchema = z.object({
  code: z.string().min(1).max(12),
  token: z.string().min(1).max(100),
  name: z.string().optional().default("لاعب")
});
const tRPCSession = sessionSchema;

const router = t.router({
  ludo: t.router({
    create: t.procedure.input(z.object({
      name: z.string().trim().min(1).max(24).default("لاعب"),
      maxPlayers: z.number().int().min(2).max(4).default(4)
    })).mutation(({ input }) => {
      const code = newCode();
      const token = newToken();
      const player = { name: input.name, seat: 0, token };
      const room = {
        code, maxPlayers: input.maxPlayers, hostSeat: 0,
        players: [player],
        state: initialState([{ name: player.name, seat: player.seat, tokens: [-1,-1,-1,-1], finishedCount: 0 }])
      };
      rooms.set(code, room);
      return {
        session: { code, token, name: player.name },
        room: publicRoom(room, { code, token, name: player.name })
      };
    }),
    join: t.procedure.input(z.object({
      name: z.string().trim().min(1).max(24).default("لاعب"),
      code: z.string().trim().min(4).max(12).transform(v => v.toUpperCase())
    })).mutation(({ input }) => {
      const room = rooms.get(input.code);
      if (!room) tRPCError("NOT_FOUND", "رمز الغرفة غير صحيح");
      if (room.state.status !== "waiting") tRPCError("BAD_REQUEST", "بدأت المباراة بالفعل");
      if (room.players.length >= room.maxPlayers) tRPCError("BAD_REQUEST", "الغرفة ممتلئة");
      const seat = Array.from({ length: room.maxPlayers }, (_, i) => i)
        .find(i => !room.players.some(p => p.seat === i));
      const token = newToken();
      const player = { name: input.name, seat, token };
      room.players.push(player);
      room.state.players.push({ name: player.name, seat, tokens: [-1,-1,-1,-1], finishedCount: 0 });
      emit(room, "join", `${player.name} انضم إلى الغرفة`, seat);
      return {
        session: { code: room.code, token, name: player.name },
        room: publicRoom(room, { code: room.code, token, name: player.name })
      };
    }),
    room: t.procedure.input(tRPCSession).query(({ input }) => {
      const { room } = getRoom(input);
      return publicRoom(room, input);
    }),
    start: t.procedure.input(tRPCSession).mutation(({ input }) => {
      const { room, player } = getRoom(input);
      if (player.seat !== room.hostSeat) tRPCError("FORBIDDEN", "صاحب الغرفة فقط يمكنه بدء المباراة");
      if (room.players.length < 2) tRPCError("BAD_REQUEST", "تحتاج إلى لاعبين على الأقل");
      if (room.state.status !== "waiting") tRPCError("BAD_REQUEST", "المباراة بدأت بالفعل");
      room.state.status = "playing";
      room.state.phase = "roll";
      room.state.currentSeat = room.players.slice().sort((a,b)=>a.seat-b.seat)[0].seat;
      emit(room, "start", "بدأت المباراة، حظًا موفقًا!", player.seat);
      return publicRoom(room, input);
    }),
    rematch: t.procedure.input(tRPCSession).mutation(({ input }) => {
      const { room, player } = getRoom(input);
      if (player.seat !== room.hostSeat) tRPCError("FORBIDDEN", "صاحب الغرفة فقط يمكنه بدء جولة جديدة");
      if (room.players.length < 2) tRPCError("BAD_REQUEST", "تحتاج إلى لاعبين على الأقل");
      room.state = initialState(room.players.map(p => ({ name: p.name, seat: p.seat })));
      room.state.status = "playing";
      room.state.currentSeat = room.hostSeat;
      emit(room, "start", "بدأت جولة جديدة", player.seat);
      return publicRoom(room, input);
    }),
    roll: t.procedure.input(tRPCSession).mutation(({ input }) => {
      const { room, player } = getRoom(input);
      if (room.state.status !== "playing") tRPCError("BAD_REQUEST", "المباراة ليست قيد اللعب");
      if (room.state.currentSeat !== player.seat) tRPCError("FORBIDDEN", "ليس دورك");
      if (room.state.phase !== "roll") tRPCError("BAD_REQUEST", "حرّك القطعة أولًا");
      const dice = crypto.randomInt(1, 7);
      room.state.dice = dice;
      room.state.phase = "move";
      room.state.legalTokenIds = legalTokens(room.state.players.find(p => p.seat === player.seat), dice);
      emit(room, "roll", `${player.name} رمى النرد: ${dice}`, player.seat);
      if (!room.state.legalTokenIds.length) {
        room.state.phase = "roll";
        room.state.currentSeat = dice === 6 ? player.seat : nextSeat(room, player.seat);
        room.state.dice = null;
        room.state.legalTokenIds = [];
      }
      return publicRoom(room, input);
    }),
    move: t.procedure.input(tRPCSession.extend({
      tokenId: z.number().int().min(0).max(3)
    })).mutation(({ input }) => {
      const { room, player } = getRoom(input);
      if (room.state.status !== "playing") tRPCError("BAD_REQUEST", "المباراة ليست قيد اللعب");
      if (room.state.currentSeat !== player.seat) tRPCError("FORBIDDEN", "ليس دورك");
      if (room.state.phase !== "move") tRPCError("BAD_REQUEST", "ارمِ النرد أولًا");
      if (!room.state.legalTokenIds.includes(input.tokenId)) tRPCError("BAD_REQUEST", "هذه القطعة لا يمكن تحريكها");
      const statePlayer = room.state.players.find(p => p.seat === player.seat);
      const dice = room.state.dice;
      advance(room, statePlayer, input.tokenId, dice);
      return publicRoom(room, input);
    })
  })
});

app.get("/", (_req, res) => res.json({
  name: "Ludo Royal API",
  status: "ok",
  note: "This is a demo backend. Rooms are stored in memory and reset when the service restarts."
}));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/trpc", createExpressMiddleware({ router, createContext: () => ({}) }));
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`Ludo Royal backend listening on ${port}`));
