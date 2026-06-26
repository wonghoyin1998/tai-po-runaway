const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8787;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "staff123";
const HUNTER_PASSWORD = process.env.HUNTER_PASSWORD || "123456";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const TOTAL_MINUTES = 120;
const GPS_UPDATE_MIN_MS = 7500;

if (process.argv.includes("--check")) {
  console.log("Build check passed.");
  process.exit(0);
}

const chipLocations = [
  { id: "chip-01", title: "雲南黃素馨植物牌", hint: "搵到寫住 Jasminum mesnyi／雲南黃素馨嘅植物介紹牌。", image: "/public/assets/chip-locations/chip-01-jasmine.jpg" },
  { id: "chip-02", title: "海濱導覽圖附近", hint: "木板平台附近，搵到大型海濱導覽圖同安全提示牌。", image: "/public/assets/chip-locations/chip-02-viewpoint-board.jpg" },
  { id: "chip-03", title: "救生圈位置", hint: "搵到橙色救生圈，留意附近但唔好觸碰救生設備。", image: "/public/assets/chip-locations/chip-03-lifebuoy.jpg" },
  { id: "chip-04", title: "白色方形牆洞", hint: "林蔭位置入面，有一幅白色牆同長方形洞。", image: "/public/assets/chip-locations/chip-04-white-wall.jpg" },
  { id: "chip-05", title: "黃色雀鳥雕塑", hint: "搵到大型黃色雀鳥雕塑。", image: "/public/assets/chip-locations/chip-05-bird-statue.jpg" },
  { id: "chip-06", title: "46 號黑色柱", hint: "搵到黑色燈柱／柱身上寫住 46。", image: "/public/assets/chip-locations/chip-06-pole-46.jpg" },
  { id: "chip-07", title: "榕樹樹牌", hint: "搵到寫住榕樹／Ficus microcarpa 嘅綠色樹牌。", image: "/public/assets/chip-locations/chip-07-banyan-sign.jpg" }
];

const missionTemplates = [
  { id: "opening", level: "info", title: "逃走開始", body: "活動正式開始。請保持安全距離，避開 Hunter，留意工作人員發布嘅最新任務。" },
  { id: "chip", level: "mission", title: "尋找籌碼任務開放", body: "尋找籌碼任務開放。請到 App 入面查看 7 個籌碼位置提示，籌碼以實體紀錄為準，安全第一，不用攀爬或進入危險位置。" },
  { id: "kite", level: "mission", title: "風箏任務開始", body: "風箏任務開始。請按現場指示觀察並在 App 提交答案。答案只會由工作人員接收。" },
  { id: "ichiban", level: "mission", title: "一番賞商店開放", body: "一番賞商店現已開放，位置：劇場。每人限玩 1 次，請帶同 1 個實體籌碼到商店。" },
  { id: "photo", level: "mission", title: "二人影相任務開始", body: "二人影相任務開始。位置：火車前草地，請兩人一組搵工作人員影相。87 分鐘前未完成者會死亡。" },
  { id: "revive", level: "info", title: "復活遊戲開放", body: "復活遊戲開放。死亡玩家請到復活區搵工作人員。實體籌碼復活以現場紀錄為準。" },
  { id: "transition", level: "warning", title: "前往圓洲仔公園", body: "請於 95–110 分鐘期間前往圓洲仔公園方向。注意過路及隊伍安全，勿高速追逐。" },
  { id: "final", level: "danger", title: "最後階段", body: "最後階段／集合時間。所有參加者請按工作人員指示前往集合位置。" },
  { id: "pause-hunter", level: "warning", title: "暫停追捕", body: "所有 Hunter 暫停追捕，參加者請留在安全位置並等待下一步指示。" }
];

const ichibanResults = [
  { id: "chip1", label: "抽 1 籌碼", detail: "現場發回 1 個實體籌碼" },
  { id: "reduceHunter", label: "減 1 Hunter", detail: "場上 Hunter 數量減少 1 位" },
  { id: "gps", label: "+1 GPS", detail: "指定一位參加者進入 GPS 定位狀態" },
  { id: "chip2", label: "發回 2 個實體籌碼", detail: "現場發回 2 個實體籌碼" }
];

