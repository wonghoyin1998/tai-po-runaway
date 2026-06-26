const root = document.getElementById("root");

const labels = {
  participantStatus: { alive: "存活", dead: "死亡／等待復活", revived: "已復活" },
  hunterStatus: { active: "出場中", paused: "暫停追捕", removed: "已移除" },
  kiteStatus: { pending: "待處理", correct: "正確", wrong: "不正確" }
};

const manualGpsLocations = ["近入口", "近公園", "近影相點", "近海濱長廊", "劇場", "火車前草地", "前往圓洲仔公園方向", "位置待更新"];
let socket;
let state;
let connected = false;
let role = loadRole();
let roleMode = "participant";
let entryName = "";
let entryPassword = "";
let staffTab = "dashboard";
let publishTitle = "";
let publishBody = "";
let publishLevel = "info";
let kiteAnswerDraft = "";
let toast = "";
let stateReceivedAtMs = Date.now();
let pendingStaffUpdate = false;
let soundEnabled = false;
let audioContext = null;
let lastPublicMessageAt = "";
let lastKiteAnswerCount = 0;
let gpsWatchId = null;
let wakeLock = null;

function loadRole() {
  const storedRole = localStorage.getItem("tp-role");
  if (!storedRole) return null;
  return { role: storedRole, id: localStorage.getItem("tp-id"), name: localStorage.getItem("tp-name") };
}

function saveRole(r, id, name) {
  localStorage.setItem("tp-role", r);
  localStorage.setItem("tp-id", id);
  localStorage.setItem("tp-name", name);
  role = { role: r, id, name };
}

function logout() {
  stopGps();
  localStorage.removeItem("tp-role");
  localStorage.removeItem("tp-id");
  localStorage.removeItem("tp-name");
  role = null;
  roleMode = "participant";
  entryName = "";
  entryPassword = "";
  render(true);
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
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
}

function connect() {
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    connected = true;
    toast = "";
    if (!role || !state) render(true);
  };
  socket.onclose = () => {
    connected = false;
    if (!role || role.role !== "staff") render(true);
    setTimeout(connect, 1200);
  };
  socket.onerror = () => {
    connected = false;
    socket.close();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const hadState = Boolean(state);

    if (message.type === "state" || message.state) {
      state = message.state;
      stateReceivedAtMs = Date.now();
      handleNotificationSignals();
    }
    if (message.type === "error") toast = message.message;
    if (message.type === "ok" && message.message) toast = message.message;
    if (message.type === "joined") saveRole(message.role, message.id, message.name);
    if (message.type === "auth") {
      toast = message.ok ? "工作人員登入成功" : "密碼錯誤";
      if (message.ok) saveRole("staff", "staff", "工作人員");
    }

    if (!role && hadState) return;
    if (isFormActive()) return;
    if (role?.role === "staff" && message.type === "state" && hadState) {
      pendingStaffUpdate = true;
      updateStaffUpdateBadge();
      return;
    }
    render(true);
  };
}

function handleNotificationSignals() {
  if (!state) return;
  const messageAt = state.gameState?.publicMessage?.createdAt || "";
  if (messageAt && lastPublicMessageAt && messageAt !== lastPublicMessageAt) playNotificationSound();
  if (messageAt) lastPublicMessageAt = messageAt;
  if (role?.role === "staff") {
    const count = Object.keys(state.kiteAnswers || {}).length;
    if (lastKiteAnswerCount && count > lastKiteAnswerCount) playNotificationSound();
    lastKiteAnswerCount = count;
  }
}

function isFormActive() {
  const tag = document.activeElement?.tagName;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
}

function send(action, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast = "連線中斷，正在重新連線中";
    render(true);
    return;
  }
  socket.send(JSON.stringify({ action, payload }));
}

function confirmSend(message, action, payload = {}) {
  if (window.confirm(message)) send(action, payload);
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
  audioContext.resume?.();
  playBeepSequence(2);
  navigator.vibrate?.([120, 60, 120]);
  toast = "提示聲已開啟；如聽到兩聲即代表成功";
  render(true);
}

function playNotificationSound() {
  if (!soundEnabled) return;
  playBeepSequence(3);
  navigator.vibrate?.([150, 70, 150]);
}

function playBeepSequence(count = 1) {
  if (!audioContext) return;
  audioContext.resume?.();
  for (let i = 0; i < count; i++) {
    const start = audioContext.currentTime + i * 0.18;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(880 + i * 80, start);
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(0.32, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.13);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(start);
    osc.stop(start + 0.14);
  }
}

