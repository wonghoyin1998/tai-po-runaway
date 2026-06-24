# 大埔逃走中 Web App Prototype

手機優先的戶外活動即時同步 prototype。前端使用原生 HTML/CSS/JavaScript，後端使用 Node.js + WebSocket。所有角色共用同一個 server state，`localStorage` 只用作暫存角色、姓名和登入狀態。

## 功能

- 角色入口：參加者、Hunter、工作人員／總控
- 即時同步：所有資料經 WebSocket broadcast，其他手機通常 1-3 秒內更新
- 連線提示：斷線時顯示「連線中斷／重新連線中」，重連後自動取得最新狀態
- 活動時間：以 server 開始時間為準，支援開始、暫停、繼續、重置、跳到指定分鐘
- 參加者：只顯示活動倒數、目前分鐘、工作人員發布訊息、尚餘玩家及必要 GPS 提示
- 真實 GPS：被指定的參加者可用手機 Geolocation 更新約略位置；亦保留手動大概位置作後備
- Hunter：查看存活名單、GPS 目標、最後更新時間及約略地圖，並回報捉到某位參加者；回報後會即時發布給全場並更新死亡狀態
- 工作人員：管理活動、發布訊息、查看 Hunter 捉人紀錄、管理參加者、Hunter、籌碼、GPS、一番賞、二人影相、復活及事件紀錄
- 一番賞與籌碼：現場以實體抽籤／實體籌碼處理，App 只記錄結果及發布通知
- 匯出紀錄：CSV 下載或複製文字紀錄

## 本地運行

```bash
npm run dev
```

開啟：

- Web App：`http://localhost:8787`
- WebSocket server：`ws://localhost:8787`
- 健康檢查：`http://localhost:8787/health`

如要讓多部手機測試，請讓手機與電腦連同一個 Wi-Fi，然後用電腦的區域網 IP 開啟：

```text
http://你的電腦IP:8787
```

工作人員密碼預設為：

```text
staff123
```

可用環境變數更改：

```bash
STAFF_PASSWORD=你的密碼 npm run dev
```

## 安裝到手機主畫面

部署到 HTTPS 網址後，例如 Render 的 `onrender.com` 網址，可以當成 Web App 使用。

iPhone / iPad：

1. 用 Safari 開啟活動網址。
2. 按分享按鈕。
3. 選擇 `加入主畫面`。
4. 名稱可用 `大埔逃走中`。

Android：

1. 用 Chrome 開啟活動網址。
2. 按右上角選單。
3. 選擇 `Install app` 或 `Add to Home screen`。

提示聲需每部手機先按一次 `開提示聲`，瀏覽器才允許播放通知聲。

## 真實 GPS 使用方法

1. 工作人員進入 `GPS` 分頁。
2. 選擇參加者。
3. 定位模式選擇 `真實 GPS（建議）`，再按 `啟用／更新 GPS`。
4. 該參加者畫面會出現橙色 GPS 提示。
5. 參加者按 `開始 GPS 定位`，並在手機權限提示中選擇允許位置。
6. Hunter 和工作人員會看到模糊化後的約略位置、誤差、最後更新時間及 OpenStreetMap 地圖連結。
7. 工作人員按 `取消 GPS` 後，參加者手機會停止回報位置。

GPS 注意事項：

- 必須使用 HTTPS；Render 的 `onrender.com` 網址已符合要求。
- 參加者必須保持 Web App 在前景及盡量不要鎖屏。iPhone／Android 瀏覽器在背景可能暫停 GPS。
- App 約每 10 秒回報一次；server 限制最密約每 7 秒接受一次。
- server 收到座標後立即以約 40–60 米網格模糊化，只保存及發布模糊座標。
- Hunter 看到的是約略範圍，不應以地圖標記作精確捉人判定。
- 如位置超過 60 秒未更新，Hunter／工作人員會看到「位置已過時」。
- 如參加者拒絕權限或手機無法定位，可切換成 `手動大概位置（後備）`。

## Production build

```bash
npm run build
NODE_ENV=production npm start
```

然後開啟：

```text
http://localhost:8787
```

## Render / Railway / Fly.io 部署概念

這個 prototype 是零外部 npm dependency，只需要一個 Node process：

- Build command：`npm run build`
- Start command：`NODE_ENV=production npm start`
- Port：使用平台提供的 `PORT` 環境變數
- Optional env：`STAFF_PASSWORD`

