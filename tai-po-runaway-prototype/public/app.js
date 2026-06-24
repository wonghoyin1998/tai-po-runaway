const root = document.getElementById("root");

const labels = {
  status: { alive: "存活", dead: "死亡／等待復活", revived: "已復活" },
  hunter: { active: "出場中", paused: "暫停追捕", removed: "已移除" }
};
const gpsLocations = ["近入口", "近公園", "近影相點", "近海濱長廊", "前往圓洲仔公園方向", "位置待更新"];
const messagePresets = [
  ["opening", "開局／遊戲開始", "遊戲正式開始", "遊戲正式開始！請留在指定範圍內，避開 Hunter，並留意最新通知。", "mission"],
  ["chip", "尋找籌碼任務", "尋找籌碼任務", "新任務現已開放。你可自行選擇是否尋找籌碼；籌碼可能有特別用途。請留意工作人員公布的範圍及截止時間。", "mission"],
  ["kite", "睇風箏任務", "睇風箏任務", "請按提示前往指定位置完成睇風箏任務。任務於第 50 分鐘截止；未能完成可能會增加 Hunter。", "mission"],
  ["ichiban", "一番賞開放", "一番賞商店開放", "一番賞商店現已開放至第 61 分鐘。每位參加者限玩一次，須交 1 個實體籌碼。", "mission"],
  ["photo", "二人影相任務", "二人影相任務", "請兩人一組前往指定位置，由工作人員拍照作紀錄。任務於第 87 分鐘截止，未完成者將被判定死亡。", "mission"],
  ["revive", "復活遊戲開放", "復活遊戲開放", "死亡參加者可前往復活區，按工作人員指示挑戰拍三七或 Flip 洗頭水樽。", "mission"],
  ["move", "前往圓洲仔公園", "前往圓洲仔公園", "請於第 110 分鐘前安全前往圓洲仔公園指定範圍。過馬路、樓梯及濕滑位置禁止追捕。", "danger"],
  ["final", "最後階段", "最後階段開始", "最後階段開始！請留在圓洲仔公園指定範圍，並留意最後集合指示。", "danger"],
  ["stop", "停止追捕／集合", "停止追捕", "所有 Hunter 立即停止追捕。所有參加者及 Hunter 請前往指定集合點。", "danger"]
].map(([id, label, title, body, level]) => ({ id, label, title, body, level }));

let socket;
let state;
let connected = false;
let toast = "";
let role = loadRole();
let roleMode = "participant";
let staffTab = "dashboard";
let entryName = "";
let entryPassword = "";
let entryHunterPassword = "";
let stateReceivedAtMs = Date.now();
let publishTitle = "";
let publishBody = "";
let publishLevel = "info";
let staffBusyUntilMs = 0;
let pendingRender = false;
let soundEnabled = false;
let audioContext = null;
let lastPublicMessageAt = "";
let soundLastPlayedAt = 0;
let gpsWatchId = null;
let gpsWakeLock = null;
let gpsLocalStatus = "未開始定位";
let gpsLastSentAt = 0;
let gpsLastPosition = null;

function isStaffFormActive() {
  const tagName = document.activeElement?.tagName;
  return role?.role === "staff" && ["INPUT", "TEXTAREA", "SELECT"].includes(tagName);
}

function isRoleEntryActive() {
  return !role && ["entry-name", "entry-password", "entry-hunter-password"].includes(document.activeElement?.id);
}

function isStaffInteracting() {
  return role?.role === "staff" && (Date.now() < staffBusyUntilMs || isStaffFormActive());
}

function markStaffBusy(ms = 5000) {
  if (role?.role !== "staff") return;
  staffBusyUntilMs = Math.max(staffBusyUntilMs, Date.now() + ms);
}

function renderAfterStaffInteraction() {
  if (role?.role !== "staff") return;
  pendingRender = true;
  window.setTimeout(() => {
    if (!isStaffInteracting() && pendingRender) render(true);
  }, 900);
  window.setTimeout(() => {
    if (!isStaffInteracting() && pendingRender) render(true);
  }, 2200);
}

function enableSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    toast = "此瀏覽器不支援提示聲";
    render(true);
    return;
  }
  audioContext = audioContext || new AudioContextClass();
  soundEnabled = true;
  try {
    audioContext.resume?.();
    playNotificationSound(true);
    window.setTimeout(() => playNotificationSound(true), 280);
    toast = "提示聲已開啟。如沒有聲音，請檢查手機靜音模式及音量。";
    navigator.vibrate?.([120, 60, 120]);
  } catch (error) {
    toast = "提示聲啟用失敗，請再按一次或檢查瀏覽器權限";
  }
  render(true);
}

function playNotificationSound(force = false) {
  if (!soundEnabled || !audioContext) return;
  const now = Date.now();
  if (!force && now - soundLastPlayedAt < 800) return;
  soundLastPlayedAt = now;
  audioContext.resume?.();

  const startAt = audioContext.currentTime + 0.01;
  [880, 1175, 988].forEach((frequency, index) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const toneStart = startAt + index * 0.18;
    osc.type = "square";
    osc.frequency.setValueAtTime(frequency, toneStart);
    gain.gain.setValueAtTime(0.001, toneStart);
    gain.gain.linearRampToValueAtTime(0.42, toneStart + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, toneStart + 0.15);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(toneStart);
    osc.stop(toneStart + 0.16);
  });
  navigator.vibrate?.([160, 70, 160]);
}

function stopLiveGps(status = "定位已停止") {
  if (gpsWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  gpsLastSentAt = 0;
  gpsLastPosition = null;
  gpsLocalStatus = status;
  if (gpsWakeLock) {
    gpsWakeLock.release?.().catch(() => {});
    gpsWakeLock = null;
  }
}

async function requestGpsWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    gpsWakeLock = await navigator.wakeLock.request("screen");
    gpsWakeLock.addEventListener?.("release", () => {
      gpsWakeLock = null;
    });
  } catch (error) {
    gpsWakeLock = null;
  }
}

function activeParticipant() {
  if (role?.role !== "participant" || !state) return null;
  return state.participants.find((item) => item.id === role.id) || state.participants.find((item) => item.name === role.name);
}