function approximateElapsedMs() {
  if (!state?.gameState?.isStarted) return 0;
  if (state.gameState.isPaused) return state.gameState.accumulatedMs || 0;
  const serverNow = (state.serverNowMs || Date.now()) + (Date.now() - stateReceivedAtMs);
  return Math.max(0, (state.gameState.accumulatedMs || 0) + serverNow - (state.gameState.lastStartedAtMs || serverNow));
}

function formatCountdown() {
  const total = 120 * 60;
  const elapsed = Math.floor(approximateElapsedMs() / 1000);
  const remaining = Math.max(0, total - elapsed);
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function currentMinuteText() {
  return Math.min(120, Math.floor(approximateElapsedMs() / 60000));
}

function missionActive(id) {
  if (!state?.missions) return false;
  const minute = currentMinuteText();
  const mission = state.missions.find((m) => m.id === id);
  if (!mission) return false;
  if (mission.isManuallyOverridden) return mission.manualActive;
  return minute >= mission.startMinute && minute < mission.endMinute;
}

function updateTimers() {
  document.querySelectorAll("[data-countdown]").forEach((el) => el.textContent = formatCountdown());
  document.querySelectorAll("[data-minute]").forEach((el) => el.textContent = String(currentMinuteText()));
}

function updateStaffUpdateBadge() {
  const badge = document.getElementById("staff-update-badge");
  if (badge) badge.textContent = pendingStaffUpdate ? "有新同步，按更新畫面" : "畫面已更新";
}

function activeMissionNames() {
  return state?.gameState?.activeMissions || [];
}

function values(obj) { return Object.values(obj || {}); }
function participantOptions(selectedId = "") {
  return values(state?.participants).map((p) => `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
}
function deadParticipantOptions() {
  return values(state?.participants).filter((p) => p.status === "dead").map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}
function statusBadge(status) { return `<span class="badge status-${status}">${labels.participantStatus[status] || status}</span>`; }
function levelClass(level) { return ["info", "mission", "warning", "danger"].includes(level) ? level : "info"; }

function render(force = false) {
  updateTimers();
  if (!force && root.innerHTML) return;
  if (!state) {
    root.innerHTML = `<main class="app"><section class="card hero"><h1>大埔逃走中</h1><p>正在連線...</p></section></main>`;
    return;
  }
  if (!role) {
    root.innerHTML = entryPage();
    bindEntryInputs();
    return;
  }
  if (role.role === "participant") root.innerHTML = participantPage();
  if (role.role === "hunter") root.innerHTML = hunterPage();
  if (role.role === "staff") root.innerHTML = staffPage();
  updateTimers();
}

function entryPage() {
  const isP = roleMode === "participant";
  const isH = roleMode === "hunter";
  const isS = roleMode === "staff";
  return `<main class="app entry-app">
    <section class="card hero">
      <div class="connection ${connected ? "online" : "offline"}">${connected ? "即時同步已連線" : "重新連線中"}</div>
      <h1>大埔逃走中</h1>
      <p>選擇身份進入活動系統。</p>
    </section>
    ${toast ? `<div class="toast">${escapeHtml(toast)}</div>` : ""}
    <section class="card">
      <div class="role-grid">
        <button class="role-choice ${isP ? "active" : ""}" data-role-mode="participant">參加者</button>
        <button class="role-choice ${isH ? "active" : ""}" data-role-mode="hunter">Hunter</button>
        <button class="role-choice ${isS ? "active" : ""}" data-role-mode="staff">工作人員</button>
      </div>
      <div class="entry-form">
        ${isP ? `<label>姓名</label><input id="entry-name" autocomplete="name" placeholder="輸入參加者姓名" value="${escapeHtml(entryName)}"><button class="primary big" id="join-participant">進入參加者頁</button>` : ""}
        ${isH ? `<label>Hunter 名稱／編號</label><input id="entry-name" placeholder="例如 Hunter A" value="${escapeHtml(entryName)}"><label>Hunter 密碼</label><input id="entry-password" type="password" inputmode="numeric" placeholder="輸入 Hunter 密碼" value="${escapeHtml(entryPassword)}"><button class="danger big" id="join-hunter">進入 Hunter 頁</button>` : ""}
        ${isS ? `<label>工作人員密碼</label><input id="entry-password" type="password" placeholder="輸入工作人員密碼" value="${escapeHtml(entryPassword)}"><button class="primary big" id="auth-staff">進入總控</button>` : ""}
      </div>
    </section>
  </main>`;
}

function bindEntryInputs() {
  document.getElementById("entry-name")?.addEventListener("input", (e) => entryName = e.target.value);
  document.getElementById("entry-password")?.addEventListener("input", (e) => entryPassword = e.target.value);
}

function participantPage() {
  const p = state.participants?.[role.id];
  if (!p) return `<main class="app"><section class="card"><h1>身份已失效</h1><p>伺服器可能已重啟，請重新登入。</p><button id="logout">重新登入</button></section></main>`;
  if (p.status === "dead") return participantDeadPage(p);
  return `<main class="app participant-app">
    ${topBar("參加者", role.name)}
    <section class="card timer-card">
      <div class="timer-label">剩餘時間</div>
      <div class="timer" data-countdown>${formatCountdown()}</div>
      <div class="minute">目前第 <strong data-minute>${currentMinuteText()}</strong> 分鐘</div>
    </section>
    ${publicMessageHtml()}
    ${participantGpsPanel(p)}
    ${missionToolPanel(p)}
    ${remainingPlayersPanel()}
  </main>`;
}

function participantDeadPage(p) {
  return `<main class="dead-screen">
    <div class="dead-content">
      <div class="dead-icon">⚠️</div>
      <h1>你已被捉</h1>
      <h2>死亡／等待復活</h2>
      <p>請立即前往復活區，等候工作人員完成復活。</p>
      <div class="dead-timer"><span data-countdown>${formatCountdown()}</span></div>
      <small>被捉者：${escapeHtml(p.name)}${p.caughtBy ? `｜Hunter：${escapeHtml(p.caughtBy)}` : ""}</small>
    </div>
  </main>`;
}

function topBar(kind, name) {
  return `<header class="topbar"><div><strong>大埔逃走中</strong><span>${escapeHtml(kind)}｜${escapeHtml(name || "")}</span></div><div class="top-actions"><button id="enable-sound">${soundEnabled ? "提示聲已開" : "開提示聲"}</button><button id="logout">登出</button></div></header>`;
}

function publicMessageHtml() {
  const msg = state.gameState?.publicMessage;
  if (!msg) return `<section class="card muted-card"><h2>最新訊息</h2><p>暫未有工作人員發布訊息。</p></section>`;
  return `<section class="card message-card ${levelClass(msg.level)}"><div class="eyebrow">最新訊息</div><h2>${escapeHtml(msg.title)}</h2><p>${escapeHtml(msg.body)}</p><small>${new Date(msg.createdAt).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></section>`;
}

function participantGpsPanel(p) {
  if (!p.isGPS) return "";
  const real = p.gpsMode === "real";
  return `<section class="card gps-alert">
    <h2>你正被 GPS 定位中</h2>
    <p>${real ? "請保持此畫面開啟，勿鎖屏。定位約每 10 秒更新一次，系統只會分享約略位置。" : `目前位置提示：${escapeHtml(p.gpsLocation || "位置待更新")}`}</p>
    ${real ? `<div class="button-row"><button class="warning" id="start-gps">開始 GPS 定位</button><button id="stop-gps">停止本機定位</button></div><small id="gps-local-status">${gpsWatchId ? "本機 GPS 更新中" : "尚未開始本機 GPS"}</small>` : ""}
  </section>`;
}

function missionToolPanel(p) {
  const blocks = [];
  if (missionActive("chip")) blocks.push(chipLocationPanel());
  if (missionActive("kite")) blocks.push(kiteAnswerPanel(p));
  if (missionActive("ichiban")) blocks.push(`<section class="card mission-card"><h2>一番賞商店</h2><p>位置：<strong>劇場</strong></p><p>每人限玩 1 次，請帶同 1 個實體籌碼到商店。結果以現場抽籤為準。</p></section>`);
  if (missionActive("photo")) blocks.push(`<section class="card mission-card"><h2>二人影相任務</h2><p>位置：<strong>火車前草地</strong>，請兩人一組搵工作人員影相。</p><p>狀態：${p.photoCompleted ? "✅ 已完成" : "⏳ 未完成"}</p></section>`);
  if (!blocks.length) return `<section class="card muted-card"><h2>任務工具</h2><p>目前沒有需要你在 App 操作的任務。請留意工作人員發布訊息。</p></section>`;
  return blocks.join("");
}

function chipLocationPanel() {
  return `<section class="card mission-card"><h2>尋找籌碼位置提示</h2><p>實體籌碼以現場紀錄為準。請勿攀爬、不要觸碰救生設備。</p><div class="chip-gallery">${(state.chipLocations || []).map((loc, index) => `
    <article class="chip-card">
      <img src="${loc.image}" alt="${escapeHtml(loc.title)}" loading="lazy">
      <div><strong>${index + 1}. ${escapeHtml(loc.title)}</strong><p>${escapeHtml(loc.hint)}</p></div>
    </article>`).join("")}</div></section>`;
}

function kiteAnswerPanel(p) {
  if (p.kiteAnswerSubmitted) return `<section class="card mission-card success"><h2>風箏任務答案</h2><p>✅ 你已提交答案。答案只會由工作人員接收。</p></section>`;
  return `<section class="card mission-card"><h2>風箏任務答案回報</h2><p>請輸入答案。其他參加者及 Hunter 不會看到你的答案。</p><textarea id="kite-answer" rows="3" placeholder="輸入答案">${escapeHtml(kiteAnswerDraft)}</textarea><button class="primary big" id="submit-kite-answer">提交答案</button></section>`;
}

function remainingPlayersPanel() {
  const alive = values(state.participants).filter((p) => p.status !== "dead");
  return `<section class="card"><h2>尚餘玩家 <span class="count">${alive.length}</span></h2><div class="player-grid">${alive.map((p) => `<span>${escapeHtml(p.name)}</span>`).join("") || "<p>暫無玩家</p>"}</div></section>`;
}

function hunterPage() {
  const hunter = state.hunters?.[role.id];
  if (!hunter) return `<main class="app"><section class="card"><h1>身份已失效</h1><p>請重新登入 Hunter。</p><button id="logout">重新登入</button></section></main>`;
  const alive = values(state.participants).filter((p) => p.status !== "dead");
  return `<main class="app hunter-app">
    ${topBar("Hunter", role.name)}
    <section class="card hunter-card"><h1>Hunter 控制台</h1><p>狀態：${labels.hunterStatus[hunter.status] || hunter.status}｜已捉到 ${hunter.caughtCount || 0} 人</p><p class="safety">只可輕拍肩膀或手臂；不可推撞、拉扯、阻擋；不可在馬路、樓梯、濕滑位置高速追捕；不可守死復活區、一番賞商店或拍照點。</p></section>
    ${publicMessageHtml()}
    ${hunterGpsPanel()}
    <section class="card"><h2>可追捕參加者 <span class="count">${alive.length}</span></h2><div class="hunter-list">${alive.map((p) => `<div class="list-row"><div><strong>${escapeHtml(p.name)}</strong><span>${p.isGPS ? "GPS 目標" : "存活"}</span></div><button class="danger catch-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}">確認捉到</button></div>`).join("") || "<p>暫無存活參加者</p>"}</div></section>
  </main>`;
}

function hunterGpsPanel() {
  const targets = values(state.participants).filter((p) => p.status !== "dead" && p.isGPS);
  return `<section class="card gps-card"><h2>GPS 目標</h2>${targets.length ? targets.map(gpsTargetHtml).join("") : "<p>暫無 GPS 目標。</p>"}</section>`;
}

function gpsTargetHtml(p) {
  if (p.gpsMode === "real") {
    const gps = p.gpsPublic;
    if (!gps) return `<div class="gps-target"><strong>${escapeHtml(p.name)}</strong><p>等待參加者開啟 GPS 定位。</p></div>`;
    const age = Math.floor((Date.now() - (gps.updatedAtMs || 0)) / 1000);
    const stale = age > 45;
    return `<div class="gps-target ${stale ? "stale" : ""}"><strong>${escapeHtml(p.name)}</strong><p>約略位置｜${stale ? "位置可能已過時" : `${age} 秒前更新`}｜約 ±${gps.accuracy}m</p><a class="map-link" href="${gps.mapUrl}" target="_blank" rel="noopener">開啟地圖</a></div>`;
  }
  return `<div class="gps-target"><strong>${escapeHtml(p.name)}</strong><p>${escapeHtml(p.gpsLocation || "位置待更新")}</p></div>`;
}

function staffPage() {
  return `<main class="app staff-app">
    <header class="topbar staff-top"><div><strong>工作人員總控</strong><span>剩餘 <b data-countdown>${formatCountdown()}</b>｜第 <b data-minute>${currentMinuteText()}</b> 分鐘</span><small id="staff-update-badge">${pendingStaffUpdate ? "有新同步，按更新畫面" : "畫面已更新"}</small></div><div class="top-actions"><button id="staff-refresh">更新畫面</button><button id="enable-sound">${soundEnabled ? "提示聲已開" : "開提示聲"}</button><button id="logout">登出</button></div></header>
    ${toast ? `<div class="toast">${escapeHtml(toast)}</div>` : ""}
    <nav class="tabs">${[
      ["dashboard", "總控"], ["publish", "發布"], ["participants", "參加者"], ["hunters", "Hunter"], ["gps", "GPS"], ["kite", "風箏答案"], ["ichiban", "一番賞"], ["photo", "影相"], ["revive", "復活"], ["logs", "紀錄"]
    ].map(([id, text]) => `<button class="tab ${staffTab === id ? "active" : ""}" data-staff-tab="${id}">${text}</button>`).join("")}</nav>
    ${staffTabContent()}
  </main>`;
}

function staffTabContent() {
  if (staffTab === "publish") return publishTab();
  if (staffTab === "participants") return participantsTab();
  if (staffTab === "hunters") return huntersTab();
  if (staffTab === "gps") return gpsTab();
  if (staffTab === "kite") return kiteTab();
  if (staffTab === "ichiban") return ichibanTab();
  if (staffTab === "photo") return photoTab();
  if (staffTab === "revive") return reviveTab();
  if (staffTab === "logs") return logsTab();
  return dashboardTab();
}

function dashboardTab() {
  return `<section class="card"><h2>活動時間控制</h2><div class="button-grid"><button class="primary" id="game-start">開始活動</button><button id="game-pause">暫停</button><button id="game-resume">繼續</button><button class="danger" id="game-reset">重置</button></div><div class="inline-form"><input id="jump-minute" type="number" min="0" max="120" placeholder="分鐘"><button id="game-jump">跳到分鐘</button></div><p>目前任務：${activeMissionNames().map(escapeHtml).join("、") || "未有"}</p></section>
  ${publicMessageHtml()}
  <section class="card"><h2>快速狀態</h2><p>參加者：${values(state.participants).length}｜存活：${values(state.participants).filter((p) => p.status !== "dead").length}｜死亡：${values(state.participants).filter((p) => p.status === "dead").length}</p><p>Hunter 數量設定：${state.gameState.hunterCount || 0}｜已登入 Hunter：${values(state.hunters).length}</p><p>一番賞商店：<strong>劇場</strong>｜二人影相：<strong>火車前草地搵工作人員</strong></p></section>`;
}

function publishTab() {
  return `<section class="card"><h2>發布訊息給所有參加者</h2><p>先選任務範本，再按需要改字，最後發布。</p><div class="template-grid">${(state.missionTemplates || []).map((t) => `<button class="template-btn" data-template-id="${t.id}">${escapeHtml(t.title)}</button>`).join("")}</div><label>標題</label><input id="publish-title" value="${escapeHtml(publishTitle)}" placeholder="訊息標題"><label>內容</label><textarea id="publish-body" rows="5" placeholder="發布內容">${escapeHtml(publishBody)}</textarea><label>類型</label><select id="publish-level"><option value="info" ${publishLevel === "info" ? "selected" : ""}>一般</option><option value="mission" ${publishLevel === "mission" ? "selected" : ""}>任務</option><option value="warning" ${publishLevel === "warning" ? "selected" : ""}>警告</option><option value="danger" ${publishLevel === "danger" ? "selected" : ""}>緊急</option></select><button class="primary big" id="publish-now">立即發布</button></section>
  <section class="card"><h2>任務手動開關</h2><div class="mission-toggle-list">${state.missions.map((m) => `<div class="list-row"><div><strong>${escapeHtml(m.name)}</strong><span>${m.startMinute}-${m.endMinute} 分鐘｜${m.isManuallyOverridden ? (m.manualActive ? "手動開啟" : "手動關閉") : "按時間"}</span></div><button class="mission-open" data-id="${m.id}">開</button><button class="mission-close" data-id="${m.id}">關</button><button class="mission-auto" data-id="${m.id}">自動</button></div>`).join("")}</div></section>`;
}

function participantsTab() {
  return `<section class="card"><h2>參加者總覽</h2><div class="table-list">${values(state.participants).map((p) => `<div class="list-row participant-row"><div><strong>${escapeHtml(p.name)}</strong><span>${statusBadge(p.status)}｜影相 ${p.photoCompleted ? "完成" : "未"}｜一番賞 ${p.hasPlayedIchiban ? "已玩" : "未玩"}｜GPS ${p.isGPS ? "ON" : "OFF"}</span></div><div class="mini-actions"><button class="set-status" data-id="${p.id}" data-status="alive">存活</button><button class="set-status" data-id="${p.id}" data-status="dead">死亡</button><button class="set-status" data-id="${p.id}" data-status="revived">復活</button></div></div>`).join("") || "<p>暫無參加者</p>"}</div></section>`;
}

function huntersTab() {
  return `<section class="card"><h2>Hunter 總覽</h2><div class="button-row"><button id="hunter-count-plus">+1 Hunter</button><button id="hunter-count-minus">-1 Hunter</button></div><p>場上 Hunter 數量設定：${state.gameState.hunterCount || 0}</p><div class="table-list">${values(state.hunters).map((h) => `<div class="list-row"><div><strong>${escapeHtml(h.name)}</strong><span>${labels.hunterStatus[h.status]}｜捉到 ${h.caughtCount || 0} 人</span></div><div class="mini-actions"><button class="hunter-status" data-id="${h.id}" data-status="active">出場</button><button class="hunter-status" data-id="${h.id}" data-status="paused">暫停</button><button class="hunter-status" data-id="${h.id}" data-status="removed">移除</button></div></div>`).join("") || "<p>暫無 Hunter 登入</p>"}</div></section>`;
}

function gpsTab() {
  return `<section class="card"><h2>GPS 管理</h2><label>參加者</label><select id="gps-participant">${participantOptions()}</select><label>手動大概位置</label><select id="gps-location">${manualGpsLocations.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("")}</select><div class="button-grid"><button class="warning" id="gps-enable-real">啟用真實 GPS</button><button id="gps-update-manual">更新手動位置</button><button class="danger" id="gps-cancel">取消 GPS</button></div></section><section class="card"><h2>目前 GPS 目標</h2>${values(state.participants).filter((p) => p.isGPS).map(gpsTargetStaffHtml).join("") || "<p>暫無 GPS 目標。</p>"}</section>`;
}

function gpsTargetStaffHtml(p) {
  return `<div class="gps-target"><strong>${escapeHtml(p.name)}</strong><p>模式：${p.gpsMode === "real" ? "真實 GPS" : "手動文字"}</p>${gpsTargetHtml(p)}</div>`;
}

function kiteTab() {
  const answers = values(state.kiteAnswers).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return `<section class="card"><h2>風箏答案回報</h2><p>答案只會在工作人員頁顯示，不會發放給 Hunter 或其他參加者。</p>${answers.length ? answers.map((a) => `<div class="answer-card"><div><strong>${escapeHtml(a.participantName)}</strong><span>${labels.kiteStatus[a.status] || a.status}｜${new Date(a.createdAt).toLocaleTimeString("zh-HK")}</span></div><p>${escapeHtml(a.answer)}</p><div class="button-row"><button class="kite-mark" data-id="${a.participantId}" data-status="correct">正確</button><button class="kite-mark" data-id="${a.participantId}" data-status="wrong">不正確</button><button class="kite-mark" data-id="${a.participantId}" data-status="pending">待處理</button><button class="danger kite-clear" data-id="${a.participantId}">清除重交</button></div></div>`).join("") : "<p>暫未收到答案。</p>"}</section>`;
}

function ichibanTab() {
  return `<section class="card"><h2>一番賞管理</h2><p>商店位置：<strong>劇場</strong>。現場抽籤，App 只記錄結果，不扣實體籌碼。</p><label>參加者</label><select id="ichiban-participant">${participantOptions()}</select><label>現場抽到結果</label><select id="ichiban-result">${(state.ichibanResults || []).map((r) => `<option value="${r.id}">${escapeHtml(r.label)}｜${escapeHtml(r.detail)}</option>`).join("")}</select><label>如抽中 +1 GPS，指定目標</label><select id="ichiban-gps-target">${participantOptions()}</select><div class="button-grid"><button class="primary" id="ichiban-record">記錄並發布結果</button><button id="ichiban-reset">重設所選參加者一番賞狀態</button></div></section>`;
}

function photoTab() {
  const incomplete = values(state.participants).filter((p) => !p.photoCompleted);
  return `<section class="card"><h2>二人影相管理</h2><p>位置：<strong>火車前草地</strong>，參加者需兩人一組搵工作人員影相。</p><div class="table-list">${values(state.participants).map((p) => `<div class="list-row"><div><strong>${escapeHtml(p.name)}</strong><span>${p.photoCompleted ? "已完成" : "未完成"}</span></div><button class="photo-complete" data-id="${p.id}" data-completed="${p.photoCompleted ? "0" : "1"}">${p.photoCompleted ? "取消完成" : "標記完成"}</button></div>`).join("") || "<p>暫無參加者</p>"}</div><button class="danger big" id="photo-kill-incomplete">一鍵將未完成者設為死亡（${incomplete.length} 人）</button></section>`;
}

function reviveTab() {
  const dead = values(state.participants).filter((p) => p.status === "dead");
  return `<section class="card"><h2>復活管理</h2><p>實體籌碼及挑戰次數以現場紀錄為準。復活成功會自動發布全場訊息。</p><label>死亡參加者</label><select id="revive-participant">${deadParticipantOptions()}</select><div class="button-grid"><button class="primary" id="revive-success">成功復活</button><button id="revive-fail">挑戰失敗／維持死亡</button></div><h3>死亡名單</h3><div class="player-grid">${dead.map((p) => `<span>${escapeHtml(p.name)}</span>`).join("") || "<p>暫無死亡參加者</p>"}</div></section>`;
}

function logsTab() {
  return `<section class="card"><h2>活動紀錄</h2><div class="button-row"><button id="copy-logs">複製文字紀錄</button><button id="download-csv">下載 CSV</button></div><div class="log-list">${(state.eventLogs || []).slice(0, 120).map((log) => `<div><strong>${log.minute} 分鐘｜${escapeHtml(log.type)}</strong><p>${escapeHtml(log.detail)}</p><small>${new Date(log.createdAt).toLocaleString("zh-HK")}</small></div>`).join("") || "<p>暫無紀錄</p>"}</div></section>`;
}

function startGps() {
  const p = state?.participants?.[role?.id];
  if (!p?.isGPS || p.gpsMode !== "real") {
    toast = "你目前不是 GPS 目標";
    render(true);
    return;
  }
  if (!navigator.geolocation) {
    toast = "此手機不支援 GPS 定位";
    render(true);
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => sendGpsPosition(pos), gpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 });
  gpsWatchId = navigator.geolocation.watchPosition(sendGpsPosition, gpsError, { enableHighAccuracy: true, maximumAge: 8000, timeout: 15000 });
  requestWakeLock();
  toast = "GPS 定位已開始，請保持畫面開啟";
  render(true);
}

function sendGpsPosition(pos) {
  send("participant:gpsUpdate", { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
  const el = document.getElementById("gps-local-status");
  if (el) el.textContent = `剛更新 GPS｜約 ±${Math.round(pos.coords.accuracy)}m`;
}

function gpsError(err) {
  toast = `GPS 失敗：${err.message || "請檢查定位權限"}`;
  render(true);
}

function stopGps() {
  if (gpsWatchId !== null) navigator.geolocation?.clearWatch(gpsWatchId);
  gpsWatchId = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {}
}

document.addEventListener("input", (event) => {
  if (event.target.id === "entry-name") entryName = event.target.value;
  if (event.target.id === "entry-password") entryPassword = event.target.value;
  if (event.target.id === "publish-title") publishTitle = event.target.value;
  if (event.target.id === "publish-body") publishBody = event.target.value;
  if (event.target.id === "publish-level") publishLevel = event.target.value;
  if (event.target.id === "kite-answer") kiteAnswerDraft = event.target.value;
});

document.addEventListener("change", (event) => {
  if (event.target.id === "publish-level") publishLevel = event.target.value;
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.roleMode) { roleMode = target.dataset.roleMode; entryPassword = ""; render(true); return; }
  if (target.id === "logout") { logout(); return; }
  if (target.id === "enable-sound") { enableSound(); return; }
  if (target.id === "join-participant") { send("join:participant", { name: entryName }); return; }
  if (target.id === "join-hunter") { send("join:hunter", { name: entryName, password: entryPassword }); return; }
  if (target.id === "auth-staff") { send("auth:staff", { password: entryPassword }); return; }
  if (target.id === "start-gps") { startGps(); return; }
  if (target.id === "stop-gps") { stopGps(); toast = "已停止本機 GPS；工作人員仍可取消你的 GPS 狀態"; render(true); return; }
  if (target.id === "submit-kite-answer") { send("kite:submit", { answer: kiteAnswerDraft }); kiteAnswerDraft = ""; return; }
  if (target.classList.contains("catch-btn")) { confirmSend(`確認捉到 ${target.dataset.name}？`, "hunter:catch", { participantId: target.dataset.id }); return; }

  if (target.id === "staff-refresh") { pendingStaffUpdate = false; render(true); return; }
  if (target.dataset.staffTab) { staffTab = target.dataset.staffTab; pendingStaffUpdate = false; render(true); return; }
  if (target.id === "game-start") { send("game:start"); return; }
  if (target.id === "game-pause") { send("game:pause"); return; }
  if (target.id === "game-resume") { send("game:resume"); return; }
  if (target.id === "game-reset") { confirmSend("確認重置整個活動？所有資料會清空。", "game:reset"); return; }
  if (target.id === "game-jump") { send("game:jump", { minute: Number(document.getElementById("jump-minute")?.value || 0) }); return; }

  if (target.classList.contains("template-btn")) {
    const t = (state.missionTemplates || []).find((x) => x.id === target.dataset.templateId);
    if (t) { publishTitle = t.title; publishBody = t.body; publishLevel = t.level; render(true); }
    return;
  }
  if (target.id === "publish-now") {
    publishTitle = document.getElementById("publish-title")?.value || publishTitle;
    publishBody = document.getElementById("publish-body")?.value || publishBody;
    publishLevel = document.getElementById("publish-level")?.value || publishLevel;
    send("message:publish", { title: publishTitle, body: publishBody, level: publishLevel });
    return;
  }
  if (target.classList.contains("mission-open")) { send("mission:override", { missionId: target.dataset.id, override: true, active: true }); return; }
  if (target.classList.contains("mission-close")) { send("mission:override", { missionId: target.dataset.id, override: true, active: false }); return; }
  if (target.classList.contains("mission-auto")) { send("mission:override", { missionId: target.dataset.id, override: false, active: false }); return; }

  if (target.classList.contains("set-status")) { confirmSend("確認更改參加者狀態？", "staff:participantStatus", { participantId: target.dataset.id, status: target.dataset.status }); return; }
  if (target.classList.contains("hunter-status")) { send("staff:hunterStatus", { hunterId: target.dataset.id, status: target.dataset.status }); return; }
  if (target.id === "hunter-count-plus") { send("staff:hunterCount", { delta: 1 }); return; }
  if (target.id === "hunter-count-minus") { send("staff:hunterCount", { delta: -1 }); return; }

  if (target.id === "gps-enable-real") { send("staff:gpsEnable", { participantId: document.getElementById("gps-participant")?.value, mode: "real" }); return; }
  if (target.id === "gps-update-manual") { send("staff:gpsUpdateManual", { participantId: document.getElementById("gps-participant")?.value, location: document.getElementById("gps-location")?.value }); return; }
  if (target.id === "gps-cancel") { send("staff:gpsCancel", { participantId: document.getElementById("gps-participant")?.value }); return; }

  if (target.classList.contains("kite-mark")) { send("kite:mark", { participantId: target.dataset.id, status: target.dataset.status }); return; }
  if (target.classList.contains("kite-clear")) { confirmSend("確認清除此答案，讓參加者重新提交？", "kite:clear", { participantId: target.dataset.id }); return; }

  if (target.id === "ichiban-record") { send("ichiban:record", { participantId: document.getElementById("ichiban-participant")?.value, resultId: document.getElementById("ichiban-result")?.value, gpsTargetId: document.getElementById("ichiban-gps-target")?.value }); return; }
  if (target.id === "ichiban-reset") { send("ichiban:resetPlayed", { participantId: document.getElementById("ichiban-participant")?.value }); return; }

  if (target.classList.contains("photo-complete")) { send("staff:photoComplete", { participantId: target.dataset.id, completed: target.dataset.completed === "1" }); return; }
  if (target.id === "photo-kill-incomplete") { confirmSend("確認將所有未完成二人影相者設為死亡？", "staff:killPhotoIncomplete"); return; }

  if (target.id === "revive-success") { send("revive:success", { participantId: document.getElementById("revive-participant")?.value }); return; }
  if (target.id === "revive-fail") { send("revive:fail", { participantId: document.getElementById("revive-participant")?.value }); return; }

  if (target.id === "copy-logs") { navigator.clipboard?.writeText((state.eventLogs || []).map((l) => `${l.createdAt}\t${l.minute}\t${l.type}\t${l.detail}`).join("\n")); toast = "已複製紀錄"; render(true); return; }
  if (target.id === "download-csv") { downloadCsv(); return; }
});

function downloadCsv() {
  const rows = [["createdAt", "minute", "type", "detail", "participantId", "hunterId"], ...(state.eventLogs || []).map((l) => [l.createdAt, l.minute, l.type, l.detail, l.participantId, l.hunterId])];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tai-po-runaway-logs-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

setInterval(updateTimers, 1000);
connect();
render(true);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/public/service-worker.js").catch(() => {}));
}
