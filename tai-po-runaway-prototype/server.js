import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const PORT = Number(process.env.PORT || 8787);
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "staff123";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clients = new Set();

const missionTemplates = [
  { id: "opening", name: "開局及逃走開始", startMinute: 0, endMinute: 17 },
  { id: "chip_hunt", name: "尋找籌碼任務", startMinute: 17, endMinute: 39 },
  { id: "kite", name: "睇風箏任務", startMinute: 38, endMinute: 50 },
  { id: "ichiban", name: "一番賞商店", startMinute: 53, endMinute: 61 },
  { id: "photo", name: "二人影相任務", startMinute: 67, endMinute: 87 },
  { id: "revive", name: "復活遊戲", startMinute: 90, endMinute: 120 },
  { id: "move_yuen_chau", name: "前往圓洲仔公園", startMinute: 95, endMinute: 110 },
  { id: "final", name: "最後階段／集合", startMinute: 110, endMinute: 120 }
];

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function initialState() {
  const createdAt = nowIso();
  return {
    participants: [],
    hunters: [
      { id: "hunter_1", name: "Hunter 1", status: "active", caughtCount: 0, createdAt, lastUpdated: createdAt },
      { id: "hunter_2", name: "Hunter 2", status: "active", caughtCount: 0, createdAt, lastUpdated: createdAt }
    ],
    gameState: {
      isStarted: false,
      isPaused: false,
      lastStartedAtMs: null,
      accumulatedMs: 0,
      currentMinute: 0,
      activeMissions: [],
      hunterCount: 2,
      publicMessage: {
        title: "等待工作人員發布",
        body: "請留意工作人員指示。",
        level: "info",
        createdAt
      },
      lastUpdated: createdAt
    },
    missions: missionTemplates.map((mission) => ({
      ...mission,
      isActive: false,
      isManuallyOverridden: false,
      manualActive: null
    })),
    eventLogs: [],
    catchReports: [],
    reviveTrials: {}
  };
}

let state = initialState();

function elapsedMs() {
  if (!state.gameState.isStarted) return 0;
  if (state.gameState.isPaused) return state.gameState.accumulatedMs;
  return state.gameState.accumulatedMs + Date.now() - state.gameState.lastStartedAtMs;
}

function hydrateDerivedState() {
  const minute = Math.floor(elapsedMs() / 60000);
  state.gameState.currentMinute = minute;
  state.gameState.hunterCount = state.hunters.filter((hunter) => hunter.status === "active").length;
  state.missions = state.missions.map((mission) => {
    const scheduled = minute >= mission.startMinute && minute < mission.endMinute;
    const isActive = mission.manualActive === null ? scheduled : mission.manualActive;
    return { ...mission, isActive, isManuallyOverridden: mission.manualActive !== null };
  });
  state.gameState.activeMissions = state.missions.filter((mission) => mission.isActive).map((mission) => mission.name);
}

function publicState() {
  hydrateDerivedState();
  return { ...state, serverNowMs: Date.now() };
}

function logEvent(type, detail, extra = {}) {
  hydrateDerivedState();
  state.eventLogs.unshift({
    id: id("log"),
    minute: state.gameState.currentMinute,
    type,
    participantId: extra.participantId || "",
    hunterId: extra.hunterId || "",
    detail,
    createdAt: nowIso()
  });
  state.eventLogs = state.eventLogs.slice(0, 500);
}

function participantById(participantId) {
  return state.participants.find((participant) => participant.id === participantId);
}

function hunterById(hunterId) {
  return state.hunters.find((hunter) => hunter.id === hunterId);
}

function clearGps(participant) {
  participant.isGPS = false;
  participant.gpsMode = "manual";
  participant.gpsLocation = "";
  participant.gpsLatitude = null;
  participant.gpsLongitude = null;
  participant.gpsAccuracy = null;
  participant.gpsUpdatedAt = null;
  participant.gpsTrackingStatus = "inactive";
}