function reconcileLiveGps() {
  const participant = activeParticipant();
  const shouldTrack = Boolean(participant?.isGPS && participant.gpsMode === "live" && participant.status !== "dead");
  if (!shouldTrack && gpsWatchId !== null) stopLiveGps(participant?.isGPS ? "目前不需真實定位" : "工作人員已取消 GPS");
}

function startLiveGps() {
  const participant = activeParticipant();
  if (!participant?.isGPS || participant.gpsMode !== "live") {
    toast = "目前未被指定使用真實 GPS";
    render(true);
    return;
  }
  if (!navigator.geolocation) {
    gpsLocalStatus = "此手機／瀏覽器不支援 GPS 定位";
    render(true);
    return;
  }
  if (gpsWatchId !== null) {
    gpsLocalStatus = "GPS 定位運作中";
    render(true);
    return;
  }

  gpsLocalStatus = "正在取得位置，請允許定位權限…";
  requestGpsWakeLock();
  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      gpsLocalStatus = `定位運作中｜手機誤差約 ±${Math.round(position.coords.accuracy || 0)} 米`;
      gpsLastPosition = position;
      const now = Date.now();
      if (now - gpsLastSentAt >= 10000) {
        gpsLastSentAt = now;
        send("participant:gpsUpdate", {
          participantId: participant.id,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy
        });
      }
      render(true);
    },
    (error) => {
      const messages = {
        1: "定位權限被拒絕，請在手機設定允許位置權限",
        2: "暫時無法取得位置，請移到較開揚位置",
        3: "取得位置逾時，系統會繼續重試"
      };
      gpsLocalStatus = messages[error.code] || "GPS 定位失敗";
      if (error.code === 1) stopLiveGps(gpsLocalStatus);
      render(true);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
  render(true);
}

function gpsAgeSeconds(target) {
  if (!target.gpsUpdatedAt) return null;
  return Math.max(0, Math.floor((Date.now() - Date.parse(target.gpsUpdatedAt)) / 1000));
}

function gpsFreshness(target) {
  if (target.gpsMode !== "live") return { label: "手動位置", className: "manual" };
  const age = gpsAgeSeconds(target);
  if (age === null) return { label: "等待參加者開啟定位", className: "waiting" };
  if (age > 60) return { label: `${age} 秒前｜位置已過時`, className: "stale" };
  if (age > 25) return { label: `${age} 秒前｜更新較慢`, className: "waiting" };
  return { label: `${age} 秒前更新`, className: "active" };
}

