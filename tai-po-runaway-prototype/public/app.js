const root = document.getElementById("root");

const labels = {
  status: { alive: "存活", dead: "死亡／等待復活", revived: "已復活" },
  hunter: { active: "出場中", paused: "暫停追捕", removed: "已移除" }
};
const gpsLocations = ["近入口", "近公園", "近影相點", "近海濱長廊", "前往圓洲仔公園方向", "位置待更新"];

let socket;
let state;
let connected = false;
let toast = "";
let role = loadRole();
let roleMode = "participant";
let staffTab = "dashboard";
let entryName = "";
let entryPassword = "";
let stateReceivedAtMs = Date.now();
let publishTitle = "";
let publishBody = "";
let publishLevel = "info";
let staffBusyUntilMs = 0;
let pendingRender = false;
let soundEnabled = false;
let audioContext = null;
let lastPublicMessageAt = "";

function isStaffFormActive() {
  const tagName = document.activeElement?.tagName;
  return role?.role === "staff" && ["INPUT", "TEXTAREA", "SELECT"].includes(tagName);
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
  window.setTimeout(() => {
    if (pendingRender) render(true);
  }, 5200);
}

function enableSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    toast = "此瀏覽器不支援提示聲";
    render(true);
    return;
  }
  audioContext = audioContext || new AudioContextClass();
  audioContext.resume?.();
  soundEnabled = true;
  toast = "提示聲已開啟";
  render(true);
}