const missionDefs = [
  { id: "opening", name: "開局及逃走開始", startMinute: 0, endMinute: 17 },
  { id: "chip", name: "尋找籌碼任務", startMinute: 17, endMinute: 39 },
  { id: "kite", name: "風箏任務／答案回報", startMinute: 38, endMinute: 50 },
  { id: "ichiban", name: "一番賞商店：劇場", startMinute: 53, endMinute: 61 },
  { id: "photo", name: "二人影相：火車前草地搵工作人員", startMinute: 67, endMinute: 87 },
  { id: "revive", name: "復活遊戲", startMinute: 90, endMinute: 120 },
  { id: "transition", name: "前往圓洲仔公園", startMinute: 95, endMinute: 110 },
  { id: "final", name: "最後階段／集合", startMinute: 110, endMinute: 120 }
];

function nowIso() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(5).toString("hex")}`; }
function safeName(value) { return String(value || "").trim().slice(0, 28); }
function currentMs() { return Date.now(); }

function initialState() {
  return {
    serverNowMs: currentMs(),
    participants: {},
    hunters: {},
    gameState: {
      isStarted: false,
      isPaused: false,
      lastStartedAtMs: null,
      accumulatedMs: 0,
      currentMinute: 0,
      hunterCount: 2,
      publicMessage: null,
      lastUpdated: nowIso()
    },
    missions: missionDefs.map((m) => ({ ...m, isManuallyOverridden: false, manualActive: false })),
    eventLogs: [],
    catchReports: [],
    kiteAnswers: {},
    chipLocations,
    missionTemplates,
    ichibanResults
  };
}

let state = initialState();
const clients = new Set();

function elapsedMs() {
  const gs = state.gameState;
  if (!gs.isStarted) return 0;
  if (gs.isPaused) return gs.accumulatedMs;
  return gs.accumulatedMs + Math.max(0, currentMs() - (gs.lastStartedAtMs || currentMs()));
}

function currentMinute() {
  return Math.min(TOTAL_MINUTES, Math.floor(elapsedMs() / 60000));
}

function computeActiveMissions() {
  const minute = currentMinute();
  return state.missions.filter((m) => {
    if (m.isManuallyOverridden) return m.manualActive;
    return minute >= m.startMinute && minute < m.endMinute;
  }).map((m) => m.name);
}

function isMissionActive(idValue) {
  const minute = currentMinute();
  const mission = state.missions.find((m) => m.id === idValue);
  if (!mission) return false;
  if (mission.isManuallyOverridden) return mission.manualActive;
  return minute >= mission.startMinute && minute < mission.endMinute;
}

function updateTimeFields() {
  state.serverNowMs = currentMs();
  state.gameState.currentMinute = currentMinute();
  state.gameState.activeMissions = computeActiveMissions();
}

function log(type, detail, extra = {}) {
  updateTimeFields();
  const item = {
    id: id("log"),
    minute: state.gameState.currentMinute,
    type,
    detail,
    participantId: extra.participantId || "",
    hunterId: extra.hunterId || "",
    createdAt: nowIso()
  };
  state.eventLogs.unshift(item);
  state.eventLogs = state.eventLogs.slice(0, 600);
  return item;
}

function setPublicMessage(title, body, level = "info") {
  state.gameState.publicMessage = {
    id: id("msg"),
    title: String(title || "").slice(0, 80),
    body: String(body || "").slice(0, 600),
    level,
    createdAt: nowIso()
  };
  state.gameState.lastUpdated = nowIso();
}

function participantPublic(p) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    photoCompleted: Boolean(p.photoCompleted),
    hasPlayedIchiban: Boolean(p.hasPlayedIchiban),
    isGPS: Boolean(p.isGPS),
    gpsMode: p.gpsMode || "manual",
    gpsLocation: p.gpsLocation || "",
    gpsPublic: p.gpsPublic || null,
    caughtBy: p.caughtBy || "",
    reviveCount: p.reviveCount || 0,
    kiteAnswerSubmitted: Boolean(state.kiteAnswers[p.id])
  };
}

function hunterPublic(h) {
  return {
    id: h.id,
    name: h.name,
    status: h.status,
    caughtCount: h.caughtCount || 0,
    createdAt: h.createdAt,
    lastUpdated: h.lastUpdated
  };
}

function staffState() {
  updateTimeFields();
  return {
    serverNowMs: state.serverNowMs,
    participants: state.participants,
    hunters: state.hunters,
    gameState: state.gameState,
    missions: state.missions,
    eventLogs: state.eventLogs,
    catchReports: state.catchReports,
    kiteAnswers: state.kiteAnswers,
    chipLocations: state.chipLocations,
    missionTemplates: state.missionTemplates,
    ichibanResults: state.ichibanResults
  };
}

function publicState() {
  updateTimeFields();
  return {
    serverNowMs: state.serverNowMs,
    participants: Object.fromEntries(Object.values(state.participants).map((p) => [p.id, participantPublic(p)])),
    hunters: Object.fromEntries(Object.values(state.hunters).map((h) => [h.id, hunterPublic(h)])),
    gameState: state.gameState,
    missions: state.missions,
    eventLogs: state.eventLogs.slice(0, 80),
    catchReports: state.catchReports.slice(0, 50),
    chipLocations: state.chipLocations,
    missionTemplates: state.missionTemplates,
    ichibanResults: state.ichibanResults
  };
}

function stateForClient(client) {
  return client.role === "staff" ? staffState() : publicState();
}

function sendJson(client, payload) {
  try {
    if (client.socket.writable) client.socket.write(encodeFrame(JSON.stringify(payload)));
  } catch (_) {}
}

function broadcast(type = "state") {
  for (const client of clients) {
    sendJson(client, { type, state: stateForClient(client) });
  }
}

function broadcastStaffOnly(type = "state") {
  for (const client of clients) {
    if (client.role === "staff") sendJson(client, { type, state: stateForClient(client) });
  }
}

function findParticipantByName(name) {
  const normalized = safeName(name).toLowerCase();
  return Object.values(state.participants).find((p) => p.name.toLowerCase() === normalized);
}

function findHunterByName(name) {
  const normalized = safeName(name).toLowerCase();
  return Object.values(state.hunters).find((h) => h.name.toLowerCase() === normalized);
}

function ensureStaff(client) {
  if (client.role !== "staff") throw new Error("需要工作人員權限");
}

function ensureHunter(client) {
  if (client.role !== "hunter") throw new Error("需要 Hunter 權限");
}

function ensureParticipant(client) {
  if (client.role !== "participant") throw new Error("需要參加者身份");
}

function getParticipant(idValue) {
  const p = state.participants[idValue];
  if (!p) throw new Error("找不到參加者");
  return p;
}

function getHunter(idValue) {
  const h = state.hunters[idValue];
  if (!h) throw new Error("找不到 Hunter");
  return h;
}

function cancelGps(participant) {
  participant.isGPS = false;
  participant.gpsMode = "manual";
  participant.gpsLocation = "";
  participant.gpsPublic = null;
  participant.gpsLastRawAtMs = 0;
  participant.lastUpdated = nowIso();
}

function blurLocation(lat, lng, accuracy) {
  const grid = 0.0005; // roughly 40-60m in Hong Kong depending on latitude.
  const blurredLat = Math.round(Number(lat) / grid) * grid;
  const blurredLng = Math.round(Number(lng) / grid) * grid;
  const safeAccuracy = Math.max(50, Math.round(Number(accuracy || 0) + 45));
  return {
    lat: Number(blurredLat.toFixed(5)),
    lng: Number(blurredLng.toFixed(5)),
    accuracy: safeAccuracy,
    updatedAt: nowIso(),
    updatedAtMs: currentMs(),
    mapUrl: `https://maps.google.com/?q=${Number(blurredLat.toFixed(5))},${Number(blurredLng.toFixed(5))}`
  };
}