function gpsMapUrl(target) {
  if (!Number.isFinite(target.gpsLatitude) || !Number.isFinite(target.gpsLongitude)) return "";
  const lat = target.gpsLatitude.toFixed(6);
  const lng = target.gpsLongitude.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

function gpsTargetHtml(target, controls = "") {
  const freshness = gpsFreshness(target);
  const mapUrl = gpsMapUrl(target);
  const locationText = target.gpsMode === "live"
    ? mapUrl
      ? `約略位置｜誤差約 ±${Math.round(target.gpsAccuracy || 45)} 米`
      : "等待參加者按「開始 GPS 定位」"
    : target.gpsLocation || "位置待更新";
  return `
    <div class="gps-target-card ${freshness.className}">
      <div>
        <strong>${escapeHtml(target.name)}</strong>
        <span>${escapeHtml(locationText)}</span>
        <small ${target.gpsUpdatedAt ? `data-gps-updated-at="${escapeHtml(target.gpsUpdatedAt)}"` : ""}>${escapeHtml(freshness.label)}</small>
      </div>
      <div class="gps-actions">
        ${mapUrl ? `<a class="map-link" href="${mapUrl}" target="_blank" rel="noopener">開啟約略地圖</a>` : ""}
        ${controls}
      </div>
    </div>
  `;
}

function loadRole() {
  const storedRole = localStorage.getItem("tp-role");
  if (!storedRole) return null;
  return {
    role: storedRole,
    id: localStorage.getItem("tp-id"),
    name: localStorage.getItem("tp-name")
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function wsUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

function connect() {
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    connected = true;
    toast = "";
    if (gpsWatchId !== null && gpsLastPosition) {
      gpsLastSentAt = 0;
      const participant = activeParticipant();
      if (participant) {
        send("participant:gpsUpdate", {
          participantId: participant.id,
          latitude: gpsLastPosition.coords.latitude,
          longitude: gpsLastPosition.coords.longitude,
          accuracy: gpsLastPosition.coords.accuracy
        });
      }
    }
    if (!role && state) return;
    if (role?.role === "staff" && state) return;
    render();
  };
  socket.onclose = () => {
    connected = false;
    if (!((role?.role === "staff" || !role) && state)) render();
    setTimeout(connect, 1200);
  };
  socket.onerror = () => {
    connected = false;
    socket.close();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const hadState = Boolean(state);
    if (message.type === "state") {
      const previousParticipant = activeParticipant();
      state = message.state;
      stateReceivedAtMs = Date.now();
      reconcileLiveGps();
      const currentParticipant = activeParticipant();
      if (currentParticipant?.isGPS && !previousParticipant?.isGPS) {
        toast = currentParticipant.gpsMode === "live" ? "你已被指定真實 GPS，請按「開始 GPS 定位」" : "你已被 GPS 標記";
        playNotificationSound();
      }
      const messageAt = state.gameState.publicMessage?.createdAt || "";
      if (messageAt && lastPublicMessageAt && messageAt !== lastPublicMessageAt) playNotificationSound();
      if (messageAt) lastPublicMessageAt = messageAt;
    }
    if (message.type === "error") toast = message.message;
    if (message.type === "drawResult") toast = `一番賞結果：${message.detail}`;
    if (message.type === "joined") {
      localStorage.setItem("tp-role", message.role);
      localStorage.setItem("tp-id", message.id);
      localStorage.setItem("tp-name", message.name);
      role = { role: message.role, id: message.id, name: message.name };
    }
    if (message.type === "auth") {
      toast = message.ok ? "工作人員登入成功" : "密碼錯誤";
      if (message.ok) {
        localStorage.setItem("tp-role", "staff");
        localStorage.setItem("tp-id", "staff");
        localStorage.setItem("tp-name", "工作人員");
        role = { role: "staff", id: "staff", name: "工作人員" };
      }
    }
    if (message.type === "hunterAuth") {
      toast = message.ok ? "Hunter 登入成功" : message.message || "Hunter 密碼錯誤";
    }
    if (!role && message.type === "state" && hadState) {
      pendingRender = true;
      return;
    }
    if (isRoleEntryActive()) {
      pendingRender = true;
      return;
    }
    if (role?.role === "staff" && message.type === "state" && hadState) {
      pendingRender = true;
      if (staffTab === "gps" && !isStaffInteracting()) render(true);
      return;
    }
    if (isStaffInteracting()) {
      pendingRender = true;
      renderAfterStaffInteraction();
      return;
    }
    render();
  };
}

function send(action, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast = "連線中斷，正在重新連線中";
    render();
    return;
  }
  socket.send(JSON.stringify({ action, payload }));
}

function confirmSend(message, action, payload = {}) {
  if (window.confirm(message)) send(action, payload);
}

function approximateElapsedMs() {
  if (!state?.gameState?.isStarted) return 0;
  if (state.gameState.isPaused) return state.gameState.accumulatedMs;
  const serverNow = state.serverNowMs + (Date.now() - stateReceivedAtMs);
  return Math.max(0, state.gameState.accumulatedMs + serverNow - state.gameState.lastStartedAtMs);
}

function formatCountdown() {
  const totalSeconds = 120 * 60;
  const elapsedSeconds = Math.floor(approximateElapsedMs() / 1000);
  const remaining = Math.max(0, totalSeconds - elapsedSeconds);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function currentMinuteText() {
  return Math.floor(approximateElapsedMs() / 60000);
}

function header(title, subtitle = "", right = "") {
  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">大埔逃走中</p>
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      ${right ? `<div class="topbar-right">${right}</div>` : ""}
    </header>
  `;
}

function timePanel() {
  const missions = state.gameState.activeMissions;
  return `
    <section class="panel urgent-panel">
      <div class="time-grid">
        <div><span class="label">剩餘</span><strong data-time-countdown>${formatCountdown()}</strong></div>
        <div><span class="label">目前</span><strong data-time-minute>第 ${currentMinuteText()} 分鐘</strong></div>
      </div>
      <div class="mission-strip">
        ${missions.length ? missions.map((mission) => `<span class="badge mission">${escapeHtml(mission)}</span>`).join("") : `<span class="badge">未有開放任務</span>`}
      </div>
      ${state.gameState.isPaused ? `<p class="warning-text">活動已暫停</p>` : ""}
    </section>
  `;
}

function updateVisibleTimeOnly() {
  if (!state) return;
  document.querySelectorAll("[data-time-countdown]").forEach((node) => {
    node.textContent = formatCountdown();
  });
  document.querySelectorAll("[data-time-minute]").forEach((node) => {
    node.textContent = `第 ${currentMinuteText()} 分鐘`;
  });
  document.querySelectorAll("[data-dead-countdown]").forEach((node) => {
    node.textContent = formatCountdown();
  });
  document.querySelectorAll("[data-participant-minute]").forEach((node) => {
    node.textContent = `目前第 ${currentMinuteText()} 分鐘${state.gameState.isPaused ? "｜活動暫停" : ""}`;
  });
  document.querySelectorAll("[data-gps-updated-at]").forEach((node) => {
    const updatedAt = node.dataset.gpsUpdatedAt;
    if (!updatedAt) return;
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 1000));
    node.textContent = age > 60 ? `${age} 秒前｜位置已過時` : age > 25 ? `${age} 秒前｜更新較慢` : `${age} 秒前更新`;
    const card = node.closest(".gps-target-card");
    card?.classList.toggle("stale", age > 60);
    card?.classList.toggle("active", age <= 25);
  });
}

function publicMessageHtml(compact = false) {
  const message = state.gameState.publicMessage || {};
  return `
    <section class="public-message ${message.level || "info"} ${compact ? "compact" : ""}">
      <span class="label">工作人員發布</span>
      <strong>${escapeHtml(message.title || "未有發布")}</strong>
      <p>${escapeHtml(message.body || "請留意工作人員指示。")}</p>
      ${message.createdAt ? `<small>${new Date(message.createdAt).toLocaleTimeString("zh-HK")}</small>` : ""}
    </section>
  `;
}

function remainingPlayersHtml() {
  const remaining = state.participants.filter((item) => item.status !== "dead");
  return `
    <section class="panel remaining-panel">
      <div class="section-heading">
        <h2>尚餘玩家</h2>
        <strong>${remaining.length} 人</strong>
      </div>
      ${remaining.length ? `
        <div class="remaining-grid">
          ${remaining.map((item) => `
            <div class="remaining-player ${item.status}">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${item.status === "revived" ? "已復活" : "存活"}</span>
            </div>
          `).join("")}
        </div>
      ` : `<p class="muted">暫時沒有尚餘玩家。</p>`}
    </section>
  `;
}

function participantOptions(list, selected = "", filter = () => true) {
  return `<option value="">選擇參加者</option>${list.filter(filter).map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}`;
}

function render(force = false) {
  if (!force && isRoleEntryActive()) {
    pendingRender = true;
    return;
  }
  if (!force && isStaffInteracting()) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  root.innerHTML = `
    <div class="app-shell">
      <div class="connection ${connected ? "online" : "offline"}">${connected ? "即時同步中" : "連線中斷／重新連線中"}</div>
      ${toast ? `<div class="toast">${escapeHtml(toast)}</div>` : ""}
      ${!state ? loadingPage() : !role ? rolePage() : routePage()}
    </div>
  `;
  bind();
}

function loadingPage() {
  return `<main>${header("載入中", "正在連接即時同步伺服器")}</main>`;
}

function rolePage() {
  const cards = [
    ["participant", "參加者", "查看倒數、通知與尚餘玩家"],
    ["hunter", "Hunter", "查看存活名單、GPS 目標並確認捉人"],
    ["staff", "工作人員／總控", "管理全部狀態、任務與紀錄"]
  ].map(([value, label, desc]) => `
    <button class="role-card ${roleMode === value ? "selected" : ""}" data-role-mode="${value}">
      <strong>${label}</strong><span>${desc}</span>
    </button>
  `).join("");

  return `
    <main>
      ${header("角色入口", "手機優先即時同步 Prototype")}
      <section class="role-grid">${cards}</section>
      <section class="panel">
        ${roleMode === "staff"
          ? `<label>工作人員密碼</label><input id="entry-password" type="password" placeholder="請輸入密碼" value="${escapeHtml(entryPassword)}" autocomplete="current-password" />`
          : `
            <label>${roleMode === "participant" ? "參加者姓名" : "Hunter 名稱／編號"}</label>
            <input id="entry-name" placeholder="${roleMode === "participant" ? "例如：Samuel" : "例如：Hunter A"}" value="${escapeHtml(entryName)}" />
            ${roleMode === "hunter" ? `
              <label class="entry-extra-label">Hunter 密碼</label>
              <input id="entry-hunter-password" type="password" placeholder="請輸入 Hunter 密碼" value="${escapeHtml(entryHunterPassword)}" autocomplete="current-password" />
            ` : ""}
          `
        }
        <button id="enter-role" class="primary big">進入系統</button>
      </section>
    </main>
  `;
}

function routePage() {
  if (role.role === "participant") return participantPage();
  if (role.role === "hunter") return hunterPage();
  return staffPage();
}

function participantPage() {
  const participant = state.participants.find((item) => item.id === role.id) || state.participants.find((item) => item.name === role.name);
  if (!participant) return `<main>${header("正在同步身份", "如停留太久，請重新進入角色入口", `<button id="logout">返回</button>`)}</main>`;
  const tone = state.gameState.isPaused ? "paused" : "live";
  const isDead = participant.status === "dead";
  if (isDead) {
    return `
      <main class="dead-screen">
        <div class="dead-actions">
          <button id="sound-toggle">${soundEnabled ? "提示聲已開" : "開提示聲"}</button>
          <button id="logout">返回</button>
        </div>
        <section class="death-fullscreen">
          <span>你已被捉</span>
          <strong>死亡／等待復活</strong>
          <p>請立即前往復活區，等候工作人員完成復活。</p>
          <div class="dead-clock">
            <small>活動倒數</small>
            <b data-dead-countdown>${formatCountdown()}</b>
          </div>
        </section>
      </main>
    `;
  }
  return `
    <main>
      ${header(`參加者：${participant.name}`, "請留意時間及工作人員發布", `<button id="sound-toggle">${soundEnabled ? "提示聲已開" : "開提示聲"}</button><button id="logout">返回</button>`)}
      <section class="participant-clock ${tone}">
        <span class="label">活動倒數</span>
        <strong data-time-countdown>${formatCountdown()}</strong>
        <p data-participant-minute>目前第 ${currentMinuteText()} 分鐘${state.gameState.isPaused ? "｜活動暫停" : ""}</p>
      </section>
      ${publicMessageHtml()}
      ${remainingPlayersHtml()}
      ${participant.isGPS ? participantGpsPanel(participant) : ""}
    </main>
  `;
}

function participantGpsPanel(participant) {
  if (participant.gpsMode !== "live") {
    return `<div class="gps-alert">你正被 GPS 定位中：${escapeHtml(participant.gpsLocation || "位置待更新")}</div>`;
  }
  const active = gpsWatchId !== null;
  return `
    <section class="gps-live-panel ${active ? "active" : "waiting"}">
      <span class="gps-kicker">你正被 GPS 定位中</span>
      <strong>${active ? "真實 GPS 已開啟" : "需要開啟真實 GPS"}</strong>
      <p>${escapeHtml(gpsLocalStatus)}</p>
      <p class="gps-instruction">請保持此 Web App 在畫面上及不要鎖屏。系統只會向 Hunter 顯示模糊化後的約略位置。</p>
      <button class="${active ? "" : "primary"} big" id="${active ? "gps-stop-local" : "gps-start-live"}">${active ? "暫停本機定位" : "開始 GPS 定位"}</button>
    </section>
  `;
}

function hunterPage() {
  const hunter = state.hunters.find((item) => item.id === role.id) || state.hunters.find((item) => item.name === role.name);
  if (!hunter) return `<main>${header("正在同步 Hunter 身份", "", `<button id="logout">返回</button>`)}</main>`;
  const alive = state.participants.filter((participant) => participant.status !== "dead");
  const gpsTargets = state.participants.filter((participant) => participant.isGPS);
  return `
    <main>
      ${header(hunter.name, `狀態：${labels.hunter[hunter.status]}`, `<button id="sound-toggle">${soundEnabled ? "提示聲已開" : "開提示聲"}</button><button id="logout">返回</button>`)}
      ${timePanel()}
      ${publicMessageHtml(true)}
      <section class="panel hunter-panel">
        <h2>GPS 目標</h2>
        ${gpsTargets.length ? gpsTargets.map((target) => gpsTargetHtml(target)).join("") : `<p class="muted">暫時沒有 GPS 目標。</p>`}
      </section>
      <section class="panel">
        <h2>可追捕參加者</h2>
        <div class="list">
          ${alive.length ? alive.map((participant) => `
            <div class="person-row">
              <div><strong>${escapeHtml(participant.name)}</strong><span>${participant.isGPS ? `GPS：${escapeHtml(gpsFreshness(participant).label)}` : labels.status[participant.status]}</span></div>
              <button class="danger catch-btn" data-hunter="${hunter.id}" data-participant="${participant.id}" data-name="${escapeHtml(participant.name)}">回報捉到</button>
            </div>
          `).join("") : `<p class="muted">暫時沒有存活參加者。</p>`}
        </div>
      </section>
      <section class="panel safety">
        <h2>安全提醒</h2>
        <p>只可輕拍肩膀或手臂。</p>
        <p>不可推撞、拉扯、阻擋。</p>
        <p>不可在馬路、樓梯、濕滑位置高速追捕。</p>
        <p>不可守死復活區、一番賞商店或拍照點。</p>
      </section>
    </main>
  `;
}

function staffPage() {
  const tabs = [["dashboard", "總控"], ["ichiban", "一番賞"], ["gps", "GPS"], ["photo", "影相"], ["revive", "復活"], ["logs", "紀錄"]];
  return `
    <main>
      ${header("工作人員 Dashboard", "總控及任務管理", `<button id="staff-refresh">更新畫面</button><button id="sound-toggle">${soundEnabled ? "測試提示聲" : "開提示聲"}</button><button id="logout">返回</button>`)}
      <nav class="tabs">${tabs.map(([id, label]) => `<button class="tab-btn ${staffTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}</nav>
      ${staffTab === "dashboard" ? dashboardTab() : ""}
      ${staffTab === "ichiban" ? ichibanTab() : ""}
      ${staffTab === "gps" ? gpsTab() : ""}
      ${staffTab === "photo" ? photoTab() : ""}
      ${staffTab === "revive" ? reviveTab() : ""}
      ${staffTab === "logs" ? logsTab() : ""}
    </main>
  `;
}

function dashboardTab() {
  const recentReports = state.catchReports.slice(0, 8);
  return `
    ${timePanel()}
    ${publicMessageHtml(true)}
    <section class="panel">
      <h2>發布訊息給所有參加者</h2>
      <div class="preset-publisher">
        <label>快速任務訊息</label>
        <div class="preset-row">
          <select id="message-preset">
            ${messagePresets.map((preset) => `<option value="${preset.id}">${escapeHtml(preset.label)}</option>`).join("")}
          </select>
          <button id="load-message-preset">載入範本</button>
        </div>
        <p class="muted">載入後可修改標題及內容，再按「立即發布」。</p>
      </div>
      <input id="publish-title" placeholder="標題，例如：前往圓洲仔公園" value="${escapeHtml(publishTitle)}" />
      <textarea id="publish-body" placeholder="內容，例如：請所有參加者於 95-110 分鐘內前往圓洲仔公園。">${escapeHtml(publishBody)}</textarea>
      <select id="publish-level">
        <option value="info" ${publishLevel === "info" ? "selected" : ""}>一般訊息</option>
        <option value="mission" ${publishLevel === "mission" ? "selected" : ""}>任務／指示</option>
        <option value="danger" ${publishLevel === "danger" ? "selected" : ""}>緊急／捉人通知</option>
      </select>
      <button class="primary big" id="publish-message">立即發布</button>
    </section>
    <section class="panel">
      <h2>Hunter 捉人紀錄</h2>
      ${recentReports.length ? recentReports.map((report) => `
        <div class="person-row pending">
          <div>
            <strong>${escapeHtml(report.participantName)}</strong>
            <span>${escapeHtml(report.hunterName)} 捉到｜${new Date(report.createdAt).toLocaleTimeString("zh-HK")}｜已自動發布</span>
          </div>
        </div>
      `).join("") : `<p class="muted">暫時沒有捉人紀錄。</p>`}
    </section>
    <section class="panel">
      <h2>活動時間控制</h2>
      <div class="control-grid">
        <button class="primary" id="game-start">開始活動</button>
        <button id="game-pause">暫停</button>
        <button id="game-resume">繼續</button>
        <button class="danger" id="game-reset">重置</button>
      </div>
      <div class="inline-control">
        <input id="minute-input" type="number" min="0" max="120" value="${state.gameState.currentMinute}" />
        <button id="set-minute">跳到分鐘</button>
      </div>
    </section>
    <section class="panel">
      <h2>手動開關任務</h2>
      <div class="mission-list">
        ${state.missions.map((mission) => `
          <div class="mission-row">
            <div><strong>${escapeHtml(mission.name)}</strong><span>${mission.startMinute}-${mission.endMinute} 分鐘｜${mission.isManuallyOverridden ? "手動" : "自動"}</span></div>
            <div class="mini-actions">
              <button class="mission-btn" data-id="${mission.id}" data-active="true">開</button>
              <button class="mission-btn" data-id="${mission.id}" data-active="false">關</button>
              <button class="mission-btn" data-id="${mission.id}" data-active="auto">自動</button>
            </div>
          </div>
        `).join("")}
      </div>
    </section>
    <section class="panel">
      <h2>參加者總覽</h2>
      <div class="list">
        ${state.participants.length ? state.participants.map(participantAdminRow).join("") : `<p class="muted">尚未有參加者登入。</p>`}
      </div>
    </section>
    <section class="panel">
      <h2>Hunter 總覽</h2>
      <div class="stats-row">
        <div><span>Active</span><strong>${state.hunters.filter((h) => h.status === "active").length}</strong></div>
        <button id="hunter-plus">+ Hunter</button>
        <button id="hunter-minus">- Hunter</button>
      </div>
      ${state.hunters.map((hunter) => `
        <div class="person-row">
          <div><strong>${escapeHtml(hunter.name)}</strong><span>${labels.hunter[hunter.status]}｜捉到 ${hunter.caughtCount}</span></div>
          <div class="mini-actions">
            <button class="hunter-status" data-id="${hunter.id}" data-status="paused">暫停</button>
            <button class="hunter-status" data-id="${hunter.id}" data-status="active">恢復</button>
          </div>
        </div>
      `).join("")}
    </section>
  `;
}

function participantAdminRow(participant) {
  return `
    <div class="person-row ${participant.status}">
      <div>
        <strong>${escapeHtml(participant.name)}</strong>
        <span>${labels.status[participant.status]}｜影相 ${participant.photoCompleted ? "完成" : "未"}｜一番賞 ${participant.hasPlayedIchiban ? "已記錄" : "未記錄"}｜GPS ${participant.isGPS ? `${participant.gpsMode === "live" ? "真實" : "手動"}／${gpsFreshness(participant).label}` : "OFF"}</span>
      </div>
      <div class="mini-actions">
        <button class="danger participant-action" data-kind="dead" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">死亡</button>
        <button class="blue participant-action" data-kind="revived" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">復活</button>
        <button class="participant-photo" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">影相</button>
        <button class="participant-gps" data-id="${participant.id}" data-isgps="${participant.isGPS}" data-name="${escapeHtml(participant.name)}">GPS</button>
      </div>
    </div>
  `;
}

function ichibanTab() {
  return `
    <section class="panel">
      <h2>一番賞紀錄／發布</h2>
      <p class="muted">一番賞現場用實體抽籤及實體籌碼處理；App 只負責記錄結果及同步通知。</p>
      <select id="ichiban-participant">${participantOptions(state.participants)}</select>
      <div id="ichiban-info" class="checklist"><p>選擇參加者後會顯示是否已記錄一番賞。</p></div>
      <label>現場抽籤結果</label>
      <select id="ichiban-result">
        <option value="chip">抽 1 籌碼</option>
        <option value="hunterDown">減 1 Hunter</option>
        <option value="gps">+1 GPS</option>
      </select>
      <label>如結果是 +1 GPS，指定目標</label>
      <select id="ichiban-gps-target">${participantOptions(state.participants)}</select>
      <select id="ichiban-gps-mode">
        <option value="live">真實 GPS（參加者手機定位）</option>
        <option value="manual">手動大概位置</option>
      </select>
      <select id="ichiban-gps-location">${gpsLocations.map((location) => `<option>${escapeHtml(location)}</option>`).join("")}</select>
      <button class="primary big" id="ichiban-record">記錄並發布結果</button>
    </section>
  `;
}

function gpsTab() {
  const gpsTargets = state.participants.filter((participant) => participant.isGPS);
  return `
    <section class="panel hunter-panel">
      <h2>目前 GPS 目標</h2>
      ${gpsTargets.length ? gpsTargets.map((target) => gpsTargetHtml(
        target,
        `<button class="gps-cancel danger" data-id="${target.id}" data-name="${escapeHtml(target.name)}">取消 GPS</button>`
      )).join("") : `<p class="muted">暫時沒有 GPS 目標。</p>`}
    </section>
    <section class="panel">
      <h2>指定 GPS</h2>
      <select id="gps-participant">${participantOptions(state.participants)}</select>
      <label>定位模式</label>
      <select id="gps-mode">
        <option value="live">真實 GPS（建議）</option>
        <option value="manual">手動大概位置（後備）</option>
      </select>
      <div id="gps-manual-fields" class="hidden">
        <label>手動位置</label>
        <select id="gps-location">${gpsLocations.map((location) => `<option>${escapeHtml(location)}</option>`).join("")}</select>
      </div>
      <p class="muted">真實 GPS 啟用後，參加者需要在自己手機按「開始 GPS 定位」並允許位置權限。</p>
      <button class="primary big" id="gps-update">啟用／更新 GPS</button>
    </section>
  `;
}

function photoTab() {
  const incomplete = state.participants.filter((participant) => !participant.photoCompleted);
  return `
    <section class="panel">
      <h2>二人影相管理</h2>
      ${state.gameState.currentMinute >= 87 && incomplete.length ? `<div class="gps-alert">已到 87 分鐘，請處理未完成二人影相的參加者。</div>` : ""}
      ${incomplete.length ? incomplete.map((participant) => `
        <div class="person-row">
          <div><strong>${escapeHtml(participant.name)}</strong><span>${labels.status[participant.status]}</span></div>
          <button class="photo-complete" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">勾選完成</button>
        </div>
      `).join("") : `<p class="muted">所有參加者已完成二人影相。</p>`}
      <button class="danger big" id="kill-photo-incomplete" ${incomplete.length ? "" : "disabled"}>一鍵將未完成者設為死亡</button>
    </section>
  `;
}

function reviveTab() {
  const dead = state.participants.filter((participant) => participant.status === "dead");
  return `
    <section class="panel">
      <h2>復活管理</h2>
      <select id="revive-participant">${participantOptions(dead)}</select>
      <div id="revive-info" class="checklist"><p>選擇死亡參加者後會顯示復活資料及挑戰紀錄。</p></div>
      <div class="button-stack">
        <button class="blue" id="revive-pat37">拍三七成功復活</button>
        <button id="revive-flip-start">現場籌碼開始 Flip</button>
      </div>
      <div id="revive-trial"></div>
      ${dead.length ? "" : `<p class="muted">暫時沒有死亡參加者。</p>`}
    </section>
  `;
}

function logsTab() {
  return `
    <section class="panel">
      <h2>活動紀錄</h2>
      <div class="control-grid">
        <button id="export-csv">匯出 CSV</button>
        <button id="copy-logs">複製文字紀錄</button>
      </div>
      <div class="log-list">
        ${state.eventLogs.length ? state.eventLogs.map((log) => `
          <div class="log-row">
            <strong>第 ${log.minute} 分鐘｜${escapeHtml(log.type)}</strong>
            <span>${escapeHtml(log.detail)}</span>
            <small>${new Date(log.createdAt).toLocaleString("zh-HK")}</small>
          </div>
        `).join("") : `<p class="muted">暫時未有紀錄。</p>`}
      </div>
    </section>
  `;
}

function bind() {
  document.querySelectorAll("[data-role-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      roleMode = button.dataset.roleMode;
      render();
    });
  });
  document.getElementById("enter-role")?.addEventListener("click", () => {
    if (roleMode === "staff") {
      entryPassword = document.getElementById("entry-password").value;
      send("auth:staff", { password: entryPassword });
      return;
    }
    entryName = document.getElementById("entry-name").value;
    const name = entryName.trim();
    if (!name) return;
    if (roleMode === "hunter") {
      entryHunterPassword = document.getElementById("entry-hunter-password").value;
      if (!entryHunterPassword) return alert("請輸入 Hunter 密碼。");
      send("hunter:login", { name, password: entryHunterPassword });
      return;
    }
    send("participant:join", { name });
  });
  document.getElementById("entry-name")?.addEventListener("input", (event) => {
    entryName = event.target.value;
  });
  document.getElementById("entry-password")?.addEventListener("input", (event) => {
    entryPassword = event.target.value;
  });
  document.getElementById("entry-hunter-password")?.addEventListener("input", (event) => {
    entryHunterPassword = event.target.value;
  });
  document.getElementById("entry-name")?.addEventListener("blur", () => {
    if (pendingRender) render(true);
  });
  document.getElementById("entry-password")?.addEventListener("blur", () => {
    if (pendingRender) render(true);
  });
  document.getElementById("entry-hunter-password")?.addEventListener("blur", () => {
    if (pendingRender) render(true);
  });
  document.getElementById("logout")?.addEventListener("click", () => {
    stopLiveGps("已離開參加者身份");
    localStorage.removeItem("tp-role");
    localStorage.removeItem("tp-id");
    localStorage.removeItem("tp-name");
    role = null;
    toast = "";
    render();
  });
  document.getElementById("sound-toggle")?.addEventListener("click", enableSound);
  document.getElementById("staff-refresh")?.addEventListener("click", () => {
    staffBusyUntilMs = 0;
    pendingRender = false;
    render(true);
  });

  bindParticipant();
  bindHunter();
  bindStaff();
}

function bindParticipant() {
  document.getElementById("gps-start-live")?.addEventListener("click", startLiveGps);
  document.getElementById("gps-stop-local")?.addEventListener("click", () => {
    stopLiveGps("你已暫停本機定位；工作人員仍顯示 GPS 已啟用");
    render(true);
  });
}

function bindHunter() {
  document.querySelectorAll(".catch-btn").forEach((button) => {
    button.addEventListener("click", () => confirmSend(`回報捉到 ${button.dataset.name}？此訊息會顯示給工作人員，並發布給所有參加者。`, "hunter:catch", {
      hunterId: button.dataset.hunter,
      participantId: button.dataset.participant
    }));
  });
}

function bindStaff() {
  document.querySelector("main")?.addEventListener("focusin", () => markStaffBusy(8000));
  document.querySelector("main")?.addEventListener("input", () => markStaffBusy(8000));
  document.querySelector("main")?.addEventListener("change", () => markStaffBusy(8000));
  document.querySelector("main")?.addEventListener("pointerdown", () => markStaffBusy(3000));

  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => {
      staffBusyUntilMs = 0;
      staffTab = button.dataset.tab;
      render(true);
    });
  });

  document.getElementById("game-start")?.addEventListener("click", () => confirmSend("確認開始活動？", "game:start"));
  document.getElementById("game-pause")?.addEventListener("click", () => confirmSend("確認暫停活動？", "game:pause"));
  document.getElementById("game-resume")?.addEventListener("click", () => confirmSend("確認繼續活動？", "game:resume"));
  document.getElementById("game-reset")?.addEventListener("click", () => confirmSend("確認重置全部活動資料？此操作不可還原。", "game:reset"));
  document.getElementById("set-minute")?.addEventListener("click", () => {
    const minute = document.getElementById("minute-input").value;
    confirmSend(`確認將活動時間調整至第 ${minute} 分鐘？`, "game:setMinute", { minute });
  });

  document.querySelectorAll(".mission-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const active = button.dataset.active === "auto" ? null : button.dataset.active === "true";
      confirmSend("確認更新任務開關？", "mission:toggle", { missionId: button.dataset.id, active });
    });
  });

  document.getElementById("publish-message")?.addEventListener("click", () => {
    publishTitle = document.getElementById("publish-title").value;
    publishBody = document.getElementById("publish-body").value;
    publishLevel = document.getElementById("publish-level").value;
    const title = publishTitle.trim() || "工作人員發布";
    const body = publishBody.trim();
    if (!body) return alert("請輸入發布內容。");
    send("staff:publishMessage", { title, body, level: publishLevel });
    publishTitle = "";
    publishBody = "";
    publishLevel = "info";
    staffBusyUntilMs = 0;
    renderAfterStaffInteraction();
  });
  document.getElementById("load-message-preset")?.addEventListener("click", () => {
    const presetId = document.getElementById("message-preset").value;
    const preset = messagePresets.find((item) => item.id === presetId);
    if (!preset) return;
    publishTitle = preset.title;
    publishBody = preset.body;
    publishLevel = preset.level;
    document.getElementById("publish-title").value = publishTitle;
    document.getElementById("publish-body").value = publishBody;
    document.getElementById("publish-level").value = publishLevel;
    markStaffBusy(8000);
  });
  document.getElementById("publish-title")?.addEventListener("input", (event) => {
    publishTitle = event.target.value;
  });
  document.getElementById("publish-body")?.addEventListener("input", (event) => {
    publishBody = event.target.value;
  });
  document.getElementById("publish-level")?.addEventListener("change", (event) => {
    publishLevel = event.target.value;
  });
  document.getElementById("publish-title")?.addEventListener("blur", renderAfterStaffInteraction);
  document.getElementById("publish-body")?.addEventListener("blur", renderAfterStaffInteraction);
  document.getElementById("publish-level")?.addEventListener("blur", renderAfterStaffInteraction);

  document.querySelectorAll(".participant-action").forEach((button) => {
    button.addEventListener("click", () => confirmSend(`確認將 ${button.dataset.name} 設為${button.dataset.kind === "dead" ? "死亡" : "復活"}？`, "staff:participantStatus", {
      participantId: button.dataset.id,
      status: button.dataset.kind
    }));
  });
  document.querySelectorAll(".participant-photo").forEach((button) => {
    button.addEventListener("click", () => confirmSend(`標記 ${button.dataset.name} 二人影相完成？`, "staff:photo", { participantId: button.dataset.id, completed: true }));
  });
  document.querySelectorAll(".participant-gps").forEach((button) => {
    const enable = button.dataset.isgps !== "true";
    button.addEventListener("click", () => confirmSend(`${button.dataset.name} ${enable ? "啟用 GPS" : "取消 GPS"}？`, "staff:gps", {
      participantId: button.dataset.id,
      isGPS: enable,
      gpsLocation: "位置待更新"
    }));
  });

  document.getElementById("hunter-plus")?.addEventListener("click", () => confirmSend("確認增加 1 位 Hunter？", "staff:hunterDelta", { delta: 1 }));
  document.getElementById("hunter-minus")?.addEventListener("click", () => confirmSend("確認減少 1 位 Hunter？", "staff:hunterDelta", { delta: -1 }));
  document.querySelectorAll(".hunter-status").forEach((button) => {
    button.addEventListener("click", () => confirmSend("確認更新 Hunter 狀態？", "staff:hunterStatus", { hunterId: button.dataset.id, status: button.dataset.status }));
  });

  bindIchiban();
  bindGps();
  bindPhoto();
  bindRevive();
  bindLogs();
}

