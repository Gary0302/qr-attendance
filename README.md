# QR Code 點名與加分系統

**正式網址**

| 用途 | 網址 |
| --- | --- |
| 學生簽到頁 | <https://qr-attendance-pied.vercel.app/> |
| 教師 QR 產生器 | <https://qr-attendance-pied.vercel.app/qr> |
| 原始碼 | <https://github.com/Gary0302/qr-attendance> |

推到 GitHub `main` 會自動重新部署。

用一張投影在螢幕上的 QR Code，讓全班同學用自己的手機完成點名與加分登記，
資料直接寫進 Google 試算表。實作依據 [`spec.md`](spec.md)。

```
學生手機  ──掃 QR──▶  前端網頁 (Vercel / GitHub Pages)
                          │  POST JSON
                          ▼
                    Google Apps Script Web App
                          │  讀寫
                          ▼
                     Google 試算表（名冊 / 紀錄）
```

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 學生簽到頁，以 `?mode=` 切換模式 |
| `qr.html` | 教師用 QR Code 產生器，附全螢幕投影模式 |
| `config.js` | **唯一需要修改的設定檔**（API 網址、課程名稱） |
| `apps-script/Code.gs` | 後端 API，貼到 Apps Script 編輯器 |
| `vercel.json` | Vercel 靜態託管設定 |

---

## 安裝步驟

### 1. 建立試算表與後端

1. 新建一份 Google 試算表，命名隨意。
2. 上方選單 **擴充功能 → Apps Script**。
3. 把 `apps-script/Code.gs` 的內容整份貼進 `Code.gs`，覆蓋原本的範例程式。
4. 存檔後，在編輯器上方函式選單選 **`setupSheets`** 並按執行，
   第一次會跳出授權視窗，同意即可。執行完試算表會多出「名冊」與「紀錄」兩張工作表。
5. 右上角 **部署 → 新增部署作業 → 類型選「網頁應用程式」**：
   - 執行身分：**我**
   - 誰可以存取：**所有人**（必須選這個，學生才不用登入 Google）
6. 複製取得的網址（結尾是 `/exec`）。

> 之後每次修改 `Code.gs`，都要重新 **部署 → 管理部署作業 → 編輯 → 版本選「新版本」**，
> 否則線上跑的還是舊程式。

### 2. 匯入學生名單

專案內的 `name.txt`（學務系統匯出的名單）會被轉成 `roster.csv`：

```bash
python3 tools/make-roster.py     # name.txt → roster.csv
```

在 Google 試算表：**檔案 → 匯入 → 上傳 → 選 roster.csv**，
匯入位置選「**取代目前工作表**」，分隔符號選「逗號」。
匯入後回到 Apps Script 執行一次 `setupSheets()`，補上格式與凍結首列。

> `name.txt` 與 `roster.csv` 含學生姓名與電子信箱，已被 `.gitignore` 與 `.vercelignore`
> 排除，不會進版控、也不會部署到公開網站。**請勿手動加回去。**

### 3. 設定前端

編輯 `config.js`：

```js
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycb...../exec',
  SITE_URL: '',            // 部署後填正式網址，或留空自動偵測
  COURSE_NAME: '資訊概論 星期三第三節',
};
```

### 4. 部署前端

這是純靜態網站，沒有建置步驟。

已部署在 Vercel 並連上 GitHub repo，`git push` 到 `main` 就會自動上線。
要手動部署：`vercel deploy --prod --yes`

注意 `vercel.json` 開了 `cleanUrls`，所以教師頁的網址是 `/qr` 而不是 `/qr.html`。
`apps-script/`、`spec.md`、`README.md` 已由 `.vercelignore` 排除，不會被部署。

### 5. 產生 QR Code

打開 `https://你的網址/qr.html`，選模式 → 按「投影全螢幕」→ 投影給全班掃。

---

## 三種模式