function enableGps(participant, mode = "live", location = "位置待更新") {
  participant.isGPS = true;
  participant.gpsMode = mode === "manual" ? "manual" : "live";
  participant.gpsLocation = String(location || "位置待更新").slice(0, 80);
  participant.gpsTrackingStatus = participant.gpsMode === "live" ? "waiting" : "manual";
  if (participant.gpsMode === "live") {
    participant.gpsLatitude = null;
    participant.gpsLongitude = null;
    participant.gpsAccuracy = null;
    participant.gpsUpdatedAt = null;
  }
}

function blurCoordinate(value) {
  const grid = 0.0004;
  return Math.round(value / grid) * grid;
}

function addHunter(name) {
  const stamp = nowIso();
  const hunter = {
    id: id("hunter"),
    name: name || `Hunter ${state.hunters.length + 1}`,
    status: "active",
    caughtCount: 0,
    createdAt: stamp,
    lastUpdated: stamp
  };
  state.hunters.push(hunter);
  return hunter;
}

function removeOneHunter() {
  const active = [...state.hunters].reverse().find((hunter) => hunter.status === "active");
  if (!active) return null;
  active.status = "removed";
  active.lastUpdated = nowIso();
  return active;
}

function reviveParticipant(participant, method) {
  if (!participant || participant.status !== "dead") return false;
  const stamp = nowIso();
  participant.status = participant.reviveCount > 0 ? "revived" : "alive";
  participant.reviveCount += 1;
  participant.caughtBy = "";
  participant.reviveRequested = false;
  participant.lastUpdated = stamp;
  delete state.reviveTrials[participant.id];
  state.gameState.publicMessage = {
    title: "復活通知",
    body: `${participant.name} 已透過${method}復活，重新加入遊戲。`,
    level: "mission",
    createdAt: stamp
  };
  logEvent("revived", `${participant.name} 透過${method}復活`, { participantId: participant.id });
  return true;
}