function bindIchiban() {
  const select = document.getElementById("ichiban-participant");
  const info = document.getElementById("ichiban-info");
  function updateInfo() {
    const participant = state.participants.find((p) => p.id === select?.value);
    if (!participant || !info) return;
    info.innerHTML = `<p>已記錄一番賞：<strong>${participant.hasPlayedIchiban ? "是" : "否"}</strong></p>`;
  }
  select?.addEventListener("change", updateInfo);
  document.getElementById("ichiban-record")?.addEventListener("click", () => {
    const participant = state.participants.find((p) => p.id === select.value);
    if (!participant) return alert("請先選擇參加者。");
    if (participant.hasPlayedIchiban) return alert("此參加者已記錄過一番賞。");
    confirmSend(`確認記錄 ${participant.name} 的現場一番賞結果？`, "ichiban:draw", {
      participantId: participant.id,
      result: document.getElementById("ichiban-result").value,
      gpsTargetId: document.getElementById("ichiban-gps-target").value,
      gpsMode: document.getElementById("ichiban-gps-mode").value,
      gpsLocation: document.getElementById("ichiban-gps-location").value
    });
  });
}

function bindGps() {
  document.querySelectorAll(".gps-cancel").forEach((button) => {
    button.addEventListener("click", () => confirmSend(`取消 ${button.dataset.name} GPS？`, "staff:gps", { participantId: button.dataset.id, isGPS: false }));
  });
  const modeSelect = document.getElementById("gps-mode");
  const manualFields = document.getElementById("gps-manual-fields");
  const updateModeFields = () => manualFields?.classList.toggle("hidden", modeSelect?.value !== "manual");
  modeSelect?.addEventListener("change", updateModeFields);
  updateModeFields();
  document.getElementById("gps-update")?.addEventListener("click", () => {
    const participantId = document.getElementById("gps-participant").value;
    if (!participantId) return alert("請先選擇參加者。");
    const gpsMode = modeSelect.value;
    const gpsLocation = document.getElementById("gps-location")?.value || "位置待更新";
    confirmSend(
      `確認為參加者啟用${gpsMode === "live" ? "真實 GPS" : "手動位置 GPS"}？`,
      "staff:gps",
      { participantId, isGPS: true, gpsMode, gpsLocation }
    );
  });
}