前端 production 會由同一個 Node server serve `dist`，WebSocket 也在同一個 host 上。

## Render 部署步驟

1. 將整個專案上載到 GitHub repository。
2. 登入 Render。
3. 按 `New`，選擇 `Web Service`。
4. 連接你的 GitHub repository。
5. 設定如下：

```text
Name: tai-po-runaway
Runtime: Node
Build Command: npm run build
Start Command: npm start
```

6. Environment Variables 可加：

```text
STAFF_PASSWORD=你的工作人員密碼
```

7. 按 `Deploy Web Service`。
8. 部署完成後，Render 會提供一條 `onrender.com` 網址，所有參加者、Hunter、工作人員用手機 4G/5G 開同一條網址即可。

專案已包含 `render.yaml`，如 Render 偵測到 blueprint，也可以用 Blueprint 方式部署。

## 資料庫／即時同步設定

Prototype 版本使用 WebSocket server 作為主要資料來源：

- 所有資料存在 server memory
- 所有寫入操作都經 `server.js` 的 action handler
- 寫入後即時 `broadcast()` 給所有已連線裝置
- 每 2 秒會 broadcast 活動時間 tick
- 事件紀錄存在 `eventLogs`

這符合「不可只用 localStorage 作主要資料來源」的要求；但 server 重啟後資料會重置。正式活動如要保留資料，可把 `state` 換成以下其中一種：

1. Firebase Firestore
   - `participants`
   - `hunters`
   - `gameState/main`
   - `missions`
   - `eventLogs`
2. Supabase Postgres + Realtime
   - `participants`
   - `hunters`
   - `game_state`
   - `missions`
   - `event_logs`
3. WebSocket + Redis / Postgres
   - WebSocket 負責 broadcast
   - Redis / Postgres 負責持久化

現有資料結構已按以下形狀設計，方便之後搬去 Firestore 或 Supabase：

```js
participants: {
  id,
  name,
  status: "alive" | "dead" | "revived",
  chips,
  hasPlayedIchiban,
  photoCompleted,
  isGPS,
  gpsMode: "live" | "manual",
  gpsLocation,
  gpsLatitude,
  gpsLongitude,
  gpsAccuracy,
  gpsUpdatedAt,
  gpsTrackingStatus,
  reviveCount,
  caughtBy,
  reviveRequested,
  createdAt,
  lastUpdated
}

hunters: {
  id,
  name,
  status: "active" | "paused" | "removed",
  caughtCount,
  createdAt,
  lastUpdated
}

gameState: {
  isStarted,
  isPaused,
  lastStartedAtMs,
  accumulatedMs,
  currentMinute,
  activeMissions,
  hunterCount,
  lastUpdated
}

missions: {
  id,
  name,
  startMinute,
  endMinute,
  isActive,
  isManuallyOverridden,
  manualActive
}

eventLogs: {
  id,
  minute,
  type,
  participantId,
  hunterId,
  detail,
  createdAt
}
```

## 重要同步邏輯

- 活動時間由 server 的 `Date.now()` 計算，不用手機本地時間作準
- Hunter 捉人會建立 `catchReports` 紀錄、即時更新 `participant.status = "dead"`，並發布訊息給所有參加者
- 工作人員可用總控頁「發布訊息給所有參加者」，參加者頁會即時顯示
- 參加者復活後會自動發布復活訊息給所有參加者
- 工作人員復活會更新參加者狀態並清走復活申請
- 一番賞不再由 App 抽籤或扣籌碼；工作人員只記錄現場抽出的結果
- 籌碼以現場實體紀錄為準；Flip 復活不再由 App 檢查或扣除籌碼
- GPS 啟用／取消／真實約略位置／手動位置會即時顯示在 Hunter、工作人員和相關參加者頁面
- 87 分鐘後二人影相頁會提示工作人員處理未完成者
- 重要按鈕全部使用 `window.confirm()` 做二次確認

## 原型限制

- 真實 GPS 依賴手機瀏覽器；鎖屏或切換 App 後不能保證持續更新
- 地圖使用 OpenStreetMap 外部連結，不是內置導航
- 目前沒有帳號系統，工作人員只用簡單密碼
- 目前資料存在 memory，server 重啟會重置
- 如部署到多個 Node instances，需要 Redis pub/sub 或資料庫 realtime 來同步不同 instance