function handleAction(client, action, payload = {}) {
  switch (action) {
    case "join:participant": {
      const name = safeName(payload.name);
      if (!name) throw new Error("請輸入姓名");
      let p = findParticipantByName(name);
      if (!p) {
        p = {
          id: id("p"),
          name,
          status: "alive",
          chips: 0,
          hasPlayedIchiban: false,
          photoCompleted: false,
          isGPS: false,
          gpsMode: "manual",
          gpsLocation: "",
          gpsPublic: null,
          gpsLastRawAtMs: 0,
          reviveCount: 0,
          caughtBy: "",
          reviveRequested: false,
          createdAt: nowIso(),
          lastUpdated: nowIso()
        };
        state.participants[p.id] = p;
        log("participant_joined", `${name} 加入活動`, { participantId: p.id });
      }
      client.role = "participant";
      client.id = p.id;
      sendJson(client, { type: "joined", role: "participant", id: p.id, name: p.name, state: stateForClient(client) });
      broadcast();
      return;
    }
    case "join:hunter": {
      const name = safeName(payload.name);
      const password = String(payload.password || "");
      if (password !== HUNTER_PASSWORD) throw new Error("Hunter 密碼錯誤");
      if (!name) throw new Error("請輸入 Hunter 名稱");
      let h = findHunterByName(name);
      if (!h) {
        h = { id: id("h"), name, status: "active", caughtCount: 0, createdAt: nowIso(), lastUpdated: nowIso() };
        state.hunters[h.id] = h;
        log("hunter_joined", `${name} 加入 Hunter`, { hunterId: h.id });
      }
      client.role = "hunter";
      client.id = h.id;
      sendJson(client, { type: "joined", role: "hunter", id: h.id, name: h.name, state: stateForClient(client) });
      broadcast();
      return;
    }
    case "auth:staff": {
      const ok = String(payload.password || "") === STAFF_PASSWORD;
      if (ok) {
        client.role = "staff";
        client.id = "staff";
      }
      sendJson(client, { type: "auth", ok, state: stateForClient(client) });
      return;
    }
    case "game:start": {
      ensureStaff(client);
      if (!state.gameState.isStarted) {
        state.gameState.isStarted = true;
        state.gameState.isPaused = false;
        state.gameState.lastStartedAtMs = currentMs();
        state.gameState.accumulatedMs = 0;
        log("game_start", "活動開始");
        setPublicMessage("活動開始", "逃走開始，請留意安全及 App 任務訊息。", "info");
      }
      broadcast();
      return;
    }
    case "game:pause": {
      ensureStaff(client);
      if (state.gameState.isStarted && !state.gameState.isPaused) {
        state.gameState.accumulatedMs = elapsedMs();
        state.gameState.isPaused = true;
        state.gameState.lastStartedAtMs = null;
        log("game_pause", "活動暫停");
        setPublicMessage("活動暫停", "請暫停移動及追捕，等待工作人員指示。", "warning");
      }
      broadcast();
      return;
    }
    case "game:resume": {
      ensureStaff(client);
      if (state.gameState.isStarted && state.gameState.isPaused) {
        state.gameState.isPaused = false;
        state.gameState.lastStartedAtMs = currentMs();
        log("game_resume", "活動繼續");
        setPublicMessage("活動繼續", "活動繼續，請留意安全及最新任務。", "info");
      }
      broadcast();
      return;
    }
    case "game:jump": {
      ensureStaff(client);
      const minute = Math.max(0, Math.min(TOTAL_MINUTES, Number(payload.minute || 0)));
      state.gameState.isStarted = true;
      state.gameState.isPaused = false;
      state.gameState.accumulatedMs = minute * 60000;
      state.gameState.lastStartedAtMs = currentMs();
      log("game_jump", `工作人員將時間跳到第 ${minute} 分鐘`);
      broadcast();
      return;
    }
    case "game:reset": {
      ensureStaff(client);
      state = initialState();
      log("game_reset", "活動重置");
      broadcast();
      return;
    }
    case "message:publish": {
      ensureStaff(client);
      const title = String(payload.title || "").trim();
      const body = String(payload.body || "").trim();
      const level = ["info", "mission", "warning", "danger"].includes(payload.level) ? payload.level : "info";
      if (!title && !body) throw new Error("請輸入要發布的內容");
      setPublicMessage(title || "最新消息", body, level);
      log("public_message", `${title || "最新消息"}：${body}`);
      broadcast();
      return;
    }
    case "hunter:catch": {
      ensureHunter(client);
      const hunter = getHunter(client.id);
      if (hunter.status !== "active") throw new Error("Hunter 暫停中，不能捉人");
      const p = getParticipant(payload.participantId);
      if (p.status === "dead") throw new Error("此參加者已死亡");
      p.status = "dead";
      p.caughtBy = hunter.name;
      p.lastUpdated = nowIso();
      cancelGps(p);
      hunter.caughtCount = (hunter.caughtCount || 0) + 1;
      hunter.lastUpdated = nowIso();
      const report = { id: id("catch"), participantId: p.id, participantName: p.name, hunterId: hunter.id, hunterName: hunter.name, createdAt: nowIso() };
      state.catchReports.unshift(report);
      state.catchReports = state.catchReports.slice(0, 100);
      setPublicMessage("捉人通知", `${p.name} 已被 ${hunter.name} 捉到，請立即前往復活區。`, "danger");
      log("participant_caught", `${p.name} 被 ${hunter.name} 捉到`, { participantId: p.id, hunterId: hunter.id });
      broadcast();
      return;
    }
    case "participant:gpsUpdate": {
      ensureParticipant(client);
      const p = getParticipant(client.id);
      if (!p.isGPS || p.gpsMode !== "real" || p.status === "dead") return;
      const now = currentMs();
      if (p.gpsLastRawAtMs && now - p.gpsLastRawAtMs < GPS_UPDATE_MIN_MS) return;
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("GPS 座標格式錯誤");
      p.gpsPublic = blurLocation(lat, lng, payload.accuracy);
      p.gpsLocation = "真實 GPS 約略位置";
      p.gpsLastRawAtMs = now;
      p.lastUpdated = nowIso();
      broadcast();
      return;
    }
    case "kite:submit": {
      ensureParticipant(client);
      const p = getParticipant(client.id);
      if (p.status === "dead") throw new Error("死亡狀態不可提交答案");
      if (!isMissionActive("kite")) throw new Error("風箏任務未開放");
      if (state.kiteAnswers[p.id]) throw new Error("你已提交答案");
      const answer = String(payload.answer || "").trim().slice(0, 200);
      if (!answer) throw new Error("請輸入答案");
      state.kiteAnswers[p.id] = {
        id: id("kite"),
        participantId: p.id,
        participantName: p.name,
        answer,
        status: "pending",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      log("kite_answer_submitted", `${p.name} 已提交風箏答案`, { participantId: p.id });
      sendJson(client, { type: "ok", message: "答案已提交", state: stateForClient(client) });
      broadcast();
      return;
    }
    case "kite:mark": {
      ensureStaff(client);
      const ans = state.kiteAnswers[payload.participantId];
      if (!ans) throw new Error("找不到答案");
      ans.status = payload.status === "correct" ? "correct" : payload.status === "wrong" ? "wrong" : "pending";
      ans.updatedAt = nowIso();
      log("kite_answer_marked", `${ans.participantName} 風箏答案標記為 ${ans.status}`, { participantId: ans.participantId });
      broadcastStaffOnly();
      return;
    }
    case "kite:clear": {
      ensureStaff(client);
      const ans = state.kiteAnswers[payload.participantId];
      if (!ans) return;
      delete state.kiteAnswers[payload.participantId];
      log("kite_answer_cleared", `${ans.participantName} 風箏答案已清除，可重新提交`, { participantId: ans.participantId });
      broadcast();
      return;
    }
    case "staff:participantStatus": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      const status = ["alive", "dead", "revived"].includes(payload.status) ? payload.status : p.status;
      p.status = status;
      if (status === "dead") cancelGps(p);
      p.lastUpdated = nowIso();
      log("participant_status", `${p.name} 狀態改為 ${status}`, { participantId: p.id });
      if (status === "dead") setPublicMessage("死亡通知", `${p.name} 已進入死亡／等待復活狀態，請前往復活區。`, "danger");
      if (status === "alive" || status === "revived") setPublicMessage("復活通知", `${p.name} 已復活並重新加入遊戲。`, "info");
      broadcast();
      return;
    }
    case "staff:photoComplete": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      p.photoCompleted = Boolean(payload.completed);
      p.lastUpdated = nowIso();
      log("photo_status", `${p.name} 二人影相${p.photoCompleted ? "完成" : "取消完成"}`, { participantId: p.id });
      broadcast();
      return;
    }
    case "staff:killPhotoIncomplete": {
      ensureStaff(client);
      const killed = [];
      for (const p of Object.values(state.participants)) {
        if (p.status !== "dead" && !p.photoCompleted) {
          p.status = "dead";
          cancelGps(p);
          killed.push(p.name);
        }
      }
      if (killed.length) setPublicMessage("二人影相任務結束", `未完成二人影相任務的參加者已死亡：${killed.join("、")}`, "danger");
      log("photo_incomplete_dead", `一鍵處理未完成二人影相：${killed.join("、") || "無"}`);
      broadcast();
      return;
    }
    case "staff:gpsEnable": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      p.isGPS = true;
      p.gpsMode = payload.mode === "real" ? "real" : "manual";
      p.gpsLocation = payload.location || (p.gpsMode === "real" ? "等待參加者開啟定位" : "位置待更新");
      p.gpsPublic = p.gpsMode === "real" ? p.gpsPublic : null;
      p.lastUpdated = nowIso();
      setPublicMessage("GPS 啟用", `${p.name} 正被 GPS 定位中。`, "warning");
      log("gps_enabled", `${p.name} GPS 啟用（${p.gpsMode}）`, { participantId: p.id });
      broadcast();
      return;
    }
    case "staff:gpsUpdateManual": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      p.isGPS = true;
      p.gpsMode = "manual";
      p.gpsLocation = String(payload.location || "位置待更新").slice(0, 80);
      p.gpsPublic = null;
      p.lastUpdated = nowIso();
      log("gps_manual", `${p.name} GPS 文字位置：${p.gpsLocation}`, { participantId: p.id });
      broadcast();
      return;
    }
    case "staff:gpsCancel": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      cancelGps(p);
      log("gps_cancelled", `${p.name} GPS 取消`, { participantId: p.id });
      broadcast();
      return;
    }
    case "staff:hunterStatus": {
      ensureStaff(client);
      const h = getHunter(payload.hunterId);
      h.status = ["active", "paused", "removed"].includes(payload.status) ? payload.status : h.status;
      h.lastUpdated = nowIso();
      log("hunter_status", `${h.name} 狀態改為 ${h.status}`, { hunterId: h.id });
      broadcast();
      return;
    }
    case "staff:hunterCount": {
      ensureStaff(client);
      const delta = Number(payload.delta || 0);
      state.gameState.hunterCount = Math.max(0, Number(state.gameState.hunterCount || 0) + delta);
      log("hunter_count", `Hunter 數量 ${delta > 0 ? "+" : ""}${delta}，目前 ${state.gameState.hunterCount}`);
      setPublicMessage("Hunter 數量更新", `場上 Hunter 數量更新：${state.gameState.hunterCount} 位。`, "warning");
      broadcast();
      return;
    }
    case "ichiban:record": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      if (p.hasPlayedIchiban) throw new Error("此參加者已玩過一番賞");
      const result = ichibanResults.find((r) => r.id === payload.resultId);
      if (!result) throw new Error("請選擇一番賞結果");
      p.hasPlayedIchiban = true;
      p.lastUpdated = nowIso();
      let detail = `${p.name} 一番賞結果：${result.label}（${result.detail}）`;
      if (result.id === "reduceHunter") {
        state.gameState.hunterCount = Math.max(0, Number(state.gameState.hunterCount || 0) - 1);
        detail += `；目前 Hunter 數量：${state.gameState.hunterCount}`;
      }
      if (result.id === "gps") {
        const target = getParticipant(payload.gpsTargetId || p.id);
        target.isGPS = true;
        target.gpsMode = "real";
        target.gpsLocation = "等待參加者開啟定位";
        target.lastUpdated = nowIso();
        detail += `；GPS 目標：${target.name}`;
      }
      setPublicMessage("一番賞結果", detail, result.id === "gps" ? "warning" : "info");
      log("ichiban_result", detail, { participantId: p.id });
      broadcast();
      return;
    }
    case "ichiban:resetPlayed": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      p.hasPlayedIchiban = false;
      p.lastUpdated = nowIso();
      log("ichiban_reset", `${p.name} 一番賞狀態重設，可重新記錄`, { participantId: p.id });
      broadcast();
      return;
    }
    case "revive:success": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      p.status = "revived";
      p.reviveCount = (p.reviveCount || 0) + 1;
      p.reviveRequested = false;
      p.caughtBy = "";
      p.lastUpdated = nowIso();
      setPublicMessage("復活通知", `${p.name} 已成功復活，重新加入遊戲。`, "info");
      log("revive_success", `${p.name} 復活成功`, { participantId: p.id });
      broadcast();
      return;
    }
    case "revive:fail": {
      ensureStaff(client);
      const p = getParticipant(payload.participantId);
      log("revive_fail", `${p.name} 復活挑戰失敗，維持死亡`, { participantId: p.id });
      broadcast();
      return;
    }
    case "mission:override": {
      ensureStaff(client);
      const m = state.missions.find((x) => x.id === payload.missionId);
      if (!m) throw new Error("找不到任務");
      m.isManuallyOverridden = Boolean(payload.override);
      m.manualActive = Boolean(payload.active);
      log("mission_override", `${m.name} 手動${m.manualActive ? "開啟" : "關閉"}`);
      broadcast();
      return;
    }
    default:
      throw new Error("未知操作");
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, now: nowIso() }));
    return;
  }
  let filePath = url.pathname === "/" ? path.join(ROOT, "index.html") : path.join(ROOT, decodeURIComponent(url.pathname));
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": mime[path.extname(normalized)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
}