function bindPhoto() {
  document.querySelectorAll(".photo-complete").forEach((button) => {
    button.addEventListener("click", () => confirmSend(`確認 ${button.dataset.name} 已完成二人影相？`, "staff:photo", { participantId: button.dataset.id, completed: true }));
  });
  document.getElementById("kill-photo-incomplete")?.addEventListener("click", () => confirmSend("確認一鍵將所有未完成二人影相者設為死亡？", "staff:killPhotoIncomplete"));
}

function bindRevive() {
  const select = document.getElementById("revive-participant");
  const info = document.getElementById("revive-info");
  const trialBox = document.getElementById("revive-trial");
  function updateRevive() {
    const participant = state.participants.find((p) => p.id === select?.value);
    const trial = state.reviveTrials[select?.value];
    if (participant && info) {
      info.innerHTML = `<p>參加者：<strong>${escapeHtml(participant.name)}</strong></p><p>籌碼以現場實體紀錄為準</p><p>申請復活：<strong>${participant.reviveRequested ? "是" : "未申請／已處理"}</strong></p>`;
    }
    if (trial && trialBox) {
      trialBox.innerHTML = `
        <div class="trial-box">
          <h3>Flip 洗頭水樽挑戰</h3>
          ${[1, 2, 3].map((tryNo) => {
            const attempt = trial.attempts.find((item) => item.tryNo === tryNo);
            return `<p>第 ${tryNo} 次：${attempt ? attempt.success ? "成功" : "失敗" : "未挑戰"}</p>`;
          }).join("")}
          <div class="control-grid">
            <button class="blue" id="flip-success" ${!trial.isOpen || trial.attempts.length >= 3 ? "disabled" : ""}>成功復活</button>
            <button class="danger" id="flip-fail" ${!trial.isOpen || trial.attempts.length >= 3 ? "disabled" : ""}>記錄失敗</button>
          </div>
        </div>
      `;
      document.getElementById("flip-success")?.addEventListener("click", () => confirmSend("確認今次 Flip 成功並復活？", "revive:flipAttempt", { participantId: select.value, success: true }));
      document.getElementById("flip-fail")?.addEventListener("click", () => confirmSend("確認記錄今次 Flip 失敗？", "revive:flipAttempt", { participantId: select.value, success: false }));
    } else if (trialBox) {
      trialBox.innerHTML = "";
    }
  }
  select?.addEventListener("change", updateRevive);
  document.getElementById("revive-pat37")?.addEventListener("click", () => {
    const participant = state.participants.find((p) => p.id === select.value);
    if (!participant) return alert("請先選擇死亡參加者。");
    confirmSend(`確認 ${participant.name} 拍三七成功復活？`, "revive:pat37", { participantId: participant.id });
  });
  document.getElementById("revive-flip-start")?.addEventListener("click", () => {
    const participant = state.participants.find((p) => p.id === select.value);
    if (!participant) return alert("請先選擇死亡參加者。");
    confirmSend(`確認 ${participant.name} 已以現場實體籌碼開始 3 次 Flip 挑戰？`, "revive:flipStart", { participantId: participant.id });
  });
}

function bindLogs() {
  document.getElementById("export-csv")?.addEventListener("click", () => {
    const header = ["createdAt", "minute", "type", "participantId", "hunterId", "detail"];
    const rows = state.eventLogs.map((log) => header.map((key) => `"${String(log[key] ?? "").replaceAll('"', '""')}"`).join(","));
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tai-po-runaway-log-${Date.now()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
  document.getElementById("copy-logs")?.addEventListener("click", async () => {
    const text = state.eventLogs.map((log) => `[${log.createdAt}] 第${log.minute}分鐘 ${log.type}: ${log.detail}`).join("\n");
    await navigator.clipboard?.writeText(text);
    alert("文字紀錄已複製。");
  });
}

connect();
render();
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
setInterval(() => {
  if (!state) return;
  updateVisibleTimeOnly();
  if (isRoleEntryActive()) return;
  if (isStaffInteracting()) return;
  if (role?.role === "staff") return;
  if (role || state.gameState.isStarted) render();
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && gpsWatchId !== null) requestGpsWakeLock();
});
