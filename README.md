# 離線 QR 掃碼（iPhone / Safari 加入主畫面）

掃描 QR code 後，會顯示裡面的文字，可一鍵複製；網址會多一個「開啟連結」按鈕。
也可以從相簿選一張含 QR code 的圖片來解析。歷史紀錄只存在你的手機。

## 檔案說明
- index.html：畫面
- app.js：掃碼邏輯
- sw.js：離線快取（Service Worker）
- manifest.json、icon-*.png：加入主畫面用的名稱和圖示
- jsQR.js：解碼函式庫（見下方，可選）

## 一、放到網路上（只要做一次）
相機功能要求 HTTPS，直接用手機開本機的 html 檔不能用。
把整個資料夾的檔案上傳到任何 HTTPS 靜態空間即可，例如 GitHub Pages：

1. 在 GitHub 建一個新的 repository，把這些檔案全部上傳（檔案要在最外層，不要多包一層資料夾）。
2. 到 Settings → Pages，Source 選 Deploy from a branch，Branch 選 main、資料夾選 / (root)，儲存。
3. 等一兩分鐘，會得到類似 https://你的帳號.github.io/repo名稱/ 的網址。

Cloudflare Pages、Netlify 也可以，把資料夾上傳進去就行。

## 二、在 iPhone 安裝
1. 用 Safari 開那個網址，保持連網。
2. 等畫面右上角出現「✓ 已可離線使用」。
3. 點分享按鈕 → 加入主畫面。
4. 從主畫面的圖示開啟一次，允許相機權限。
5. 開飛航模式測試，應該仍然能掃碼。

## 三、關於 jsQR.js
解碼函式庫 jsQR.js 已經放在這個資料夾裡，上傳時要一起上傳，不需要再靠 CDN。
（萬一漏傳，程式會自動改從 CDN 下載並快取，但第一次必須連網。）

## 四、之後更新檔案
改了任何檔案後，把 sw.js 第一行的版本號加一（例如 qr-scan-v1 改成 qr-scan-v2），
手機才會抓到新版。

## 常見問題
- 相機黑畫面或被拒絕：到 設定 → Safari → 相機，改成「詢問」或「允許」。
- 還是不行：把主畫面的圖示刪掉，用 Safari 重新開網址，再加入主畫面一次。
- 需要 iOS 13.4 以上。