function encodeFrame(payload) {
  const data = Buffer.from(payload);
  const len = data.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), data]);
  if (len < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, data]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let len = second & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buffer.length) break;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    const masked = (second & 0x80) !== 0;
    let mask;
    if (masked) {
      if (pos + 4 > buffer.length) break;
      mask = buffer.slice(pos, pos + 4);
      pos += 4;
    }
    if (pos + len > buffer.length) break;
    const data = Buffer.from(buffer.slice(pos, pos + len));
    if (masked) {
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    }
    if (opcode === 0x8) messages.push({ close: true });
    if (opcode === 0x1) messages.push({ text: data.toString("utf8") });
    offset = pos + len;
  }
  return messages;
}

const server = http.createServer(serveFile);

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
  const client = { socket, role: null, id: null };
  clients.add(client);
  sendJson(client, { type: "state", state: stateForClient(client) });
  socket.on("data", (chunk) => {
    for (const frame of decodeFrames(chunk)) {
      if (frame.close) {
        clients.delete(client);
        socket.end();
        return;
      }
      if (!frame.text) continue;
      try {
        const msg = JSON.parse(frame.text);
        handleAction(client, msg.action, msg.payload || {});
      } catch (err) {
        sendJson(client, { type: "error", message: err.message || "操作失敗", state: stateForClient(client) });
      }
    }
  });
  socket.on("close", () => clients.delete(client));
  socket.on("error", () => clients.delete(client));
});

setInterval(() => broadcast(), 2000);

server.listen(PORT, () => {
  console.log(`Tai Po Runaway server listening on ${PORT}`);
});