function applyAction(message, socket) {
  const { action, payload = {} } = message;
  const stamp = nowIso();

  switch (action) {
    case "auth:staff":
      send(socket, { type: "auth", ok: payload.password === STAFF_PASSWORD, role: "staff" });
      return;

    case "participant:join": {
      const name = String(payload.name || "").trim();
      if (!name) throw new Error("請輸入參加者姓名");
      let participant = state.participants.find((item) => item.name === name);
      if (!participant) {
        participant = {
          id: id("participant"),
          name,
          status: "alive",
          chips: 1,
          hasPlayedIchiban: false,
          photoCompleted: false,
          isGPS: false,
          gpsMode: "manual",
          gpsLocation: "",
          gpsLatitude: null,
          gpsLongitude: null,
          gpsAccuracy: null,
          gpsUpdatedAt: null,
          gpsTrackingStatus: "inactive",
          reviveCount: 0,
          caughtBy: "",
          reviveRequested: false,
          createdAt: stamp,
          lastUpdated: stamp
        };
        state.participants.push(participant);
        logEvent("participant_joined", `${name} 加入活動`, { participantId: participant.id });
      }
      send(socket, { type: "joined", role: "participant", id: participant.id, name: participant.name });
      break;
    }

    case "hunter:join": {
      const name = String(payload.name || "").trim() || `Hunter ${state.hunters.length + 1}`;
      let hunter = state.hunters.find((item) => item.name === name);
      if (!hunter) {
        hunter = addHunter(name);
        logEvent("hunter_added", `${hunter.name} 加入`, { hunterId: hunter.id });
      }
      if (hunter.status === "removed") hunter.status = "active";
      hunter.lastUpdated = stamp;
      send(socket, { type: "joined", role: "hunter", id: hunter.id, name: hunter.name });
      break;
    }

    case "game:start":
      if (!state.gameState.isStarted) {
        state.gameState.isStarted = true;
        state.gameState.isPaused = false;
        state.gameState.accumulatedMs = 0;
        state.gameState.lastStartedAtMs = Date.now();
        state.gameState.lastUpdated = stamp;
        logEvent("game_started", "活動開始");
      }
      break;

    case "game:pause":
      if (state.gameState.isStarted && !state.gameState.isPaused) {
        state.gameState.accumulatedMs = elapsedMs();
        state.gameState.isPaused = true;
        state.gameState.lastUpdated = stamp;
        logEvent("game_paused", "活動暫停");
      }
      break;

    case "game:resume":
      if (state.gameState.isStarted && state.gameState.isPaused) {
        state.gameState.isPaused = false;
        state.gameState.lastStartedAtMs = Date.now();
        state.gameState.lastUpdated = stamp;
        logEvent("game_resumed", "活動繼續");
      }
      break;

    case "game:setMinute": {
      const minute = Math.max(0, Math.min(120, Number(payload.minute || 0)));
      state.gameState.isStarted = true;
      state.gameState.accumulatedMs = minute * 60000;
      state.gameState.lastStartedAtMs = Date.now();
      state.gameState.lastUpdated = stamp;
      logEvent("game_minute_set", `總控將時間調整至第 ${minute} 分鐘`);
      break;
    }

    case "game:reset":
      state = initialState();
      logEvent("game_reset", "活動重置");
      break;

    case "mission:toggle": {
      const mission = state.missions.find((item) => item.id === payload.missionId);
      if (!mission) throw new Error("找不到任務");
      mission.manualActive = payload.active === null ? null : Boolean(payload.active);
      logEvent("mission_updated", `${mission.name} ${mission.manualActive === null ? "回復自動" : mission.manualActive ? "手動開啟" : "手動關閉"}`);
      break;
    }

    case "participant:selfCaught": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      if (participant.status !== "dead") {
        participant.status = "dead";
        participant.caughtBy = "self_reported";
        clearGps(participant);
        participant.lastUpdated = stamp;
        logEvent("participant_dead", `${participant.name} 回報被捉，狀態轉為死亡`, { participantId: participant.id });
      }
      break;
    }

    case "participant:requestRevive": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      participant.reviveRequested = true;
      participant.lastUpdated = stamp;
      logEvent("revive_requested", `${participant.name} 申請復活`, { participantId: participant.id });
      break;
    }

    case "hunter:catch": {
      const participant = participantById(payload.participantId);
      const hunter = hunterById(payload.hunterId);
      if (!participant || !hunter) throw new Error("找不到參加者或 Hunter");
      if (participant.status === "dead") throw new Error(`${participant.name} 已經死亡`);
      participant.status = "dead";
      participant.caughtBy = hunter.name;
      clearGps(participant);
      participant.lastUpdated = stamp;
      hunter.caughtCount += 1;
      hunter.lastUpdated = stamp;
      state.catchReports.unshift({
        id: id("catch"),
        participantId: participant.id,
        participantName: participant.name,
        hunterId: hunter.id,
        hunterName: hunter.name,
        status: "confirmed",
        createdAt: stamp,
        resolvedAt: stamp
      });
      state.gameState.publicMessage = {
        title: "Hunter 捉人通知",
        body: `${participant.name} 已被 ${hunter.name} 捉到。`,
        level: "danger",
        createdAt: stamp
      };
      logEvent("participant_caught", `${participant.name} 被 ${hunter.name} 捉到`, { participantId: participant.id, hunterId: hunter.id });
      break;
    }

    case "staff:resolveCatch": {
      const report = state.catchReports.find((item) => item.id === payload.reportId);
      if (!report) throw new Error("找不到捉人回報");
      if (report.status !== "pending") throw new Error("此回報已處理");
      const participant = participantById(report.participantId);
      const hunter = hunterById(report.hunterId);
      const confirmed = Boolean(payload.confirmed);
      report.status = confirmed ? "confirmed" : "rejected";
      report.resolvedAt = stamp;
      if (confirmed) {
        if (participant && participant.status !== "dead") {
          participant.status = "dead";
          participant.caughtBy = report.hunterName;
          clearGps(participant);
          participant.lastUpdated = stamp;
        }
        if (hunter) {
          hunter.caughtCount += 1;
          hunter.lastUpdated = stamp;
        }
        state.gameState.publicMessage = {
          title: "捉人確認",
          body: `${report.participantName} 已被 ${report.hunterName} 捉到。`,
          level: "danger",
          createdAt: stamp
        };
        logEvent("participant_caught", `${report.participantName} 被 ${report.hunterName} 捉到，工作人員已確認`, { participantId: report.participantId, hunterId: report.hunterId });
      } else {
        state.gameState.publicMessage = {
          title: "捉人回報取消",
          body: `${report.participantName} 的捉人回報已取消。`,
          level: "info",
          createdAt: stamp
        };
        logEvent("catch_rejected", `${report.participantName} 的捉人回報被工作人員取消`, { participantId: report.participantId, hunterId: report.hunterId });
      }
      break;
    }

    case "staff:publishMessage": {
      const title = String(payload.title || "工作人員發布").trim().slice(0, 80);
      const body = String(payload.body || "").trim().slice(0, 500);
      const level = ["info", "mission", "danger"].includes(payload.level) ? payload.level : "info";
      if (!body) throw new Error("請輸入發布內容");
      state.gameState.publicMessage = { title, body, level, createdAt: stamp };
      state.gameState.lastUpdated = stamp;
      logEvent("staff_message", `${title}：${body}`);
      break;
    }

    case "staff:participantStatus": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      if (payload.status === "alive" || payload.status === "revived") {
        participant.status = payload.status;
        participant.reviveRequested = false;
        participant.caughtBy = "";
        state.gameState.publicMessage = {
          title: "復活通知",
          body: `${participant.name} 已復活，重新加入遊戲。`,
          level: "mission",
          createdAt: stamp
        };
      } else if (payload.status === "dead") {
        participant.status = "dead";
        clearGps(participant);
      }
      participant.lastUpdated = stamp;
      logEvent("participant_status", `${participant.name} 狀態改為 ${participant.status}`, { participantId: participant.id });
      break;
    }

    case "staff:chip": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      const delta = Number(payload.delta || 0);
      participant.chips = Math.max(0, participant.chips + delta);
      participant.lastUpdated = stamp;
      logEvent("chip_updated", `${participant.name} 籌碼 ${delta > 0 ? "+" : ""}${delta}，現有 ${participant.chips}`, { participantId: participant.id });
      break;
    }

    case "staff:photo": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      participant.photoCompleted = Boolean(payload.completed);
      participant.lastUpdated = stamp;
      logEvent("photo_updated", `${participant.name} 二人影相：${participant.photoCompleted ? "已完成" : "未完成"}`, { participantId: participant.id });
      break;
    }

    case "staff:killPhotoIncomplete": {
      let count = 0;
      for (const participant of state.participants) {
        if (!participant.photoCompleted && participant.status !== "dead") {
          participant.status = "dead";
          participant.caughtBy = "photo_failed";
          clearGps(participant);
          participant.lastUpdated = stamp;
          count += 1;
        }
      }
      logEvent("photo_failed_kill", `一鍵處理二人影相未完成者，共 ${count} 人死亡`);
      break;
    }

    case "staff:gps": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      if (Boolean(payload.isGPS)) {
        enableGps(participant, payload.gpsMode, payload.gpsLocation);
      } else {
        clearGps(participant);
      }
      participant.lastUpdated = stamp;
      logEvent(
        participant.isGPS ? "gps_enabled" : "gps_disabled",
        `${participant.name} ${participant.isGPS ? `GPS 啟用（${participant.gpsMode === "live" ? "真實定位" : `手動：${participant.gpsLocation}`}）` : "GPS 取消"}`,
        { participantId: participant.id }
      );
      break;
    }

    case "staff:gpsLocation": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      enableGps(participant, "manual", payload.gpsLocation);
      participant.lastUpdated = stamp;
      logEvent("gps_location", `${participant.name} GPS 位置更新：${participant.gpsLocation}`, { participantId: participant.id });
      break;
    }

    case "participant:gpsUpdate": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      if (!participant.isGPS || participant.gpsMode !== "live" || participant.status === "dead") return;
      const latitude = Number(payload.latitude);
      const longitude = Number(payload.longitude);
      const accuracy = Number(payload.accuracy);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("GPS 座標無效");
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error("GPS 座標超出範圍");
      const previousUpdate = participant.gpsUpdatedAt ? Date.parse(participant.gpsUpdatedAt) : 0;
      if (previousUpdate && Date.now() - previousUpdate < 7000) return;
      participant.gpsLatitude = blurCoordinate(latitude);
      participant.gpsLongitude = blurCoordinate(longitude);
      participant.gpsAccuracy = Math.max(45, Math.min(1000, Number.isFinite(accuracy) ? Math.round(accuracy) : 45));
      participant.gpsUpdatedAt = stamp;
      participant.gpsTrackingStatus = "active";
      participant.gpsLocation = "真實 GPS 約略位置";
      participant.lastUpdated = stamp;
      break;
    }

    case "staff:hunterDelta": {
      const delta = Number(payload.delta || 0);
      if (delta > 0) {
        for (let i = 0; i < delta; i += 1) {
          const hunter = addHunter();
          logEvent("hunter_added", `${hunter.name} 增加`, { hunterId: hunter.id });
        }
      }
      if (delta < 0) {
        for (let i = 0; i < Math.abs(delta); i += 1) {
          const removed = removeOneHunter();
          if (removed) logEvent("hunter_removed", `${removed.name} 移除／減少`, { hunterId: removed.id });
        }
      }
      break;
    }

    case "staff:hunterStatus": {
      const hunter = hunterById(payload.hunterId);
      if (!hunter) throw new Error("找不到 Hunter");
      hunter.status = payload.status;
      hunter.lastUpdated = stamp;
      logEvent("hunter_status", `${hunter.name} 狀態改為 ${hunter.status}`, { hunterId: hunter.id });
      break;
    }

    case "ichiban:draw": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      if (participant.hasPlayedIchiban) throw new Error(`${participant.name} 已玩過一番賞`);
      const result = ["chip", "hunterDown", "gps"].includes(payload.result) ? payload.result : "chip";
      let detail = "";
      if (result === "chip") {
        detail = "抽 1 籌碼（實體籌碼現場處理）";
      }
      if (result === "hunterDown") {
        const removed = removeOneHunter();
        detail = removed ? `減 1 Hunter（${removed.name}）` : "減 1 Hunter（場上已無 active Hunter）";
      }
      if (result === "gps") {
        const target = participantById(payload.gpsTargetId) || participant;
        enableGps(target, payload.gpsMode || "live", payload.gpsLocation);
        target.lastUpdated = stamp;
        detail = `+1 GPS：${target.name}（${target.gpsMode === "live" ? "真實定位" : "手動位置"}）`;
      }
      participant.hasPlayedIchiban = true;
      participant.lastUpdated = stamp;
      state.gameState.publicMessage = {
        title: "一番賞結果",
        body: `${participant.name} 的一番賞結果：${detail}`,
        level: "mission",
        createdAt: stamp
      };
      logEvent("ichiban_result", `${participant.name} 一番賞結果：${detail}`, { participantId: participant.id });
      send(socket, { type: "drawResult", result, detail });
      break;
    }

    case "revive:pat37": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      if (!reviveParticipant(participant, "拍三七")) throw new Error("只可復活死亡中的參加者");
      break;
    }

    case "revive:flipStart": {
      const participant = participantById(payload.participantId);
      if (!participant) throw new Error("找不到參加者");
      if (participant.status !== "dead") throw new Error("只可為死亡中的參加者開啟復活挑戰");
      participant.lastUpdated = stamp;
      state.reviveTrials[participant.id] = { participantId: participant.id, method: "flip", attempts: [], isOpen: true, createdAt: stamp };
      logEvent("revive_flip_start", `${participant.name} 以現場實體籌碼開始 Flip 洗頭水樽復活`, { participantId: participant.id });
      break;
    }

    case "revive:flipAttempt": {
      const participant = participantById(payload.participantId);
      const trial = state.reviveTrials[payload.participantId];
      if (!participant || !trial || !trial.isOpen) throw new Error("未開始籌碼復活挑戰");
      if (trial.attempts.length >= 3) throw new Error("已完成 3 次挑戰");
      const success = Boolean(payload.success);
      trial.attempts.push({ tryNo: trial.attempts.length + 1, success, createdAt: stamp });
      logEvent("revive_flip_attempt", `${participant.name} Flip 第 ${trial.attempts.length} 次：${success ? "成功" : "失敗"}`, { participantId: participant.id });
      if (success) reviveParticipant(participant, "Flip 洗頭水樽");
      if (!success && trial.attempts.length >= 3) {
        trial.isOpen = false;
        logEvent("revive_flip_failed", `${participant.name} 3 次 Flip 失敗，維持死亡`, { participantId: participant.id });
      }
      break;
    }

    default:
      throw new Error(`未知操作：${action}`);
  }

  broadcast();
}

function websocketAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function send(socket, payload) {
  if (socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(payload));
  const header = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  socket.write(Buffer.concat([header, data]));
}

function broadcast() {
  const payload = { type: "state", state: publicState() };
  for (const socket of clients) send(socket, payload);
}

function handleFrame(socket, chunk) {
  socket._wsBuffer = Buffer.concat([socket._wsBuffer || Buffer.alloc(0), chunk]);

  while (socket._wsBuffer.length >= 2) {
    const buffer = socket._wsBuffer;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) === 0x80;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      const high = buffer.readUInt32BE(2);
      const low = buffer.readUInt32BE(6);
      if (high !== 0) throw new Error("Payload too large");
      length = low;
      offset = 10;
    }

    const maskOffset = masked ? 4 : 0;
    if (buffer.length < offset + maskOffset + length) return;

    let payload = buffer.subarray(offset + maskOffset, offset + maskOffset + length);
    if (masked) {
      const mask = buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    socket._wsBuffer = buffer.subarray(offset + maskOffset + length);

    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x1) {
      try {
        applyAction(JSON.parse(payload.toString("utf8")), socket);
      } catch (error) {
        send(socket, { type: "error", message: error.message || "操作失敗" });
      }
    }
  }
}

function serveFile(req, res) {
  if (req.url === "/health") {
    hydrateDerivedState();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, currentMinute: state.gameState.currentMinute }));
    return;
  }

  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const fileMap = {
    "/index.html": path.join(__dirname, "index.html"),
    "/app.js": path.join(__dirname, "public", "app.js"),
    "/styles.css": path.join(__dirname, "public", "styles.css"),
    "/manifest.json": path.join(__dirname, "public", "manifest.json"),
    "/service-worker.js": path.join(__dirname, "public", "service-worker.js"),
    "/icon.svg": path.join(__dirname, "public", "icon.svg")
  };
  const filePath = fileMap[urlPath];
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  const contentType =
    ext === ".html" ? "text/html; charset=utf-8" :
    ext === ".css" ? "text/css; charset=utf-8" :
    ext === ".json" ? "application/manifest+json; charset=utf-8" :
    ext === ".svg" ? "image/svg+xml; charset=utf-8" :
    "application/javascript; charset=utf-8";
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(serveFile);

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    "",
    ""
  ].join("\r\n"));
  clients.add(socket);
  send(socket, { type: "state", state: publicState() });
  socket.on("data", (chunk) => handleFrame(socket, chunk));
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

setInterval(() => {
  if (state.gameState.isStarted && !state.gameState.isPaused) broadcast();
}, 2000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Tai Po Runaway prototype listening on http://0.0.0.0:${PORT}`);
});