function playNotificationSound() {
  if (!soundEnabled || !audioContext) return;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, audioContext.currentTime);
  gain.gain.setValueAtTime(0.001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.22);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.24);
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
    render();
  };
  socket.onclose = () => {
    connected = false;
    render();
    setTimeout(connect, 1200);
  };
  socket.onerror = () => {
    connected = false;
    socket.close();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      state = message.state;
      stateReceivedAtMs = Date.now();
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
        <div><span class="label">剩餘</span><strong>${formatCountdown()}</strong></div>
        <div><span class="label">目前</span><strong>第 ${currentMinuteText()} 分鐘</strong></div>
      </div>
      <div class="mission-strip">
        ${missions.length ? missions.map((mission) => `<span class="badge mission">${escapeHtml(mission)}</span>`).join("") : `<span class="badge">未有開放任務</span>`}
      </div>
      ${state.gameState.isPaused ? `<p class="warning-text">活動已暫停</p>` : ""}
    </section>
  `;
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
    ["participant", "參加者", "查看自己狀態、籌碼、任務與復活"],
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
          ? `<label>工作人員密碼</label><input id="entry-password" type="password" placeholder="預設 staff123" value="${escapeHtml(entryPassword)}" autocomplete="current-password" />`
          : `<label>${roleMode === "participant" ? "參加者姓名" : "Hunter 名稱／編號"}</label><input id="entry-name" placeholder="${roleMode === "participant" ? "例如：Samuel" : "例如：Hunter A"}" value="${escapeHtml(entryName)}" />`
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
  return `
    <main>
      ${header(`參加者：${participant.name}`, "請留意時間及工作人員發布", `<button id="sound-toggle">${soundEnabled ? "提示聲已開" : "開提示聲"}</button><button id="logout">返回</button>`)}
      <section class="participant-clock ${tone}">
        <span class="label">活動倒數</span>
        <strong>${formatCountdown()}</strong>
        <p>目前第 ${currentMinuteText()} 分鐘${state.gameState.isPaused ? "｜活動暫停" : ""}</p>
      </section>
      ${publicMessageHtml()}
      ${remainingPlayersHtml()}
      ${participant.isGPS ? `<div class="gps-alert">你正被 GPS 定位中：${escapeHtml(participant.gpsLocation || "位置待更新")}</div>` : ""}
    </main>
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
        ${gpsTargets.length ? gpsTargets.map((target) => `
          <div class="target-row"><strong>${escapeHtml(target.name)}</strong><span>${escapeHtml(target.gpsLocation || "位置待更新")}</span></div>
        `).join("") : `<p class="muted">暫時沒有 GPS 目標。</p>`}
      </section>
      <section class="panel">
        <h2>可追捕參加者</h2>
        <div class="list">
          ${alive.length ? alive.map((participant) => `
            <div class="person-row">
              <div><strong>${escapeHtml(participant.name)}</strong><span>${participant.isGPS ? `GPS：${escapeHtml(participant.gpsLocation)}` : `${participant.chips} 籌碼`}</span></div>
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
      ${header("工作人員 Dashboard", "總控及任務管理", `<button id="sound-toggle">${soundEnabled ? "提示聲已開" : "開提示聲"}</button><button id="logout">返回</button>`)}
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
        <span>${labels.status[participant.status]}｜${participant.chips} 籌碼｜影相 ${participant.photoCompleted ? "完成" : "未"}｜一番賞 ${participant.hasPlayedIchiban ? "已玩" : "未玩"}｜GPS ${participant.isGPS ? "ON" : "OFF"}</span>
      </div>
      <div class="mini-actions">
        <button class="danger participant-action" data-kind="dead" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">死亡</button>
        <button class="blue participant-action" data-kind="revived" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">復活</button>
        <button class="participant-chip" data-delta="1" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">+籌</button>
        <button class="participant-chip" data-delta="-1" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">-籌</button>
        <button class="participant-photo" data-id="${participant.id}" data-name="${escapeHtml(participant.name)}">影相</button>
        <button class="participant-gps" data-id="${participant.id}" data-isgps="${participant.isGPS}" data-name="${escapeHtml(participant.name)}">GPS</button>
      </div>
    </div>
  `;
}

function ichibanTab() {
  return `
    <section class="panel">
      <h2>一番賞管理</h2>
      <select id="ichiban-participant">${participantOptions(state.participants)}</select>
      <div id="ichiban-info" class="checklist"><p>選擇參加者後會顯示籌碼及是否已玩。</p></div>
      <label>如抽中 +1 GPS，指定目標</label>
      <select id="ichiban-gps-target">${participantOptions(state.participants)}</select>
      <select id="ichiban-gps-location">${gpsLocations.map((location) => `<option>${escapeHtml(location)}</option>`).join("")}</select>
      <button class="primary big" id="ichiban-draw">抽籤</button>
    </section>
  `;
}

function gpsTab() {
  const gpsTargets = state.participants.filter((participant) => participant.isGPS);
  return `
    <section class="panel hunter-panel">
      <h2>目前 GPS 目標</h2>
      ${gpsTargets.length ? gpsTargets.map((target) => `
        <div class="person-row">
          <div><strong>${escapeHtml(target.name)}</strong><span>${escapeHtml(target.gpsLocation || "位置待更新")}</span></div>
          <button class="gps-cancel" data-id="${target.id}" data-name="${escapeHtml(target.name)}">取消</button>
        </div>
      `).join("") : `<p class="muted">暫時沒有 GPS 目標。</p>`}
    </section>
    <section class="panel">
      <h2>指定／更新 GPS</h2>
      <select id="gps-participant">${participantOptions(state.participants)}</select>
      <select id="gps-location">${gpsLocations.map((location) => `<option>${escapeHtml(location)}</option>`).join("")}</select>
      <button class="primary big" id="gps-update">更新 GPS 位置</button>
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
      <div id="revive-info" class="checklist"><p>選擇死亡參加者後會顯示籌碼及挑戰紀錄。</p></div>
      <div class="button-stack">
        <button class="blue" id="revive-pat37">拍三七成功復活</button>
        <button id="revive-flip-start">使用 1 籌碼開始 Flip</button>
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
    send(roleMode === "participant" ? "participant:join" : "hunter:join", { name });
  });
  document.getElementById("entry-name")?.addEventListener("input", (event) => {
    entryName = event.target.value;
  });
  document.getElementById("entry-password")?.addEventListener("input", (event) => {
    entryPassword = event.target.value;
  });
  document.getElementById("logout")?.addEventListener("click", () => {
    localStorage.removeItem("tp-role");
    localStorage.removeItem("tp-id");
    localStorage.removeItem("tp-name");
    role = null;
    toast = "";
    render();
  });
  document.getElementById("sound-toggle")?.addEventListener("click", enableSound);

  bindParticipant();
  bindHunter();
  bindStaff();
}

function bindParticipant() {
  return;
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
  document.querySelectorAll(".participant-chip").forEach((button) => {
    button.addEventListener("click", () => confirmSend(`${button.dataset.name} 籌碼 ${Number(button.dataset.delta) > 0 ? "+1" : "-1"}？`, "staff:chip", {
      participantId: button.dataset.id,
      delta: Number(button.dataset.delta)
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
    info.innerHTML = `<p>已玩過：<strong>${participant.hasPlayedIchiban ? "是" : "否"}</strong></p><p>籌碼：<strong>${participant.chips}</strong></p>`;
  }
  select?.addEventListener("change", updateInfo);
  document.getElementById("ichiban-draw")?.addEventListener("click", () => {
    const participant = state.participants.find((p) => p.id === select.value);
    if (!participant) return alert("請先選擇參加者。");
    if (participant.hasPlayedIchiban) return alert("此參加者已玩過一番賞。");
    if (participant.chips < 1) return alert("此參加者籌碼不足。");
    confirmSend(`確認扣除 ${participant.name} 1 個籌碼並抽一番賞？`, "ichiban:draw", {
      participantId: participant.id,
      gpsTargetId: document.getElementById("ichiban-gps-target").value,
      gpsLocation: document.getElementById("ichiban-gps-location").value
    });
  });
}

function bindGps() {
  document.querySelectorAll(".gps-cancel").forEach((button) => {
    button.addEventListener("click", () => confirmSend(`取消 ${button.dataset.name} GPS？`, "staff:gps", { participantId: button.dataset.id, isGPS: false }));
  });
  document.getElementById("gps-update")?.addEventListener("click", () => {
    const participantId = document.getElementById("gps-participant").value;
    if (!participantId) return alert("請先選擇參加者。");
    confirmSend("確認啟用／更新 GPS？", "staff:gpsLocation", { participantId, gpsLocation: document.getElementById("gps-location").value });
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
      info.innerHTML = `<p>參加者：<strong>${escapeHtml(participant.name)}</strong></p><p>籌碼：<strong>${participant.chips}</strong></p><p>申請復活：<strong>${participant.reviveRequested ? "是" : "未申請／已處理"}</strong></p>`;
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
    if (participant.chips < 1) return alert("此參加者籌碼不足。");
    confirmSend(`確認扣除 ${participant.name} 1 個籌碼，開始 3 次 Flip 挑戰？`, "revive:flipStart", { participantId: participant.id });
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
setInterval(() => {
  if (!state) return;
  if (isStaffInteracting()) return;
  if (role?.role === "staff") return;
  if (role || state.gameState.isStarted) render();
}, 1000);