| 網址 | 行為 |
| --- | --- |
| `?mode=attendance` | 寫入 C 欄「出席時間」為伺服器當下時間 |
| `?mode=classBonus` | D 欄「課堂加分」累加 |
| `?mode=lectureBonus` | E 欄「講座加分」累加 |

沒帶 `mode` 參數時預設為 `attendance`。

### 選用參數

| 參數 | 說明 |
| --- | --- |
| `session` | 場次代碼，例如 `session=0911-3`。帶了就會擋掉同一人在同一場次的重複加分。 |
| `points` | 這次加幾分，預設 1，後端上限 10（防止有人改網址狂加分）。 |
| `token` | 通行碼，需與 `Code.gs` 的 `CONFIG.TOKEN` 相同。 |

範例：`https://你的網址/?mode=classBonus&session=0911-3&points=2`

---

## 資料表欄位

「名冊」工作表共 9 欄：A~F 直接來自學務系統名單，G~I 由本系統寫入。

| 欄 | 名稱 | 來源 | 說明 |
| --- | --- | --- | --- |
| A | 序號 | 名單 | |
| B | 學號 | 名單 | **查詢鍵**，文字格式，開頭的 0 不會被吃掉 |
| C | 姓名 | 名單 | 以名冊為準，學生打錯不會覆寫 |
| D | 年級 | 名單 | |
| E | 電子信箱 | 名單 | |
| F | 選上否 | 名單 | 自動新增的非名單學生會標記「未在名單」 |
| G | 出席時間 | 系統 | 真正的日期值，顯示格式 `YYYY-MM-DD HH:mm:ss` |
| H | 課堂加分 | 系統 | 整數，累加 |
| I | 講座加分 | 系統 | 整數，累加 |

「紀錄」工作表逐筆記下每次送出（時間、模式、學號、送出的姓名、名冊上的姓名、場次、分數、結果）。
學生輸入的姓名和名冊不同時會標記「姓名不符」，方便事後核對代簽或打錯字。

### 只允許名單上的學生簽到

`Code.gs` 的 `CONFIG.ROSTER_ONLY` 預設為 `false`（不在名單者自動新增並標記）。
改成 `true` 之後，查無學號會直接擋下，適合不想讓旁聽生混入的情況。

---

## 實作上的幾個決定

- **CORS**：Apps Script 無法回應 `OPTIONS` preflight，所以前端用
  `Content-Type: text/plain` 送 JSON 字串，讓它符合 CORS「簡單請求」的條件。
  後端 `parseRequest()` 會自行解析 body。
- **並行寫入**：全班同時掃碼會有數十個請求同時讀寫同一格。後端用
  `LockService` 序列化處理，避免兩個請求同時讀到舊分數而互相覆蓋。
- **姓名以先到者為準**：後來送出的不同姓名不會覆寫名冊，只會記在「紀錄」表，
  避免有人打錯字或惡意改掉別人的姓名。
- **時間由伺服器決定**：不採用瀏覽器時間，學生改手機時鐘沒有用。

## 已知限制

- **API 是公開的**。任何拿到網址的人都能送資料，`token` 只是速度障礙而非安全機制
  （QR Code 本身就看得到）。要嚴格防範請每堂課換 `session`，並用「紀錄」工作表事後稽核。
- **無法偵測代簽**。系統只能確認「有人用這組學號送出」，無法確認人在教室。
  常見做法是把 QR Code 只投影 1～2 分鐘，並搭配 `session` 去重。
- **個資**：`name.txt` / `roster.csv` 含 33 位學生的姓名與電子信箱，已排除於版控與部署之外。
  若要換名單，請直接替換本機的 `name.txt` 再重跑轉檔腳本。
- `clearSessionMarks()` 可清掉所有場次去重紀錄（要重複使用同一個 session 名稱時執行）。

## 本地測試

```bash
python3 -m http.server 8000
# 學生端 http://localhost:8000/?mode=classBonus
# 教師端 http://localhost:8000/qr.html
```

後端可在 Apps Script 編輯器執行 `testAllModes()`，會用測試學號 `TEST0001` 各送一筆。
