# 大埔逃走中 Web App Prototype v1.4

手機優先的戶外活動即時同步 Web App。前端使用原生 HTML/CSS/JavaScript，後端使用 Node.js + WebSocket，支援 PWA 加到手機主畫面。

## 今版新增

- 尋找籌碼任務加入 7 個實體位置提示及相片
- 一番賞商店位置更新為「劇場」
- 一番賞結果新增「發回 2 個實體籌碼」
- 二人影相位置更新為「火車前草地，搵工作人員」
- 風箏任務可讓參加者提交答案，只有工作人員收到
- Hunter 需要密碼登入，預設為 `123456`
- 工作人員登入畫面不顯示預設密碼
- 真實 GPS 模式保留：只分享模糊化後約略位置，不保存原始精準座標

## 角色入口

- 參加者：輸入姓名即可進入
- Hunter：輸入名稱及 Hunter 密碼，預設 `123456`
- 工作人員：輸入工作人員密碼；建議在 Render Environment Variables 設定 `STAFF_PASSWORD`

## 本地運行

```bash
npm run dev
```

開啟：

```text
http://localhost:8787
```

## Render 設定

Build Command:

```bash
npm run build
```

Start Command:

```bash
npm start
```

Environment Variables 建議：

```text
STAFF_PASSWORD=你的工作人員密碼
HUNTER_PASSWORD=123456
```

## 活動重點設定

- 籌碼以實體紀錄為準，App 只顯示位置提示及任務資訊
- 一番賞現場抽，App 只記錄及發布結果
- 一番賞商店：劇場
- 二人影相：火車前草地，搵工作人員
- 二人影相 87 分鐘前未完成者可由工作人員一鍵設為死亡
- 復活成功後會自動發布全場通知
- 參加者死亡時會顯示全屏紅色提示，直至工作人員復活

## 尋找籌碼位置

1. 雲南黃素馨植物牌
2. 海濱導覽圖附近
3. 救生圈位置
4. 白色方形牆洞
5. 黃色雀鳥雕塑
6. 46 號黑色柱
7. 榕樹樹牌

## PWA 安裝

- iPhone：Safari 開網址 → 分享 → 加入主畫面
- Android：Chrome 開網址 → Install app / Add to Home screen

如已安裝舊版，更新後請完全關閉 Web App 再重新開啟；必要時刪除主畫面捷徑後重新加入。

## 注意事項

- Render Free 可能因閒置而休眠；活動前請提前開啟網址測試
- 目前資料存於 server memory，server 重啟會重置活動狀態
- 真實 GPS 需要參加者自行允許定位，手機鎖屏或轉 App 可能停止更新


## v1.4 no-assets 版本

此版本已將 7 張尋找籌碼位置相片內嵌於 `public/app.js`，不用再上載 `public/assets` folder。上載 GitHub 時只需覆蓋根目錄檔案及 `public` 入面的檔案即可。
